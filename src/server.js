const http = require('http');
const { db } = require('./db');

// On a fresh deploy, SEED_DEMO=1 fills the empty database with the demo team
// so the live site has something to show. It never touches existing data.
if (process.env.SEED_DEMO === '1' && !db.prepare('SELECT 1 FROM workspaces LIMIT 1').get()) {
  require('./seed');
}

const app = require('./app');
const { attachRealtime } = require('./realtime');

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer(app);
attachRealtime(server, app.sessionMiddleware);

server.listen(PORT, () => {
  console.log(`TugasHub running at http://localhost:${PORT}`);
});

// Hosts stop the app with SIGTERM on every redeploy. Close the database cleanly
// so the WAL file is checkpointed into app.db on the volume.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
