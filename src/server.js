const http = require('http');
const app = require('./app');
const { attachRealtime } = require('./realtime');

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer(app);
attachRealtime(server, app.sessionMiddleware);

server.listen(PORT, () => {
  console.log(`TugasHub running at http://localhost:${PORT}`);
});
