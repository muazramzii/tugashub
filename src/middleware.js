const crypto = require('crypto');
const { db } = require('./db');
const { planFor } = require('./plans');

const findUser = db.prepare(`
  SELECT u.id, u.name, u.email, u.role, u.workspace_id,
         w.name AS workspace_name, w.plan, w.invite_code
  FROM users u JOIN workspaces w ON w.id = u.workspace_id
  WHERE u.id = ?
`);

function loadUser(req, res, next) {
  res.locals.user = null;
  res.locals.path = req.path;
  if (req.session.userId) {
    const row = findUser.get(req.session.userId);
    if (row) {
      req.user = row;
      req.workspace = { id: row.workspace_id, name: row.workspace_name, plan: row.plan, invite_code: row.invite_code };
      res.locals.user = row;
      res.locals.workspace = req.workspace;
      res.locals.plan = planFor(req.workspace);
    } else {
      req.session = null; // user was deleted
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') {
    setFlash(req, 'error', 'Only the workspace owner can do that.');
    return res.redirect('back');
  }
  next();
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function flash(req, res, next) {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
}

/** Per-session CSRF token, checked on every non-GET request. */
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (sent && sent.length === req.session.csrf.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrf))) {
    return next();
  }
  res.status(403);
  if (req.is('json')) return res.json({ error: 'Invalid CSRF token' });
  res.render('error', { title: 'Session expired', message: 'Your form expired. Go back, refresh the page and try again.' });
}

module.exports = { loadUser, requireAuth, requireOwner, setFlash, flash, csrf };
