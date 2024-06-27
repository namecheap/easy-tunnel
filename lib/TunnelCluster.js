const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const Debug = require('debug');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const pump = require('pump');

const HeaderHostTransformer = require('./HeaderHostTransformer');

const getSocketId = () => randomUUID().slice(0, 7);

// manages groups of tunnels
module.exports = class TunnelCluster extends EventEmitter {
  constructor(opts = {}) {
    super(opts);
    this.opts = opts;
    this.localReconnectionRetryCount = 0;
  }

  open({ idleMonitoring = false } = {}) {
    const opt = this.opts;
    const self = this;
    const id = getSocketId();
    const debug = Debug(`mytunnel:TunnelCluster:${id}`);

    // Prefer IP if returned by the server
    const remoteHostOrIp = opt.remote_ip || opt.remote_host;
    const remotePort = opt.remote_port;
    const localHost = opt.local_host || 'localhost';
    const localPort = opt.local_port;
    const localProtocol = opt.local_https ? 'https' : 'http';
    const allowInvalidCert = opt.allow_invalid_cert;
    const isTunnelSecure = opt.is_tunnel_secure;
    const localReconnectionMaxRetryCount = opt.local_max_retries !== undefined ? opt.local_max_retries : Infinity;
    const localReconnectionDelay = opt.local_reconnect_delay !== undefined ? opt.local_reconnect_delay : 1000;

    debug(
      'establishing tunnel %s://%s:%s <> %s:%s [secure:%s]',
      localProtocol,
      localHost,
      localPort,
      remoteHostOrIp,
      remotePort,
      isTunnelSecure
    );

    const connectionOptions = {
      host: remoteHostOrIp,
      port: remotePort,
      timeout: opt.connect_timeout,
    };

    // connection to localtunnel server
    const remote = isTunnelSecure
      ? tls.connect({ ...connectionOptions, servername: remoteHostOrIp })
      : net.connect(connectionOptions);

    remote.setKeepAlive(true);

    remote.on('error', err => {
      debug('got remote connection error', err.message);

      // emit connection refused errors immediately, because they
      // indicate that the tunnel can't be established.
      if (['ECONNREFUSED', 'ETIMEDOUT'].includes(err.code)) {
        this.emit(
          'error',
          new Error(`connection refused: ${remoteHostOrIp}:${remotePort} (check your firewall settings)`)
        );
      }
    });

    // idle connection detection
    if (idleMonitoring) {
      remote.once('timeout', () => {
        debug('remote timeout');
        remote.end();
      });
    }

    const connLocal = () => {
      if (remote.destroyed) {
        debug('remote destroyed');
        return;
      }

      debug('connecting locally to %s://%s:%d', localProtocol, localHost, localPort);
      remote.pause();

      if (allowInvalidCert) {
        debug('allowing invalid certificates');
      }

      const getLocalCertOpts = () =>
        allowInvalidCert
          ? { rejectUnauthorized: false }
          : {
              cert: fs.readFileSync(opt.local_cert),
              key: fs.readFileSync(opt.local_key),
              ca: opt.local_ca ? [fs.readFileSync(opt.local_ca)] : undefined,
            };

      // connection to local http server
      const local = opt.local_https
        ? tls.connect({ host: localHost, port: localPort, ...getLocalCertOpts() })
        : net.connect({ host: localHost, port: localPort });

      local.once('error', err => {
        debug('local error %O', err);
        local.end();
        if (self.localReconnectionRetryCount < localReconnectionMaxRetryCount) {
          self.localReconnectionRetryCount += 1;
          debug(
            `Local server connection is lost, reconnecting. Attempt ${self.localReconnectionRetryCount}/${localReconnectionMaxRetryCount}`
          );

          // retrying connection to local server
          setTimeout(connLocal, localReconnectionDelay);
        } else {
          this.emit('error', new Error('Local server unreachable'));
        }
      });

      local.once('connect', () => {
        debug('connected locally');
        remote.resume();

        self.localReconnectionRetryCount = 0;

        let stream = remote;

        // if user requested specific local host
        // then we use host header transform to replace the host header
        if (opt.local_host) {
          debug('transform Host header to %s', opt.local_host);
          stream = remote.pipe(new HeaderHostTransformer({ host: opt.local_host }));
        }

        pump(stream, local, remote, err => {
          debug('stream finished', err);
          this.emit('dead', { idleMonitoring });
        });

        // when local closes, also get a new remote
        local.once('close', hadError => {
          debug('local connection closed [%s]', hadError);
        });
      });
    };

    remote.on('data', data => {
      const match = data.toString().match(/^(\w+) (\S+)/);
      if (match) {
        this.emit('request', {
          method: match[1],
          path: match[2],
        });
      }
    });

    // tunnel is considered open when remote connects
    remote.once('connect', () => {
      remote.setTimeout(opt.idle_timeout);
      this.emit('open', remote);
      connLocal();
    });
  }
};
