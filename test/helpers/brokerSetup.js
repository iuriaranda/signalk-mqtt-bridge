const aedes = require('aedes');
const net = require('net');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startBroker() {
  const port = await getFreePort();
  const broker = aedes();
  const server = net.createServer((conn) => broker.handle(conn));
  await new Promise((resolve, reject) =>
    server.listen(port, (err) => err ? reject(err) : resolve())
  );
  return {
    broker,
    server,
    port,
    url: `mqtt://localhost:${port}`,
    stop: () => new Promise(resolve => broker.close(() => server.close(resolve))),
  };
}

module.exports = { startBroker };
