const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');

require('./db'); // create / migrate tables on first load
const { loadUser, flash, csrf } = require('./middleware');
const { PLANS, formatLimit } = require('./plans');
const { ROLE_LABELS } = require('./permissions');
const { icon } = require('./icons');

// Keep the session secret stable across restarts so people stay logged in.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(__dirname, '..', 'data', 'secret.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'));
  return fs.readFileSync(file, 'utf8').trim();
}

/** Parse SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or 'YYYY-MM-DD' (local) strings. */
function parseDate(s) {
  return new Date(s.length === 10 ? `${s}T00:00:00` : `${s.replace(' ', 'T')}Z`);
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

Object.assign(app.locals, {
  appName: 'TugasHub',
  icon,
  // Defaults so error pages render even if a request fails before loadUser runs.
  user: null,
  flash: null,
  csrf: '',
  path: '',
  query: {},
  chatUnread: 0,
  PLANS,
  ROLE_LABELS,
  formatLimit,
  // Display names. (Not called "labels": views use that for task labels.)
  text: {
    status: { todo: 'To do', doing: 'In progress', done: 'Done' },
    priority: { low: 'Low', medium: 'Medium', high: 'High' },
  },
  fmtDate(s, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
    return s ? parseDate(s).toLocaleDateString('en-MY', opts) : '';
  },
  timeAgo(s) {
    const secs = Math.round((Date.now() - parseDate(s).getTime()) / 1000);
    if (secs < 60) return 'just now';
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [unit, size] of units) {
      const n = Math.floor(secs / size);
      if (n >= 1) return `${n} ${unit}${n > 1 ? 's' : ''} ago`;
    }
    return 'just now';
  },
  initials: (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join(''),
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
// Shared with the Socket.IO server so sockets know who is connected.
const sessionMiddleware = cookieSession({
  name: 'tugashub.sid',
  keys: [sessionSecret()],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
});
app.sessionMiddleware = sessionMiddleware;
app.use(sessionMiddleware);
app.use(flash);
app.use(loadUser);
app.use(csrf);

app.get('/', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('landing', { title: 'Task management for small teams' });
});

app.use(require('./routes/auth').router);
app.use(require('./routes/feed').router);
app.use(require('./routes/chat').router);
app.use(require('./routes/views').router); // before tasks: owns /tasks and /tasks/export.csv
app.use(require('./routes/projects').router);
app.use(require('./routes/tasks').router);
app.use(require('./routes/workspace').router);

app.use((req, res) => {
  res.status(404).render('error', { title: 'Page not found', message: 'We could not find that page.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

module.exports = app;
