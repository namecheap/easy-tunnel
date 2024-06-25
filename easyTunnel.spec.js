const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const { setTimeout } = require('timers/promises');
const url = require('url');
const supertest = require('supertest');
const chai = require('chai');
chai.use(require('chai-string'));
const expect = chai.expect;
const assert = require('assert');
const nock = require('nock');

const easyTunnel = require('./easyTunnel');

const tunnelPort = 4200;
const fakeHost = 'https://local.tunnel';

let fakePort;
let testServer;

describe('localtunnel', () => {
  before(done => {
    testServer = http.createServer();
    testServer.on('request', (req, res) => {
      res.write(req.headers.host);
      res.end();
    });
    testServer.listen(() => {
      const { port } = testServer.address();
      fakePort = port;
      done();
    });
  });

  beforeEach(() => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = 1;
  });

  after(() => {
    testServer.close();
    nock.restore();
  });

  it('query easyTunnel server w/ ident', async () => {
    const tunnel = await easyTunnel({ port: fakePort, host: 'http://lvh.me:8087' });

    try {
      await supertest(tunnel.url)
        .get('/')
        .expect(200)
        .expect(res => {
          expect(tunnel.url).to.endsWith(res.text);
        });
    } finally {
      tunnel.close();
    }
  });

  it('request specific domain', async () => {
    const subdomain = Math.random().toString(36).substr(2);
    const tunnel = await easyTunnel({ port: fakePort, subdomain, host: 'http://lvh.me:8087' });
    tunnel.close();

    expect(tunnel.url).to.startsWith(`http://${subdomain}.`);
  });

  describe('--local-host localhost', () => {
    it('override Host header with local-host', async () => {
      const tunnel = await easyTunnel({ port: fakePort, local_host: 'localhost', host: 'http://lvh.me:8087' });

      try {
        await supertest(tunnel.url)
          .get('/')
          .expect(200)
          .expect(res => {
            expect(res.text).to.equal('localhost');
          });
      } finally {
        tunnel.close();
      }
    });
  });

  describe('--local-host 127.0.0.1', () => {
    it('override Host header with local-host', async () => {
      const tunnel = await easyTunnel({ port: fakePort, local_host: '127.0.0.1', host: 'http://lvh.me:8087' });

      try {
        await supertest(tunnel.url)
          .get('/')
          .expect(200)
          .expect(res => {
            expect(res.text).to.equal('127.0.0.1');
          });
      } finally {
        tunnel.close();
      }
    });

    it('send chunked request', async () => {
      const tunnel = await easyTunnel({ port: fakePort, local_host: '127.0.0.1', host: 'http://lvh.me:8087' });

      const parsed = url.parse(tunnel.url);
      const opt = {
        host: parsed.host,
        port: 8087,
        headers: {
          host: parsed.hostname,
          'Transfer-Encoding': 'chunked',
        },
        path: '/',
      };

      await new Promise((resolve, reject) => {
        const req = http.request(opt, res => {
          res.setEncoding('utf8');
          let body = '';

          res.on('data', chunk => {
            body += chunk;
          });

          res.on('end', () => {
            try {
              assert.strictEqual(body, '127.0.0.1');
            } catch (e) {
              reject(e);
            } finally {
              tunnel.close();
            }
            resolve();
          });
        });

        req.end(crypto.randomBytes(1024 * 8).toString('base64'));
      });
    });
  });

  it('should open n sockets', async () => {
    const maxSockets = 8;
    nock(fakeHost).get('/?new').reply(200, {
      id: 'test',
      port: tunnelPort,
      max_conn_count: maxSockets,
      is_tunnel_secure: false,
      ip: '127.0.0.1',
      url: 'https://test.localhost',
    });

    const remoteSocket = net.createServer();
    remoteSocket.listen(tunnelPort);
    let connectedSockets = 0;
    remoteSocket.on('connection', () => (connectedSockets += 1));
    const tunnel = await easyTunnel({ port: fakePort, host: fakeHost });
    await setTimeout(1000);
    expect(connectedSockets).equals(maxSockets);
    tunnel.close();
    remoteSocket.close();
  });

  it('should connect to tls tunnel', async () => {
    const maxSockets = 8;
    nock(fakeHost).get('/?new').reply(200, {
      id: 'test',
      port: tunnelPort,
      max_conn_count: maxSockets,
      is_tunnel_secure: true,
      ip: '127.0.0.1',
      url: 'https://localhost',
    });

    const remoteSocket = tls.createServer({
      cert: fs.readFileSync('./fixtures/tls/server-crt.pem'),
      key: fs.readFileSync('./fixtures/tls/server-key.pem'),
    });
    remoteSocket.listen(tunnelPort);
    let connectedSockets = 0;
    remoteSocket.on('secureConnection', () => (connectedSockets += 1));
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
    const tunnel = await easyTunnel({ port: fakePort, host: fakeHost });
    await setTimeout(1000);
    expect(connectedSockets).equals(maxSockets);
    tunnel.close();
    remoteSocket.close();
  });

  it('should connect to local tls server', async () => {
    const testTlsServer = https.createServer({
      cert: fs.readFileSync('./fixtures/tls/server-crt.pem'),
      key: fs.readFileSync('./fixtures/tls/server-key.pem'),
    });
    testTlsServer.on('request', (req, res) => {
      res.write('TLS');
      res.end();
    });
    await new Promise((resolve, reject) => testTlsServer.listen(err => (err ? reject(err) : resolve())));
    const { port } = testTlsServer.address();
    const tunnel = await easyTunnel({ port, host: 'http://lvh.me:8087', local_https: true, allow_invalid_cert: true });
    try {
      await supertest(tunnel.url)
        .get('/')
        .expect(200)
        .expect(res => {
          expect(res.text).to.equal('TLS');
        });
    } finally {
      tunnel.close();
    }
  });

  it('should connect to local tls server (with client cert)', async () => {
    const cert = fs.readFileSync('./fixtures/tls/server-crt.pem');
    const key = fs.readFileSync('./fixtures/tls/server-key.pem');
    const testTlsServer = https.createServer({ cert, key });
    testTlsServer.on('request', (req, res) => {
      res.write('TLS');
      res.end();
    });
    await new Promise((resolve, reject) => testTlsServer.listen(err => (err ? reject(err) : resolve())));
    const { port } = testTlsServer.address();
    const tunnel = await easyTunnel({
      port,
      host: 'http://lvh.me:8087',
      local_https: true,
      local_cert: './fixtures/tls/client-crt.pem',
      local_key: './fixtures/tls/client-key.pem',
      local_ca: './fixtures/tls/ca-crt.pem',
    });
    try {
      await supertest(tunnel.url)
        .get('/')
        .expect(200)
        .expect(res => {
          expect(res.text).to.equal('TLS');
        });
    } finally {
      tunnel.close();
    }
  });

  it('should request secure channel with flag', async () => {
    const maxSockets = 1;
    nock(fakeHost).get('/?new&secureTunnel').reply(200, {
      id: 'test',
      port: tunnelPort,
      max_conn_count: maxSockets,
      is_tunnel_secure: false,
      ip: '127.0.0.1',
      url: 'https://test.localhost',
    });
    const remoteSocket = net.createServer();
    remoteSocket.listen(tunnelPort);
    let connectedSockets = 0;
    remoteSocket.on('connection', () => (connectedSockets += 1));
    const tunnel = await easyTunnel({
      port: fakePort,
      host: fakeHost,
      request_secure_tunnel: true,
    });
    await setTimeout(1000);
    assert.equal(connectedSockets, maxSockets);
    tunnel.close();
    remoteSocket.close();
  });

  it('handle --connect-timeout on initial request', async () => {
    const tunnel = easyTunnel({ port: fakePort, host: 'http://8.8.8.8', connect_timeout: 2000 });
    await assert.rejects(tunnel, { message: 'timeout of 2000ms exceeded' });
  });

  it('handle --connect-timeout on socket connect', async () => {
    const maxSockets = 1;
    nock(fakeHost).get('/?new').reply(200, {
      id: 'test',
      port: tunnelPort,
      max_conn_count: maxSockets,
      is_tunnel_secure: false,
      url: 'https://test.localhost',
    });

    const tunnel = easyTunnel({ port: fakePort, host: fakeHost, connect_timeout: 2000 });
    await assert.rejects(tunnel, { message: 'Tunnel timed out' });
  });

  it('should reconnect on local socket close', done => {
    const remoteSocket = net.createServer();
    remoteSocket.listen(() => {
      const { port: remoteSocketPort } = remoteSocket.address();
      nock(fakeHost).get('/?new').reply(200, {
        id: 'test',
        port: remoteSocketPort,
        max_conn_count: 1,
        is_tunnel_secure: false,
        ip: '127.0.0.1',
        url: 'https://test.localhost',
      });

      let localSocket;
      testServer.on('connection', socket => {
        localSocket = socket;
      });

      let tunnel;
      remoteSocket.once('connection', async socket => {
        socket.resume();
        remoteSocket.once('connection', () => {
          tunnel.close();
          done();
        });
        await setTimeout(1000);
        localSocket.end('bye\n');
      });

      easyTunnel({
        port: fakePort,
        host: fakeHost,
      })
        .then(_tunnel => (tunnel = _tunnel))
        .catch(done);
    });
  });

  it('should reconnect on local socket destroy', done => {
    const remoteSocket = net.createServer();
    remoteSocket.listen(() => {
      const { port: remoteSocketPort } = remoteSocket.address();
      nock(fakeHost).get('/?new').reply(200, {
        id: 'test',
        port: remoteSocketPort,
        max_conn_count: 1,
        is_tunnel_secure: false,
        ip: '127.0.0.1',
        url: 'https://test.localhost',
      });

      let localSocket;
      testServer.on('connection', socket => {
        localSocket = socket;
      });

      let tunnel;
      remoteSocket.once('connection', async socket => {
        socket.resume();
        remoteSocket.once('connection', () => {
          tunnel.close();
          done();
        });
        await setTimeout(1000);
        localSocket.destroy();
      });

      easyTunnel({
        port: fakePort,
        host: fakeHost,
        connect_timeout: 1000,
      })
        .then(_tunnel => (tunnel = _tunnel))
        .catch(done);
    });
  });

  it('should reconnect on local socket reset', done => {
    const remoteSocket = net.createServer();
    remoteSocket.listen(() => {
      const { port: remoteSocketPort } = remoteSocket.address();
      nock(fakeHost).get('/?new').reply(200, {
        id: 'test',
        port: remoteSocketPort,
        max_conn_count: 1,
        is_tunnel_secure: false,
        ip: '127.0.0.1',
        url: 'https://test.localhost',
      });

      let localSocket;
      testServer.on('connection', socket => {
        localSocket = socket;
      });

      let tunnel;
      remoteSocket.once('connection', async socket => {
        socket.resume();
        remoteSocket.once('connection', () => {
          tunnel.close();
          done();
        });
        await setTimeout(1000);
        localSocket.resetAndDestroy();
      });

      easyTunnel({
        port: fakePort,
        host: fakeHost,
      })
        .then(_tunnel => (tunnel = _tunnel))
        .catch(done);
    });
  });

  it('should reconnect on local socket reset', done => {
    const remoteSocket = net.createServer();
    remoteSocket.listen(() => {
      const { port: remoteSocketPort } = remoteSocket.address();
      nock(fakeHost).get('/?new').reply(200, {
        id: 'test',
        port: remoteSocketPort,
        max_conn_count: 1,
        is_tunnel_secure: false,
        ip: '127.0.0.1',
        url: 'https://test.localhost',
      });

      let tunnel;
      remoteSocket.once('connection', async socket => {
        remoteSocket.once('connection', () => {
          tunnel.close();
          done();
        });
        await setTimeout(1000);
        socket.resetAndDestroy();
      });

      easyTunnel({
        port: fakePort,
        host: fakeHost,
      })
        .then(_tunnel => (tunnel = _tunnel))
        .catch(done);
    });
  });

  it('should throw on ECONNREFUSED', done => {
    const remoteSocket = net.createServer();
    remoteSocket.listen(() => {
      const { port: remoteSocketPort } = remoteSocket.address();
      nock(fakeHost).get('/?new').reply(200, {
        id: 'test',
        port: remoteSocketPort,
        max_conn_count: 1,
        is_tunnel_secure: false,
        ip: '127.0.0.1',
        url: 'https://test.localhost',
      });

      let tunnel;
      remoteSocket.once('connection', async socket => {
        await setTimeout(1000);
        tunnel.once('error', error => {
          expect(error.message).to.match(/connection refused:/);
          done();
        });
        remoteSocket.close();
        socket.destroy();
      });

      easyTunnel({
        port: fakePort,
        host: fakeHost,
      })
        .then(_tunnel => (tunnel = _tunnel))
        .catch(done);
    });
  });

  it('handle --idle-timeout', done => {
    const remoteSocket = net.createServer();
    remoteSocket.listen(() => {
      const { port: remoteSocketPort } = remoteSocket.address();
      nock(fakeHost).get('/?new').reply(200, {
        id: 'test',
        port: remoteSocketPort,
        max_conn_count: 5,
        is_tunnel_secure: false,
        ip: '127.0.0.1',
        url: 'https://test.localhost',
      });

      let tunnel, listenerSet;
      remoteSocket.on('connection', async socket => {
        socket.resume();
        await setTimeout(1000);
        if (!listenerSet) {
          tunnel.once('error', error => {
            expect(error.message).match(/connection refused/);
            tunnel.close();
            done();
          });
          listenerSet = true;
        }
        remoteSocket.close();
      });

      easyTunnel({
        port: fakePort,
        host: fakeHost,
        idle_timeout: 2000,
      })
        .then(_tunnel => (tunnel = _tunnel))
        .catch(done);
    });
  });
});
