/* eslint-disable consistent-return, no-underscore-dangle */

const { parse } = require('url');
const { EventEmitter } = require('events');
const axios = require('axios');
const debug = require('debug')('mytunnel:Tunnel');

const TunnelCluster = require('./TunnelCluster');

module.exports = class Tunnel extends EventEmitter {
  constructor(opts = {}) {
    super(opts);
    this.opts = opts;
    this.closed = false;
    if (!this.opts.host) {
      this.opts.host = 'http://localhost:8087';
    }
    this.opts.connect_timeout = this.opts.connect_timeout ?? 10_000;
    this.destroyTimer = null;
  }

  _getInfo(body) {
    /* eslint-disable camelcase */
    const { id, ip, port, url, cached_url, max_conn_count, is_tunnel_secure } = body;
    const {
      host,
      port: local_port,
      local_host,
      local_https,
      local_cert,
      local_key,
      local_ca,
      allow_invalid_cert,
      local_max_retries,
      local_reconnect_delay,
      connect_timeout,
      idle_timeout,
    } = this.opts;

    return {
      name: id,
      url,
      cached_url,
      max_conn: max_conn_count || 1,
      remote_host: parse(host).hostname,
      remote_ip: ip,
      remote_port: port,
      local_port,
      local_host,
      local_https,
      local_cert,
      local_key,
      local_ca,
      allow_invalid_cert,
      is_tunnel_secure,
      local_max_retries,
      local_reconnect_delay,
      connect_timeout: connect_timeout,
      idle_timeout: idle_timeout ?? 15_000,
    };
    /* eslint-enable camelcase */
  }

  // initialize connection
  // callback with connection info
  _init(cb) {
    const opt = this.opts;
    const getInfo = this._getInfo.bind(this);

    const params = {
      responseType: 'json',
      timeout: opt.connect_timeout,
    };

    const baseUri = `${opt.host}/`;
    // no subdomain at first, maybe use requested domain
    const assignedDomain = opt.subdomain;
    // where to quest
    let uri = baseUri + (assignedDomain || '?new');
    if (opt.request_secure_tunnel) {
      uri += assignedDomain ? '?' : '&';
      uri += 'secureTunnel';
    }

    (function getUrl() {
      axios
        .get(uri, params)
        .then(res => {
          const body = res.data;
          debug('got tunnel information', res.data);
          if (res.status !== 200) {
            const err = new Error((body && body.message) || 'localtunnel server returned an error, please try again');
            return cb(err);
          }
          cb(null, getInfo(body));
        })
        .catch(err => {
          return cb(err);
        });
    })();
  }

  _establish(info, cb) {
    // increase max event listeners so that localtunnel consumers don't get
    // warning messages as soon as they setup even one listener. See #71
    this.setMaxListeners(info.max_conn + (EventEmitter.defaultMaxListeners || 10));

    this.tunnelCluster = new TunnelCluster(info);

    // only emit the url the first time
    this.tunnelCluster.once('open', () => {
      this.emit('url', info.url);
    });

    // re-emit socket error
    this.tunnelCluster.on('error', err => {
      debug('got socket error', err.message);
      this.emit('error', err);
    });

    let tunnelCount = 0;

    let atLeastOneSocketOpen = false;
    // track open count
    this.tunnelCluster.on('open', tunnel => {
      tunnelCount++;
      debug('tunnel open [total: %d]', tunnelCount);
      this.cancelDestroy();

      const closeHandler = () => {
        tunnel.destroy();
        if (!atLeastOneSocketOpen) {
          cb(new Error('Socket close requested earlier than it was opened'));
        }
      };

      if (this.closed) {
        return closeHandler();
      }

      if (!atLeastOneSocketOpen) {
        // wait for at least one socket to be opened,
        // since other processes might lock event loop
        // which might cause socket close on the tunnel server due to timeout
        atLeastOneSocketOpen = true;
        cb();
      }
      this.once('close', closeHandler);
      tunnel.once('close', () => {
        debug('tunnel close');
        this.removeListener('close', closeHandler);
      });
    });

    // when a tunnel dies, open a new one
    this.tunnelCluster.on('dead', tunnelOptions => {
      if (tunnelCount > 0) {
        tunnelCount -= 1;
        this.scheduleDestroy(info.connect_timeout);
      } else {
        debug('Emitted dead tunnels more than it should');
      }

      debug('tunnel dead [total: %d]', tunnelCount);
      if (this.closed) {
        return;
      }
      setTimeout(() => this.tunnelCluster.open(tunnelOptions), 1000);
    });

    this.tunnelCluster.on('request', req => {
      this.emit('request', req);
    });

    // establish as many tunnels as allowed
    for (let count = 0; count < info.max_conn; ++count) {
      const idleMonitoring = count === 0;
      this.tunnelCluster.open({ idleMonitoring });
    }

    this.scheduleDestroy(info.connect_timeout);

    this.on('error', error => {
      if (!atLeastOneSocketOpen) {
        cb(error);
      }
    });
  }

  open(cb) {
    this._init((err, info) => {
      if (err) {
        return cb(err);
      }

      this.clientId = info.name;
      this.url = info.url;

      // `cached_url` is only returned by proxy servers that support resource caching.
      if (info.cached_url) {
        this.cachedUrl = info.cached_url;
      }

      this._establish(info, cb);
    });
  }

  close() {
    this.closed = true;
    this.emit('close');
  }

  scheduleDestroy(ms) {
    if (!this.destroyTimer) {
      this.destroyTimer = setTimeout(() => this.destroy(), ms);
    }
  }

  cancelDestroy() {
    if (this.destroyTimer !== null) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }
  }

  destroy() {
    this.emit('error', new Error('Tunnel timed out'));
    this.close();
  }
};
