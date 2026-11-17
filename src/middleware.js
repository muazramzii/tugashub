const crypto = require('crypto');
const { db } = require('./db');
const { planFor } = require('./plans');
const { can, atLeast } = require('./permissions');

const findUser = db.prepare(`
  SELECT u.id, u.name, u.email, u.role, u.workspace_id,
         w.name AS workspace_name, w.plan, w.invite_code
  FROM users u JOIN workspaces w ON w.id = u.workspace_id
  WHERE u.id = ?
`);
const unreadCount = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL');
const sidebarProjects = db.prepare(`
  SELECT id, name, color FROM projects
  WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name COLLATE NOCASE`);

function loadUser(req, res, next) {
  res.locals.user = null;
  res.locals.path = req.path;
  res.locals.query = req.query;
  if (req.session.userId) {
    const row = findUser.get(req.session.userId);
    if (row) {
      req.user = row;
      req.workspace = { id: row.workspace_id, name: row.workspace_name, plan: row.plan, invite_code: row.invite_code };
      res.locals.user = row;
      res.locals.workspace = req.workspace;
      res.locals.plan = planFor(req.workspace);
      res.locals.can = can;
      res.locals.atLeast = atLeast;
      res.locals.unread = unreadCount.get(row.id).n;
      res.locals.navProjects = sidebarProjects.all(row.workspace_id);
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

/** Only allow users with at least this role. */
function requireRole(role) {
  return (req, res, next) => {
    if (atLeast(req.user, role)) return next();
    const who = role === 'owner' ? 'the workspace owner' : 'admins and the owner';
    if (req.is('json')) return res.status(403).json({ error: `Only ${who} can do that.` });
    setFlash(req, 'error', `Only ${who} can do that.`);
    res.redirect(req.get('Referer') || '/dashboard');
  };
}

/** Only allow workspaces whose plan includes this feature (e.g. 'reports'). */
function requirePlan(feature) {
  return (req, res, next) => {
    if (planFor(req.workspace)[feature]) return next();
    res.status(402).render('upgrade', { title: 'Pro feature', feature });
  };
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
  if (typeof sent === 'string' && sent.length === req.session.csrf.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrf))) {
    return next();
  }
  res.status(403);
  if (req.is('json')) return res.json({ error: 'Invalid CSRF token' });
  res.render('error', { title: 'Session expired', message: 'Your form expired. Go back, refresh the page and try again.' });
}

module.exports = { loadUser, requireAuth, requireRole, requirePlan, setFlash, flash, csrf };
