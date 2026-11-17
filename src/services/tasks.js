const { db } = require('../db');

const STATUSES = ['todo', 'doing', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const q = {
  columnIds: db.prepare('SELECT id FROM tasks WHERE project_id = ? AND status = ? AND id != ? ORDER BY position, id'),
  setStatusPos: db.prepare(`
    UPDATE tasks SET status = ?, position = ?,
      completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, datetime('now')) ELSE NULL END
    WHERE id = ?`),
  setPos: db.prepare('UPDATE tasks SET position = ? WHERE id = ?'),
  labels: db.prepare('SELECT * FROM labels WHERE workspace_id = ? ORDER BY name COLLATE NOCASE'),
};

/** Put a task into a column at the given index and renumber that column. */
function moveTask(task, status, index = Infinity) {
  const ids = q.columnIds.all(task.project_id, status, task.id).map((r) => r.id);
  const at = Math.max(0, Math.min(Number.isFinite(index) ? index : ids.length, ids.length));
  ids.splice(at, 0, task.id);
  ids.forEach((id, i) => {
    if (id === task.id) q.setStatusPos.run(status, i, status, id);
    else q.setPos.run(i, id);
  });
}

/** Normalise filter values from a query string. Unknown values are dropped. */
function parseFilters(query) {
  const f = {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  if (str(query.q)) f.q = str(query.q).slice(0, 100);
  if (/^\d+$/.test(str(query.project))) f.project = Number(query.project);
  if (str(query.assignee) === 'me' || str(query.assignee) === 'none') f.assignee = query.assignee;
  else if (/^\d+$/.test(str(query.assignee))) f.assignee = Number(query.assignee);
  if (/^\d+$/.test(str(query.label))) f.label = Number(query.label);
  if (PRIORITIES.includes(query.priority)) f.priority = query.priority;
  if (STATUSES.includes(query.status) || query.status === 'open') f.status = query.status;
  if (['overdue', 'week', 'none'].includes(query.due) || DATE_RE.test(str(query.due))) f.due = query.due;
  if (['due', 'created', 'priority', 'title'].includes(query.sort)) f.sort = query.sort;
  return f;
}

const SORTS = {
  due: 't.due_date IS NULL, t.due_date, t.id DESC',
  created: 't.created_at DESC, t.id DESC',
  priority: "CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.due_date IS NULL, t.due_date",
  title: 't.title COLLATE NOCASE',
};

/** Build the WHERE clause shared by search, export and counts. */
function whereFor(workspaceId, userId, f) {
  const where = ['p.workspace_id = ?', 'p.archived_at IS NULL'];
  const params = [workspaceId];
  if (f.q) {
    where.push('(t.title LIKE ? OR t.description LIKE ?)');
    params.push(`%${f.q}%`, `%${f.q}%`);
  }
  if (f.project) { where.push('t.project_id = ?'); params.push(f.project); }
  if (f.assignee === 'me') { where.push('t.assignee_id = ?'); params.push(userId); }
  else if (f.assignee === 'none') where.push('t.assignee_id IS NULL');
  else if (f.assignee) { where.push('t.assignee_id = ?'); params.push(f.assignee); }
  if (f.label) { where.push('EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id = ?)'); params.push(f.label); }
  if (f.priority) { where.push('t.priority = ?'); params.push(f.priority); }
  if (f.status === 'open') where.push("t.status != 'done'");
  else if (f.status) { where.push('t.status = ?'); params.push(f.status); }
  if (f.due === 'overdue') where.push("t.status != 'done' AND t.due_date < date('now', 'localtime')");
  else if (f.due === 'week') where.push("t.due_date BETWEEN date('now', 'localtime') AND date('now', 'localtime', '+7 days')");
  else if (f.due === 'none') where.push('t.due_date IS NULL');
  else if (f.due) { where.push('t.due_date = ?'); params.push(f.due); }
  return { sql: where.join(' AND '), params };
}

const SELECT_TASK = `
  SELECT t.*, p.name AS project_name, p.color AS project_color, u.name AS assignee_name,
         (t.status != 'done' AND t.due_date < date('now', 'localtime')) AS is_overdue
  FROM tasks t
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN users u ON u.id = t.assignee_id`;

/** Search tasks in a workspace. Returns { tasks, total }. */
function searchTasks(workspaceId, userId, f, { limit = 50, offset = 0 } = {}) {
  const { sql, params } = whereFor(workspaceId, userId, f);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${sql}`).get(...params).n;
  const tasks = db.prepare(`${SELECT_TASK} WHERE ${sql} ORDER BY ${SORTS[f.sort || 'due']} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { tasks: attachMeta(tasks), total };
}

/** Tasks with a due date inside [from, to], for the calendar. */
function tasksDueBetween(workspaceId, userId, from, to, f = {}) {
  const { sql, params } = whereFor(workspaceId, userId, f);
  return db.prepare(`${SELECT_TASK} WHERE ${sql} AND t.due_date BETWEEN ? AND ? ORDER BY t.due_date, t.status = 'done', t.priority = 'low'`)
    .all(...params, from, to);
}

/** All tasks of one project, for the board. */
function projectTasks(projectId) {
  return attachMeta(db.prepare(`${SELECT_TASK} WHERE t.project_id = ? ORDER BY t.position, t.id`).all(projectId));
}

/** Add labels, checklist progress and comment counts to a list of tasks. */
function attachMeta(tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map((t) => t.id);
  const marks = ids.map(() => '?').join(',');
  const byTask = new Map(tasks.map((t) => {
    t.labels = [];
    t.checklist_total = 0;
    t.checklist_done = 0;
    t.comment_count = 0;
    return [t.id, t];
  }));
  for (const r of db.prepare(`
    SELECT tl.task_id, l.id, l.name, l.color FROM task_labels tl JOIN labels l ON l.id = tl.label_id
    WHERE tl.task_id IN (${marks}) ORDER BY l.name COLLATE NOCASE`).all(...ids)) {
    byTask.get(r.task_id).labels.push({ id: r.id, name: r.name, color: r.color });
  }
  for (const r of db.prepare(`
    SELECT task_id, COUNT(*) AS total, SUM(done) AS done FROM checklist_items
    WHERE task_id IN (${marks}) GROUP BY task_id`).all(...ids)) {
    Object.assign(byTask.get(r.task_id), { checklist_total: r.total, checklist_done: r.done || 0 });
  }
  for (const r of db.prepare(`
    SELECT task_id, COUNT(*) AS n FROM comments WHERE task_id IN (${marks}) GROUP BY task_id`).all(...ids)) {
    byTask.get(r.task_id).comment_count = r.n;
  }
  return tasks;
}

function workspaceLabels(workspaceId) {
  return q.labels.all(workspaceId);
}

/** Turn a filter object back into a query string, optionally changing keys. */
function filterQuery(f, changes = {}) {
  const merged = { ...f, ...changes };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

module.exports = {
  STATUSES, PRIORITIES, DATE_RE,
  moveTask, parseFilters, searchTasks, tasksDueBetween, projectTasks, attachMeta, workspaceLabels, filterQuery,
};
