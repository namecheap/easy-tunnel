const http = require('http');
const Debug = require('debug');
const { randomUUID } = require('crypto');

// Create an HTTP server
const server = http.createServer(
  { connectionsCheckingInterval: 1000, keepAlive: false, requestTimeout: 10_000, headersTimeout: 10_000 },
  (req, res) => {
    res.end('Hello, world!\n');
  }
);

// Event listener for when a client connects to the server
let connections = 0;
server.on('connection', socket => {
  const socketId = randomUUID().slice(0, 7);
  const debug = Debug(`mytunnel:TestBackend:${socketId}`);
  debug(`A new connection was made by a client, total`, ++connections);
  socket.on('data', data => debug('client data', data));
  socket.on('error', err => debug('client error', err));
  socket.on('close', err => {
    debug('client close (%s) [total: %s]', err, --connections);
  });
  socket.on('end', () => debug('client end'));
  socket.on('timeout', () => debug('client timeout'));

  // Simulate broken server
  if (connections === 5) {
    setTimeout(() => socket.resetAndDestroy(), 5000);
  }
  if (connections === 6) {
    setTimeout(() => socket.destroy(), 6000);
  }
  if (connections === 7) {
    setTimeout(() => socket.destroySoon(), 7000);
  }
  if (connections === 8) {
    setTimeout(() => socket.end(), 8000);
  }
});
const debug = Debug('mytunnel:TestBackend');
server.on('error', err => debug('server error', err));
server.on('close', err => debug('server close', err));
server.on('', err => debug('server close', err));

// Define the port to listen on
const port = 3001;

// The server starts listening on the specified port
server.listen(port, () => {
  console.info(`Server is listening on port ${port}`);
});
