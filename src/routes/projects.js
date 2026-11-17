const express = require('express');
const { db } = require('../db');
const { planFor } = require('../plans');
const { requireAuth, requireRole, setFlash } = require('../middleware');
const { logActivity, quote } = require('../services/activity');
const { projectTasks, workspaceLabels, parseFilters, filterQuery } = require('../services/tasks');

const router = express.Router();
router.use(requireAuth);

const COLORS = ['#1f6f50', '#2457a6', '#b54708', '#9e2a5e', '#5b4bb7', '#3d6b7a'];

const q = {
  projectsWithCounts: db.prepare(`
    SELECT p.*, COUNT(t.id) AS total,
           COALESCE(SUM(t.status = 'done'), 0) AS done,
           COALESCE(SUM(t.status != 'done' AND t.due_date < date('now', 'localtime')), 0) AS overdue
    FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
    WHERE p.workspace_id = ? AND p.archived_at IS NULL
    GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC`),
  archived: db.prepare('SELECT * FROM projects WHERE workspace_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC'),
  stats: db.prepare(`
    SELECT COUNT(t.id) AS total,
           COALESCE(SUM(t.status = 'done'), 0) AS done,
           COALESCE(SUM(t.status = 'doing'), 0) AS doing,
           COALESCE(SUM(t.status != 'done' AND t.due_date < date('now', 'localtime')), 0) AS overdue,
           COALESCE(SUM(t.status != 'done' AND t.due_date BETWEEN date('now', 'localtime') AND date('now', 'localtime', '+7 days')), 0) AS due_week,
           COALESCE(SUM(t.completed_at >= datetime('now', '-7 days')), 0) AS done_week
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.workspace_id = ? AND p.archived_at IS NULL`),
  myTasks: db.prepare(`
    SELECT t.*, p.name AS project_name, p.color AS project_color,
           (t.due_date < date('now', 'localtime')) AS is_overdue
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.assignee_id = ? AND t.status != 'done' AND p.workspace_id = ? AND p.archived_at IS NULL
    ORDER BY t.due_date IS NULL, t.due_date, t.id LIMIT 8`),
  recentActivity: db.prepare(`
    SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.workspace_id = ? ORDER BY a.id DESC LIMIT 8`),
  activeCount: db.prepare('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND archived_at IS NULL'),
  memberCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE workspace_id = ?'),
  insertProject: db.prepare('INSERT INTO projects (workspace_id, name, description, color) VALUES (?, ?, ?, ?)'),
  project: db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?'),
  updateProject: db.prepare('UPDATE projects SET name = ?, description = ?, color = ? WHERE id = ?'),
  setArchived: db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?'),
  deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
  members: db.prepare('SELECT id, name FROM users WHERE workspace_id = ? ORDER BY name'),
};

function loadProject(req, res, next) {
  const project = q.project.get(Number(req.params.id), req.workspace.id);
  if (!project) return res.status(404).render('error', { title: 'Not found', message: 'That project does not exist in your workspace.' });
  req.project = project;
  next();
}

function readProjectForm(body) {
  const name = (body.name || '').trim();
  const description = (body.description || '').trim().slice(0, 500);
  const color = COLORS.includes(body.color) ? body.color : COLORS[0];
  if (!name || name.length > 80) return { error: 'Give the project a name (up to 80 characters).' };
  return { values: { name, description, color } };
}

// ---- Dashboard ----
router.get('/dashboard', (req, res) => {
  const ws = req.workspace.id;
  res.render('dashboard', {
    title: 'Dashboard',
    projects: q.projectsWithCounts.all(ws),
    archived: q.archived.all(ws),
    stats: q.stats.get(ws),
    members: q.memberCount.get(ws).n,
    myTasks: q.myTasks.all(req.user.id, ws),
    activity: q.recentActivity.all(ws),
    colors: COLORS,
  });
});

// ---- Projects ----
router.post('/projects', (req, res) => {
  const { values, error } = readProjectForm(req.body);
  const limit = planFor(req.workspace).maxProjects;
  if (error) {
    setFlash(req, 'error', error);
    return res.redirect('/dashboard');
  }
  if (q.activeCount.get(req.workspace.id).n >= limit) {
    setFlash(req, 'error', `The Free plan allows ${limit} active projects. Archive one or upgrade to Pro.`);
    return res.redirect('/billing');
  }
  const id = Number(q.insertProject.run(req.workspace.id, values.name, values.description, values.color).lastInsertRowid);
  logActivity({ workspaceId: req.workspace.id, userId: req.user.id, projectId: id, action: 'project.created', summary: `created project ${quote(values.name)}` });
  res.redirect(`/projects/${id}`);
});

