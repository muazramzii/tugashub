const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');

require('./db'); // create tables on first run
const { loadUser, flash, csrf } = require('./middleware');
const { PLANS, formatLimit } = require('./plans');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Keep the session secret stable across restarts so people stay logged in.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(__dirname, '..', 'data', 'secret.txt');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'));
  return fs.readFileSync(file, 'utf8').trim();
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

app.locals.PLANS = PLANS;
app.locals.formatLimit = formatLimit;
app.locals.appName = 'TugasHub';
app.locals.labels = {
  status: { todo: 'To do', doing: 'In progress', done: 'Done' },
  priority: { low: 'Low', medium: 'Medium', high: 'High' },
};
app.locals.fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(s.length === 10 ? s + 'T00:00:00' : s.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' });
};
app.locals.initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieSession({
  name: 'tugashub.sid',
  keys: [sessionSecret()],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
}));
app.use(flash);
app.use(loadUser);
app.use(csrf);

app.get('/', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('landing', { title: 'Task management for small teams' });
});

app.use(require('./routes/auth').router);
app.use(require('./routes/projects').router);
app.use(require('./routes/workspace').router);

app.use((req, res) => {
  res.status(404).render('error', { title: 'Page not found', message: 'We could not find that page.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`TugasHub running at http://localhost:${PORT}`);
});
