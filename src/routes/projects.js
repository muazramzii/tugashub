const express = require('express');
const { db, tx } = require('../db');
const { planFor } = require('../plans');
const { requireAuth, setFlash } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

const STATUSES = ['todo', 'doing', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];
const COLORS = ['#1f6f50', '#2457a6', '#b54708', '#9e2a5e', '#5b4bb7', '#3d6b7a'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const q = {
  projectsWithCounts: db.prepare(`
    SELECT p.*, COUNT(t.id) AS total,
           COALESCE(SUM(t.status = 'done'), 0) AS done
    FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
    WHERE p.workspace_id = ?
    GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC`),
  stats: db.prepare(`
    SELECT COUNT(t.id) AS total,
           COALESCE(SUM(t.status = 'done'), 0) AS done,
           COALESCE(SUM(t.status = 'doing'), 0) AS doing,
           COALESCE(SUM(t.status != 'done' AND t.due_date < date('now', 'localtime')), 0) AS overdue
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.workspace_id = ?`),
  myTasks: db.prepare(`
    SELECT t.*, p.name AS project_name, p.color AS project_color,
           (t.due_date < date('now', 'localtime')) AS is_overdue
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.assignee_id = ? AND t.status != 'done' AND p.workspace_id = ?
    ORDER BY t.due_date IS NULL, t.due_date, t.id LIMIT 8`),
  projectCount: db.prepare('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?'),
  memberCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE workspace_id = ?'),
  insertProject: db.prepare('INSERT INTO projects (workspace_id, name, description, color) VALUES (?, ?, ?, ?)'),
  project: db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?'),
  updateProject: db.prepare('UPDATE projects SET name = ?, description = ? WHERE id = ?'),
  deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
  boardTasks: db.prepare(`
    SELECT t.*, u.name AS assignee_name,
           (t.status != 'done' AND t.due_date < date('now', 'localtime')) AS is_overdue
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.project_id = ? ORDER BY t.position, t.id`),
  members: db.prepare('SELECT id, name FROM users WHERE workspace_id = ? ORDER BY name'),
  member: db.prepare('SELECT id FROM users WHERE id = ? AND workspace_id = ?'),
  nextPosition: db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM tasks WHERE project_id = ? AND status = ?'),
  insertTask: db.prepare(`
    INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, created_by, due_date, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  task: db.prepare(`
    SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.id = ? AND p.workspace_id = ?`),
  updateTask: db.prepare(`
    UPDATE tasks SET title = ?, description = ?, priority = ?, assignee_id = ?, due_date = ? WHERE id = ?`),
  columnIds: db.prepare('SELECT id FROM tasks WHERE project_id = ? AND status = ? AND id != ? ORDER BY position, id'),
  setStatusPos: db.prepare('UPDATE tasks SET status = ?, position = ? WHERE id = ?'),
  setPos: db.prepare('UPDATE tasks SET position = ? WHERE id = ?'),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
};

/** Read and validate the shared task form fields. Returns { values } or { error }. */
function readTaskForm(body, workspaceId) {
  const title = (body.title || '').trim();
  const description = (body.description || '').trim().slice(0, 2000);
  const priority = PRIORITIES.includes(body.priority) ? body.priority : 'medium';
  const due = (body.due_date || '').trim();
  let assignee = body.assignee_id ? Number(body.assignee_id) : null;
  if (!title) return { error: 'A task needs a title.' };
  if (title.length > 200) return { error: 'Keep the title under 200 characters.' };
  if (due && !DATE_RE.test(due)) return { error: 'Due date is not a valid date.' };
  if (assignee && !q.member.get(assignee, workspaceId)) assignee = null;
  return { values: { title, description, priority, assignee, due: due || null } };
}

function loadProject(req, res, next) {
  const project = q.project.get(Number(req.params.id), req.workspace.id);
  if (!project) return res.status(404).render('error', { title: 'Not found', message: 'That project does not exist in your workspace.' });
  req.project = project;
  next();
}

function loadTask(req, res, next) {
  const task = q.task.get(Number(req.params.id), req.workspace.id);
  if (!task) {
    if (req.is('json')) return res.status(404).json({ error: 'Task not found' });
    return res.status(404).render('error', { title: 'Not found', message: 'That task does not exist in your workspace.' });
  }
  req.task = task;
  next();
}

// ---- Dashboard ----
router.get('/dashboard', (req, res) => {
  const ws = req.workspace.id;
  res.render('dashboard', {
    title: 'Dashboard',
    projects: q.projectsWithCounts.all(ws),
    stats: q.stats.get(ws),
    members: q.memberCount.get(ws).n,
    myTasks: q.myTasks.all(req.user.id, ws),
    colors: COLORS,
  });
});

// ---- Projects ----
router.post('/projects', (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim().slice(0, 500);
  const color = COLORS.includes(req.body.color) ? req.body.color : COLORS[0];
  const limit = planFor(req.workspace).maxProjects;

  if (!name || name.length > 80) {
    setFlash(req, 'error', 'Give the project a name (up to 80 characters).');
    return res.redirect('/dashboard');
  }
  if (q.projectCount.get(req.workspace.id).n >= limit) {
    setFlash(req, 'error', `The Free plan allows ${limit} projects. Upgrade to Pro for unlimited projects.`);
    return res.redirect('/billing');
  }
  const id = Number(q.insertProject.run(req.workspace.id, name, description, color).lastInsertRowid);
  res.redirect(`/projects/${id}`);
});

router.get('/projects/:id', loadProject, (req, res) => {
  const tasks = q.boardTasks.all(req.project.id);
  const columns = { todo: [], doing: [], done: [] };
  for (const t of tasks) columns[t.status].push(t);
  res.render('board', {
    title: req.project.name,
    project: req.project,
    columns,
    members: q.members.all(req.workspace.id),
  });
});

router.post('/projects/:id/edit', loadProject, (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim().slice(0, 500);
  if (!name || name.length > 80) {
    setFlash(req, 'error', 'Give the project a name (up to 80 characters).');
  } else {
    q.updateProject.run(name, description, req.project.id);
    setFlash(req, 'success', 'Project updated.');
  }
  res.redirect(`/projects/${req.project.id}`);
});

router.post('/projects/:id/delete', loadProject, (req, res) => {
  if (req.user.role !== 'owner') {
    setFlash(req, 'error', 'Only the workspace owner can delete projects.');
    return res.redirect(`/projects/${req.project.id}`);
  }
  q.deleteProject.run(req.project.id);
  setFlash(req, 'success', `Deleted "${req.project.name}" and its tasks.`);
  res.redirect('/dashboard');
});

// ---- Tasks ----
router.post('/projects/:id/tasks', loadProject, (req, res) => {
  const { values, error } = readTaskForm(req.body, req.workspace.id);
  if (error) {
    setFlash(req, 'error', error);
    return res.redirect(`/projects/${req.project.id}`);
  }
  const status = STATUSES.includes(req.body.status) ? req.body.status : 'todo';
  const pos = q.nextPosition.get(req.project.id, status).pos;
  q.insertTask.run(req.project.id, values.title, values.description, status, values.priority,
    values.assignee, req.user.id, values.due, pos);
  res.redirect(`/projects/${req.project.id}`);
});

router.get('/tasks/:id/edit', loadTask, (req, res) => {
  res.render('task-edit', {
    title: 'Edit task',
    task: req.task,
    project: q.project.get(req.task.project_id, req.workspace.id),
    members: q.members.all(req.workspace.id),
    error: null,
  });
});

router.post('/tasks/:id', loadTask, (req, res) => {
  const { values, error } = readTaskForm(req.body, req.workspace.id);
  if (error) {
    return res.status(400).render('task-edit', {
      title: 'Edit task',
      task: { ...req.task, ...req.body },
      project: q.project.get(req.task.project_id, req.workspace.id),
      members: q.members.all(req.workspace.id),
      error,
    });
  }
  tx(() => {
    q.updateTask.run(values.title, values.description, values.priority, values.assignee, values.due, req.task.id);
    if (STATUSES.includes(req.body.status) && req.body.status !== req.task.status) {
      moveTask(req.task, req.body.status, Infinity);
    }
  });
  setFlash(req, 'success', 'Task saved.');
  res.redirect(`/projects/${req.task.project_id}`);
});

/** Put a task into a column at the given index and renumber that column. */
function moveTask(task, status, index) {
  const ids = q.columnIds.all(task.project_id, status, task.id).map((r) => r.id);
  const at = Math.max(0, Math.min(Number.isFinite(index) ? index : ids.length, ids.length));
  ids.splice(at, 0, task.id);
  ids.forEach((id, i) => {
    if (id === task.id) q.setStatusPos.run(status, i, id);
    else q.setPos.run(i, id);
  });
}

// Called by the drag-and-drop board.
router.post('/tasks/:id/move', loadTask, (req, res) => {
  const status = req.body.status;
  const index = Number(req.body.index);
  if (!STATUSES.includes(status) || !Number.isInteger(index)) {
    return res.status(400).json({ error: 'Invalid move' });
  }
  tx(() => moveTask(req.task, status, index));
  res.json({ ok: true });
});

router.post('/tasks/:id/delete', loadTask, (req, res) => {
  q.deleteTask.run(req.task.id);
  setFlash(req, 'success', 'Task deleted.');
  res.redirect(`/projects/${req.task.project_id}`);
});

module.exports = { router, COLORS };