router.get('/projects/:id', loadProject, (req, res) => {
  const filters = parseFilters(req.query);
  delete filters.project;
  delete filters.sort;
  const all = projectTasks(req.project.id);
  const tasks = all.filter((t) => matches(t, filters, req.user.id));
  const columns = { todo: [], doing: [], done: [] };
  for (const t of tasks) columns[t.status].push(t);
  res.render('board', {
    title: req.project.name,
    project: req.project,
    columns,
    total: all.length,
    filters,
    filterQuery,
    filtered: Object.keys(filters).length > 0,
    members: q.members.all(req.workspace.id),
    labels: workspaceLabels(req.workspace.id),
    colors: COLORS,
  });
});

/** Board filters run in memory: a project holds at most a few hundred tasks. */
function matches(t, f, userId) {
  if (f.q) {
    const needle = f.q.toLowerCase();
    if (!t.title.toLowerCase().includes(needle) && !t.description.toLowerCase().includes(needle)) return false;
  }
  if (f.assignee === 'me' && t.assignee_id !== userId) return false;
  if (f.assignee === 'none' && t.assignee_id !== null) return false;
  if (typeof f.assignee === 'number' && t.assignee_id !== f.assignee) return false;
  if (f.label && !t.labels.some((l) => l.id === f.label)) return false;
  if (f.priority && t.priority !== f.priority) return false;
  if (f.status === 'open' && t.status === 'done') return false;
  if (f.status && f.status !== 'open' && t.status !== f.status) return false;
  if (f.due === 'overdue' && !t.is_overdue) return false;
  if (f.due === 'none' && t.due_date) return false;
  if (f.due === 'week') {
    const today = new Date().toISOString().slice(0, 10);
    const week = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    if (!t.due_date || t.due_date < today || t.due_date > week) return false;
  }
  return true;
}

router.post('/projects/:id/edit', loadProject, (req, res) => {
  const { values, error } = readProjectForm(req.body);
  if (error) {
    setFlash(req, 'error', error);
  } else {
    q.updateProject.run(values.name, values.description, values.color, req.project.id);
    setFlash(req, 'success', 'Project updated.');
  }
  res.redirect(`/projects/${req.project.id}`);
});

router.post('/projects/:id/archive', requireRole('admin'), loadProject, (req, res) => {
  q.setArchived.run(new Date().toISOString().slice(0, 19).replace('T', ' '), req.project.id);
  logActivity({ workspaceId: req.workspace.id, userId: req.user.id, projectId: req.project.id, action: 'project.archived', summary: `archived project ${quote(req.project.name)}` });
  setFlash(req, 'success', `Archived "${req.project.name}". You can restore it from the dashboard.`);
  res.redirect('/dashboard');
});

router.post('/projects/:id/restore', requireRole('admin'), loadProject, (req, res) => {
  const limit = planFor(req.workspace).maxProjects;
  if (q.activeCount.get(req.workspace.id).n >= limit) {
    setFlash(req, 'error', `You already have ${limit} active projects on the Free plan. Archive one or upgrade to Pro.`);
    return res.redirect('/dashboard');
  }
  q.setArchived.run(null, req.project.id);
  logActivity({ workspaceId: req.workspace.id, userId: req.user.id, projectId: req.project.id, action: 'project.restored', summary: `restored project ${quote(req.project.name)}` });
  setFlash(req, 'success', `Restored "${req.project.name}".`);
  res.redirect(`/projects/${req.project.id}`);
});

router.post('/projects/:id/delete', requireRole('admin'), loadProject, (req, res) => {
  q.deleteProject.run(req.project.id);
  logActivity({ workspaceId: req.workspace.id, userId: req.user.id, action: 'project.deleted', summary: `deleted project ${quote(req.project.name)}` });
  setFlash(req, 'success', `Deleted "${req.project.name}" and its tasks.`);
  res.redirect('/dashboard');
});

module.exports = { router, COLORS };
