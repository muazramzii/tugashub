const express = require('express');
const { db, tx } = require('../db');
const { requireAuth, setFlash } = require('../middleware');
const { can } = require('../permissions');
const { logActivity, notify, findMentions, renderComment, quote } = require('../services/activity');
const { STATUSES, PRIORITIES, DATE_RE, moveTask, workspaceLabels } = require('../services/tasks');

const router = express.Router();
router.use(requireAuth);

const STATUS_LABEL = { todo: 'To do', doing: 'In progress', done: 'Done' };

const q = {
  project: db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?'),
  task: db.prepare(`
    SELECT t.*, p.workspace_id, p.name AS project_name, p.color AS project_color,
           a.name AS assignee_name, c.name AS creator_name
    FROM tasks t JOIN projects p ON p.id = t.project_id
    LEFT JOIN users a ON a.id = t.assignee_id
    LEFT JOIN users c ON c.id = t.created_by
    WHERE t.id = ? AND p.workspace_id = ?`),
  member: db.prepare('SELECT id, name FROM users WHERE id = ? AND workspace_id = ?'),
  members: db.prepare('SELECT id, name FROM users WHERE workspace_id = ? ORDER BY name'),
  nextPosition: db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM tasks WHERE project_id = ? AND status = ?'),
  insertTask: db.prepare(`
    INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, created_by, due_date, position, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'done' THEN datetime('now') END)`),
  updateTask: db.prepare('UPDATE tasks SET title = ?, description = ?, priority = ?, assignee_id = ?, due_date = ? WHERE id = ?'),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
  taskLabels: db.prepare('SELECT label_id FROM task_labels WHERE task_id = ?'),
  clearLabels: db.prepare('DELETE FROM task_labels WHERE task_id = ?'),
  addLabel: db.prepare('INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)'),
  label: db.prepare('SELECT id FROM labels WHERE id = ? AND workspace_id = ?'),
  checklist: db.prepare('SELECT * FROM checklist_items WHERE task_id = ? ORDER BY position, id'),
  checklistItem: db.prepare(`
    SELECT ci.*, t.project_id FROM checklist_items ci
    JOIN tasks t ON t.id = ci.task_id JOIN projects p ON p.id = t.project_id
    WHERE ci.id = ? AND p.workspace_id = ?`),
  addItem: db.prepare(`INSERT INTO checklist_items (task_id, text, position)
    VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM checklist_items WHERE task_id = ?))`),
  toggleItem: db.prepare('UPDATE checklist_items SET done = 1 - done WHERE id = ?'),
  deleteItem: db.prepare('DELETE FROM checklist_items WHERE id = ?'),
  comments: db.prepare(`
    SELECT c.*, u.name AS user_name FROM comments c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ? ORDER BY c.id`),
  comment: db.prepare(`
    SELECT c.* FROM comments c JOIN tasks t ON t.id = c.task_id JOIN projects p ON p.id = t.project_id
    WHERE c.id = ? AND p.workspace_id = ?`),
  addComment: db.prepare('INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)'),
  deleteComment: db.prepare('DELETE FROM comments WHERE id = ?'),
  commenters: db.prepare('SELECT DISTINCT user_id FROM comments WHERE task_id = ? AND user_id IS NOT NULL'),
  taskActivity: db.prepare(`
    SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.task_id = ? ORDER BY a.id DESC LIMIT 30`),
};

/** Read and validate the shared task form fields. Returns { values } or { error }. */
function readTaskForm(body, workspaceId) {
  const title = (body.title || '').trim();
  const description = (body.description || '').trim().slice(0, 4000);
  const priority = PRIORITIES.includes(body.priority) ? body.priority : 'medium';
  const due = (body.due_date || '').trim();
  let assignee = body.assignee_id ? Number(body.assignee_id) : null;
  if (!title) return { error: 'A task needs a title.' };
  if (title.length > 200) return { error: 'Keep the title under 200 characters.' };
  if (due && !DATE_RE.test(due)) return { error: 'Due date is not a valid date.' };
  if (assignee && !q.member.get(assignee, workspaceId)) assignee = null;
  const raw = [].concat(body.labels || []);
  const labels = raw.map(Number).filter((id) => q.label.get(id, workspaceId));
  return { values: { title, description, priority, assignee, due: due || null, labels } };
}

