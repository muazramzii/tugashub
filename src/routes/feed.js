// Notifications and the workspace activity log.
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

const PAGE_SIZE = 40;
const q = {
  notifications: db.prepare(`
    SELECT n.*, u.name AS actor_name FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
    WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 60`),
  notification: db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?'),
  markRead: db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL"),
  markAllRead: db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL"),
  projects: db.prepare('SELECT id, name FROM projects WHERE workspace_id = ? ORDER BY name COLLATE NOCASE'),
};

router.get('/notifications', (req, res) => {
  res.render('notifications', { title: 'Notifications', notifications: q.notifications.all(req.user.id) });
});

// Opening a notification marks it read and jumps to its task.
router.get('/notifications/:id', (req, res) => {
  const n = q.notification.get(Number(req.params.id), req.user.id);
  if (!n) return res.redirect('/notifications');
  q.markRead.run(n.id);
  res.redirect(n.task_id ? `/tasks/${n.task_id}` : '/notifications');
});

router.post('/notifications/read-all', (req, res) => {
  q.markAllRead.run(req.user.id);
  res.redirect('/notifications');
});

router.get('/activity', (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const project = /^\d+$/.test(req.query.project || '') ? Number(req.query.project) : null;
  const where = project ? 'a.workspace_id = ? AND a.project_id = ?' : 'a.workspace_id = ?';
  const params = project ? [req.workspace.id, project] : [req.workspace.id];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM activity a WHERE ${where}`).get(...params).n;
  const items = db.prepare(`
    SELECT a.*, u.name AS user_name, p.name AS project_name FROM activity a
    LEFT JOIN users u ON u.id = a.user_id LEFT JOIN projects p ON p.id = a.project_id
    WHERE ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  res.render('activity', {
    title: 'Activity',
    items,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    project,
    projects: q.projects.all(req.workspace.id),
  });
});

module.exports = { router };
