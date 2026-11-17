// Cross-project views: search, CSV export, calendar and reports.
const express = require('express');
const { db } = require('../db');
const { requireAuth, requirePlan } = require('../middleware');
const { parseFilters, searchTasks, tasksDueBetween, workspaceLabels, filterQuery } = require('../services/tasks');

const router = express.Router();
router.use(requireAuth);

const PAGE_SIZE = 25;
const q = {
  projects: db.prepare('SELECT id, name, color FROM projects WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name COLLATE NOCASE'),
  members: db.prepare('SELECT id, name FROM users WHERE workspace_id = ? ORDER BY name'),
};

// ---- Search ----
router.get('/tasks', (req, res) => {
  const filters = parseFilters(req.query);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const { tasks, total } = searchTasks(req.workspace.id, req.user.id, filters, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  res.render('tasks', {
    title: 'Tasks',
    tasks,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    filters,
    filterQuery,
    projects: q.projects.all(req.workspace.id),
    members: q.members.all(req.workspace.id),
    labels: workspaceLabels(req.workspace.id),
  });
});

// ---- CSV export (Pro) ----
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Stop spreadsheet apps from running cell contents as formulas.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/tasks/export.csv', requirePlan('export'), (req, res) => {
  const filters = parseFilters(req.query);
  const { tasks } = searchTasks(req.workspace.id, req.user.id, filters, { limit: 100000 });
  const header = ['ID', 'Title', 'Project', 'Status', 'Priority', 'Assignee', 'Due date', 'Labels', 'Checklist', 'Comments', 'Created', 'Completed', 'Description'];
  const rows = tasks.map((t) => [
    t.id, t.title, t.project_name, t.status, t.priority, t.assignee_name, t.due_date,
    t.labels.map((l) => l.name).join('; '),
    t.checklist_total ? `${t.checklist_done}/${t.checklist_total}` : '',
    t.comment_count, t.created_at, t.completed_at, t.description,
  ]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="tugashub-tasks-${stamp}.csv"`);
  res.send('﻿' + csv); // BOM so Excel reads UTF-8 correctly
});

// ---- Calendar ----
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

router.get('/calendar', (req, res) => {
  const now = new Date();
  const m = /^(\d{4})-(\d{2})$/.exec(req.query.month || '');
  const year = m ? Number(m[1]) : now.getFullYear();
  const month = m ? Math.min(12, Math.max(1, Number(m[2]))) - 1 : now.getMonth();

  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7)); // back to Monday
  const last = new Date(year, month + 1, 0);
  const end = new Date(last);
  end.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7))); // forward to Sunday

  const filters = req.query.mine === '1' ? { assignee: 'me' } : {};
  const tasks = tasksDueBetween(req.workspace.id, req.user.id, ymd(start), ymd(end), filters);
  const byDay = new Map();
  for (const t of tasks) {
    if (!byDay.has(t.due_date)) byDay.set(t.due_date, []);
    byDay.get(t.due_date).push(t);
  }

  const weeks = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (weeks.length === 0 || weeks[weeks.length - 1].length === 7) weeks.push([]);
    const key = ymd(d);
    weeks[weeks.length - 1].push({ date: key, day: d.getDate(), inMonth: d.getMonth() === month, today: key === ymd(now), tasks: byDay.get(key) || [] });
  }

  const shift = (n) => {
    const d = new Date(year, month + n, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  };
  res.render('calendar', {
    title: 'Calendar',
    weeks,
    monthLabel: first.toLocaleDateString('en-MY', { month: 'long', year: 'numeric' }),
    prev: shift(-1),
    next: shift(1),
    current: `${year}-${pad(month + 1)}`,
    mine: req.query.mine === '1',
    count: tasks.filter((t) => t.due_date.slice(0, 7) === `${year}-${pad(month + 1)}`).length,
  });
});

// ---- Reports (Pro) ----
router.get('/reports', requirePlan('reports'), (req, res) => {
  const ws = req.workspace.id;
  const totals = db.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(t.status = 'done'), 0) AS done,
      COALESCE(SUM(t.status != 'done' AND t.due_date < date('now', 'localtime')), 0) AS overdue,
      AVG(CASE WHEN t.completed_at IS NOT NULL THEN julianday(t.completed_at) - julianday(t.created_at) END) AS avg_days,
      COALESCE(SUM(t.completed_at >= datetime('now', '-7 days')), 0) AS done_7,
      COALESCE(SUM(t.completed_at >= datetime('now', '-14 days') AND t.completed_at < datetime('now', '-7 days')), 0) AS done_prev_7
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.workspace_id = ? AND p.archived_at IS NULL`).get(ws);

  // Tasks completed per week, last 8 weeks (weeks start on Monday).
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const s = new Date(monday);
    s.setDate(s.getDate() - i * 7);
    const e = new Date(s);
    e.setDate(e.getDate() + 7);
    weeks.push({ start: ymd(s), end: ymd(e), label: s.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' }), count: 0 });
  }
  const done = db.prepare(`
    SELECT date(t.completed_at, 'localtime') AS d FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.workspace_id = ? AND t.completed_at IS NOT NULL AND date(t.completed_at, 'localtime') >= ?`).all(ws, weeks[0].start);
  for (const r of done) {
    const w = weeks.find((wk) => r.d >= wk.start && r.d < wk.end);
    if (w) w.count++;
  }

  const workload = db.prepare(`
    SELECT u.id, u.name,
      COALESCE(SUM(t.status = 'todo'), 0) AS todo,
      COALESCE(SUM(t.status = 'doing'), 0) AS doing,
      COALESCE(SUM(t.status = 'done'), 0) AS done,
      COALESCE(SUM(t.status != 'done' AND t.due_date < date('now', 'localtime')), 0) AS overdue
    FROM users u
    LEFT JOIN tasks t ON t.assignee_id = u.id
      AND t.project_id IN (SELECT id FROM projects WHERE workspace_id = ? AND archived_at IS NULL)
    WHERE u.workspace_id = ?
    GROUP BY u.id ORDER BY (todo + doing) DESC, u.name`).all(ws, ws);

  const priorities = db.prepare(`
    SELECT t.priority, COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.workspace_id = ? AND p.archived_at IS NULL AND t.status != 'done'
    GROUP BY t.priority`).all(ws);
  const byPriority = { high: 0, medium: 0, low: 0 };
  for (const r of priorities) byPriority[r.priority] = r.n;

  const projects = db.prepare(`
    SELECT p.id, p.name, p.color, COUNT(t.id) AS total,
      COALESCE(SUM(t.status = 'done'), 0) AS done,
      COALESCE(SUM(t.status != 'done' AND t.due_date < date('now', 'localtime')), 0) AS overdue
    FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
    WHERE p.workspace_id = ? AND p.archived_at IS NULL
    GROUP BY p.id ORDER BY p.name COLLATE NOCASE`).all(ws);

  res.render('reports', { title: 'Reports', totals, weeks, workload, byPriority, projects });
});

module.exports = { router };