function setLabels(taskId, labelIds) {
  q.clearLabels.run(taskId);
  for (const id of labelIds) q.addLabel.run(taskId, id);
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

const ctx = (req) => ({ workspaceId: req.workspace.id, userId: req.user.id, projectId: req.task.project_id, taskId: req.task.id });

// ---- Create ----
router.post('/projects/:id/tasks', (req, res) => {
  const project = q.project.get(Number(req.params.id), req.workspace.id);
  if (!project) return res.status(404).render('error', { title: 'Not found', message: 'That project does not exist in your workspace.' });
  const { values, error } = readTaskForm(req.body, req.workspace.id);
  if (error) {
    setFlash(req, 'error', error);
    return res.redirect(`/projects/${project.id}`);
  }
  const status = STATUSES.includes(req.body.status) ? req.body.status : 'todo';
  tx(() => {
    const pos = q.nextPosition.get(project.id, status).pos;
    const id = Number(q.insertTask.run(project.id, values.title, values.description, status, values.priority,
      values.assignee, req.user.id, values.due, pos, status).lastInsertRowid);
    setLabels(id, values.labels);
    logActivity({ workspaceId: req.workspace.id, userId: req.user.id, projectId: project.id, taskId: id,
      action: 'task.created', summary: `created ${quote(values.title)} in ${project.name}` });
    notify({ userId: values.assignee, actorId: req.user.id, taskId: id, kind: 'assigned',
      message: `${req.user.name} assigned you ${quote(values.title)}` });
  });
  res.redirect(`/projects/${project.id}`);
});

// ---- Detail ----
router.get('/tasks/:id/edit', (req, res) => res.redirect(301, `/tasks/${req.params.id}`));

router.get('/tasks/:id', loadTask, (req, res) => renderTask(req, res));

function renderTask(req, res, { error = null, task = req.task, status = 200 } = {}) {
  const members = q.members.all(req.workspace.id);
  res.status(status).render('task', {
    title: req.task.title,
    task,
    taskLabelIds: new Set(q.taskLabels.all(req.task.id).map((r) => r.label_id)),
    labels: workspaceLabels(req.workspace.id),
    members,
    checklist: q.checklist.all(req.task.id),
    comments: q.comments.all(req.task.id).map((c) => ({ ...c, html: renderComment(c.body, members) })),
    activity: q.taskActivity.all(req.task.id),
    error,
  });
}

// ---- Update ----
router.post('/tasks/:id', loadTask, (req, res) => {
  const { values, error } = readTaskForm(req.body, req.workspace.id);
  if (error) return renderTask(req, res, { error, task: { ...req.task, ...req.body }, status: 400 });
  const t = req.task;
  const status = STATUSES.includes(req.body.status) ? req.body.status : t.status;

  tx(() => {
    q.updateTask.run(values.title, values.description, values.priority, values.assignee, values.due, t.id);
    setLabels(t.id, values.labels);
    if (status !== t.status) moveTask(t, status);

    // Log what changed, one entry per meaningful change.
    const changes = [];
    if (values.title !== t.title) changes.push('renamed it');
    if (values.priority !== t.priority) changes.push(`set priority to ${values.priority}`);
    if ((values.due || null) !== (t.due_date || null)) changes.push(values.due ? `set the due date to ${values.due}` : 'removed the due date');
    if (values.description !== t.description) changes.push('edited the description');
    if (changes.length) {
      logActivity({ ...ctx(req), action: 'task.updated', summary: `updated ${quote(values.title)}: ${changes.join(', ')}` });
    }
    if (status !== t.status) logStatus(req, values.title, status);
    if (values.assignee !== t.assignee_id) {
      const who = values.assignee ? q.member.get(values.assignee, req.workspace.id).name : null;
      logActivity({ ...ctx(req), action: 'task.assigned',
        summary: who ? `assigned ${quote(values.title)} to ${who}` : `unassigned ${quote(values.title)}` });
      notify({ userId: values.assignee, actorId: req.user.id, taskId: t.id, kind: 'assigned',
        message: `${req.user.name} assigned you ${quote(values.title)}` });
    }
  });
  setFlash(req, 'success', 'Task saved.');
  res.redirect(`/tasks/${t.id}`);
});

function logStatus(req, title, status) {
  logActivity({ ...ctx(req), action: status === 'done' ? 'task.completed' : 'task.moved',
    summary: status === 'done' ? `completed ${quote(title)}` : `moved ${quote(title)} to ${STATUS_LABEL[status]}` });
  if (status === 'done' && req.task.created_by) {
    notify({ userId: req.task.created_by, actorId: req.user.id, taskId: req.task.id, kind: 'completed',
      message: `${req.user.name} completed ${quote(title)}` });
  }
}

// Called by the drag-and-drop board.
router.post('/tasks/:id/move', loadTask, (req, res) => {
  const status = req.body.status;
  const index = Number(req.body.index);
  if (!STATUSES.includes(status) || !Number.isInteger(index)) {
    return res.status(400).json({ error: 'Invalid move' });
  }
  tx(() => {
    moveTask(req.task, status, index);
    if (status !== req.task.status) logStatus(req, req.task.title, status);
  });
  res.json({ ok: true });
});

router.post('/tasks/:id/delete', loadTask, (req, res) => {
  tx(() => {
    q.deleteTask.run(req.task.id);
    logActivity({ workspaceId: req.workspace.id, userId: req.user.id, projectId: req.task.project_id,
      action: 'task.deleted', summary: `deleted ${quote(req.task.title)}` });
  });
  setFlash(req, 'success', 'Task deleted.');
  res.redirect(`/projects/${req.task.project_id}`);
});

// ---- Checklist ----
router.post('/tasks/:id/checklist', loadTask, (req, res) => {
  const text = (req.body.text || '').trim().slice(0, 200);
  if (text) q.addItem.run(req.task.id, text, req.task.id);
  res.redirect(`/tasks/${req.task.id}#checklist`);
});

function loadItem(req, res, next) {
  req.item = q.checklistItem.get(Number(req.params.itemId), req.workspace.id);
  if (!req.item) return res.status(404).render('error', { title: 'Not found', message: 'That checklist item does not exist.' });
  next();
}

router.post('/checklist/:itemId/toggle', loadItem, (req, res) => {
  q.toggleItem.run(req.item.id);
  if (req.is('json')) return res.json({ ok: true, done: !req.item.done });
  res.redirect(`/tasks/${req.item.task_id}#checklist`);
});

router.post('/checklist/:itemId/delete', loadItem, (req, res) => {
  q.deleteItem.run(req.item.id);
  res.redirect(`/tasks/${req.item.task_id}#checklist`);
});

// ---- Comments ----
router.post('/tasks/:id/comments', loadTask, (req, res) => {
  const body = (req.body.body || '').trim().slice(0, 4000);
  if (!body) return res.redirect(`/tasks/${req.task.id}#comments`);
  const t = req.task;
  tx(() => {
    q.addComment.run(t.id, req.user.id, body);
    logActivity({ ...ctx(req), action: 'comment.added', summary: `commented on ${quote(t.title)}` });

    const mentioned = findMentions(body, req.workspace.id);
    const told = new Set(mentioned.map((m) => m.id));
    for (const m of mentioned) {
      notify({ userId: m.id, actorId: req.user.id, taskId: t.id, kind: 'mention',
        message: `${req.user.name} mentioned you on ${quote(t.title)}` });
    }
    // Everyone already involved hears about new comments, once.
    const involved = new Set([t.assignee_id, t.created_by, ...q.commenters.all(t.id).map((r) => r.user_id)]);
    for (const id of involved) {
      if (id && !told.has(id)) {
        notify({ userId: id, actorId: req.user.id, taskId: t.id, kind: 'comment',
          message: `${req.user.name} commented on ${quote(t.title)}` });
      }
    }
  });
  res.redirect(`/tasks/${t.id}#comments`);
});

router.post('/comments/:commentId/delete', (req, res) => {
  const comment = q.comment.get(Number(req.params.commentId), req.workspace.id);
  if (!comment) return res.status(404).render('error', { title: 'Not found', message: 'That comment does not exist.' });
  if (!can.deleteComment(req.user, comment)) {
    setFlash(req, 'error', 'You can only delete your own comments.');
  } else {
    q.deleteComment.run(comment.id);
  }
  res.redirect(`/tasks/${comment.task_id}#comments`);
});

module.exports = { router };
