// End-to-end tests: boots the real app against a throwaway database and drives it over HTTP.
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tugashub-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';

const app = require('../src/app');
const { db } = require('../src/db');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A tiny browser: keeps cookies and the CSRF token between requests. */
class Client {
  constructor() {
    this.cookies = new Map();
    this.token = null;
  }

  async req(url, { method = 'GET', form, json } = {}) {
    const headers = {};
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) {
      const entries = Array.isArray(form) ? form : Object.entries(form);
      body = new URLSearchParams([['_csrf', this.token || ''], ...entries.map(([k, v]) => [k, String(v)])]);
    }
    if (json) {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = this.token || '';
      body = JSON.stringify(json);
    }
    const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    res.body_ = await res.text();
    return res;
  }

  get(url) { return this.req(url); }
  post(url, form = {}) { return this.req(url, { method: 'POST', form }); }

  async refreshToken(url = '/signup') {
    const res = await this.get(url);
    this.token = res.body_.match(/name="_csrf" value="([^"]+)"/)[1];
  }

  /** Create a workspace (or join one with an invite code) and stay logged in. */
  async signup(name, email, { workspace, invite } = {}) {
    await this.refreshToken(invite ? `/signup?invite=${invite}` : '/signup');
    const form = { name, email, password: 'testpass123' };
    if (workspace) form.workspace = workspace;
    if (invite) form.invite = invite;
    const res = await this.post('/signup', form);
    assert.equal(res.status, 302, `signup failed: ${res.body_.match(/alert-error[^>]*>([^<]*)/)?.[1]}`);
    await this.refreshToken('/dashboard');
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }
}

const location = (res) => res.headers.get('location');
const idFrom = (res) => Number(location(res).match(/(\d+)$/)[1]);

async function newProject(client, name) {
  const res = await client.post('/projects', { name });
  return idFrom(res);
}

async function newTask(client, projectId, fields) {
  await client.post(`/projects/${projectId}/tasks`, fields);
  return db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId);
}

// ---------------------------------------------------------------------------

test('signup creates a workspace with an owner and default labels', async () => {
  const c = new Client();
  const user = await c.signup('Olivia Owner', 'olivia@test.test', { workspace: 'Olivia Co' });
  assert.equal(user.role, 'owner');
  const labels = db.prepare('SELECT name FROM labels WHERE workspace_id = ?').all(user.workspace_id).map((l) => l.name);
  assert.deepEqual(labels.sort(), ['Bug', 'Design', 'Docs', 'Research']);
  const dash = await c.get('/dashboard');
  assert.equal(dash.status, 200);
  assert.match(dash.body_, /Good to see you, Olivia/);
});

test('requests without a CSRF token are rejected', async () => {
  const c = new Client();
  await c.signup('Carl Csrf', 'carl@test.test', { workspace: 'Carl Co' });
  c.token = 'wrong';
  const res = await c.post('/projects', { name: 'Nope' });
  assert.equal(res.status, 403);
});

test('workspaces cannot see or change each other\'s data', async () => {
  const a = new Client();
  await a.signup('Alice A', 'alice@test.test', { workspace: 'A Co' });
  const projectId = await newProject(a, 'Secret plans');
  const task = await newTask(a, projectId, { title: 'Secret task' });

  const b = new Client();
  await b.signup('Bob B', 'bob@test.test', { workspace: 'B Co' });
  assert.equal((await b.get(`/projects/${projectId}`)).status, 404);
  assert.equal((await b.get(`/tasks/${task.id}`)).status, 404);
  assert.equal((await b.req(`/tasks/${task.id}/move`, { method: 'POST', json: { status: 'done', index: 0 } })).status, 404);
  assert.equal((await b.post(`/tasks/${task.id}/comments`, { body: 'hi' })).status, 404);
  const search = await b.get('/tasks?q=Secret');
  assert.doesNotMatch(search.body_, /Secret task/);
});

test('free plan limits projects; archiving frees a slot; restore respects the limit', async () => {
  const c = new Client();
  await c.signup('Fiona Free', 'fiona@test.test', { workspace: 'Free Co' });
  const ids = [];
  for (const n of [1, 2, 3]) ids.push(await newProject(c, `P${n}`));
  const blocked = await c.post('/projects', { name: 'P4' });
  assert.equal(location(blocked), '/billing');

  await c.post(`/projects/${ids[0]}/archive`);
  const p4 = await newProject(c, 'P4');
  assert.ok(p4 > 0);

  await c.post(`/projects/${ids[0]}/restore`);
  assert.notEqual(db.prepare('SELECT archived_at FROM projects WHERE id = ?').get(ids[0]).archived_at, null);
});

test('reports and CSV export are Pro-only, and CSV cells cannot run as formulas', async () => {
  const c = new Client();
  await c.signup('Paul Pro', 'paul@test.test', { workspace: 'Pro Co' });
  assert.equal((await c.get('/reports')).status, 402);
  assert.equal((await c.get('/tasks/export.csv')).status, 402);

  await c.post('/billing/upgrade');
  const projectId = await newProject(c, 'Data');
  await newTask(c, projectId, { title: '=HYPERLINK("http://evil")', priority: 'high' });

  const reports = await c.get('/reports');
  assert.equal(reports.status, 200);
  assert.match(reports.body_, /Tasks completed per week/);

  const csv = await c.get('/tasks/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.body_, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
});

test('task lifecycle: labels, assignment, completion, activity and notifications', async () => {
  const owner = new Client();
  const o = await owner.signup('Tia Tasks', 'tia@test.test', { workspace: 'Task Co' });
  const invite = db.prepare('SELECT invite_code FROM workspaces WHERE id = ?').get(o.workspace_id).invite_code;
  const member = new Client();
  const m = await member.signup('Max Member', 'max@test.test', { invite });
  assert.equal(m.workspace_id, o.workspace_id);
  assert.equal(m.role, 'member');

  const bug = db.prepare("SELECT id FROM labels WHERE workspace_id = ? AND name = 'Bug'").get(o.workspace_id).id;
  const projectId = await newProject(owner, 'Launch');
  const task = await newTask(owner, projectId, [['title', 'Fix crash'], ['assignee_id', m.id], ['labels', bug], ['priority', 'high']]);
  assert.equal(task.assignee_id, m.id);
  assert.ok(db.prepare('SELECT 1 FROM task_labels WHERE task_id = ? AND label_id = ?').get(task.id, bug));

  const notif = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND kind = 'assigned'").get(m.id);
  assert.match(notif.message, /assigned you “Fix crash”/);

  // Member drags it to Done.
  const moved = await member.req(`/tasks/${task.id}/move`, { method: 'POST', json: { status: 'done', index: 0 } });
  assert.equal(moved.status, 200);
  const done = db.prepare('SELECT status, completed_at FROM tasks WHERE id = ?').get(task.id);
  assert.equal(done.status, 'done');
  assert.ok(done.completed_at);
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE task_id = ? AND action = 'task.completed'").get(task.id));
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'completed'").get(o.id));

  // Moving it back clears the completion time.
  await member.req(`/tasks/${task.id}/move`, { method: 'POST', json: { status: 'todo', index: 0 } });
  assert.equal(db.prepare('SELECT completed_at FROM tasks WHERE id = ?').get(task.id).completed_at, null);

  // Filters find it by label; overdue filter does not.
  assert.match((await owner.get(`/tasks?label=${bug}`)).body_, /Fix crash/);
  assert.doesNotMatch((await owner.get('/tasks?due=overdue')).body_, /Fix crash/);

  // The notification opens the task and is marked read.
  const open = await member.get(`/notifications/${notif.id}`);
  assert.equal(location(open), `/tasks/${task.id}`);
  assert.ok(db.prepare('SELECT read_at FROM notifications WHERE id = ?').get(notif.id).read_at);
});

test('comments escape HTML and @mentions notify the right person', async () => {
  const owner = new Client();
  const o = await owner.signup('Nora Notes', 'nora@test.test', { workspace: 'Notes Co' });
  const invite = db.prepare('SELECT invite_code FROM workspaces WHERE id = ?').get(o.workspace_id).invite_code;
  const member = new Client();
  const m = await member.signup('Sam Smith', 'sam@test.test', { invite });

  const projectId = await newProject(owner, 'Docs');
  const task = await newTask(owner, projectId, { title: 'Write guide' });
  await owner.post(`/tasks/${task.id}/comments`, { body: '@sam please review <script>alert(1)</script>' });

  const page = await member.get(`/tasks/${task.id}`);
  assert.match(page.body_, /<span class="mention">@sam<\/span>/);
  assert.match(page.body_, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(page.body_, /<script>alert\(1\)/);
  const n = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND kind = 'mention'").get(m.id);
  assert.match(n.message, /mentioned you on “Write guide”/);
  assert.match((await member.get('/notifications')).body_, /mentioned you/);
});

test('checklist items can be added and ticked off', async () => {
  const c = new Client();
  await c.signup('Chen Check', 'chen@test.test', { workspace: 'Check Co' });
  const projectId = await newProject(c, 'Steps');
  const task = await newTask(c, projectId, { title: 'Multi-step job' });
  await c.post(`/tasks/${task.id}/checklist`, { text: 'Step one' });
  await c.post(`/tasks/${task.id}/checklist`, { text: 'Step two' });
  const [first] = db.prepare('SELECT * FROM checklist_items WHERE task_id = ? ORDER BY position').all(task.id);
  await c.post(`/checklist/${first.id}/toggle`);
  assert.equal(db.prepare('SELECT done FROM checklist_items WHERE id = ?').get(first.id).done, 1);
  const board = await c.get(`/projects/${projectId}`);
  assert.match(board.body_, /1\/2/);
});

test('roles: members cannot archive, owners promote admins, admins cannot remove the owner', async () => {
  const owner = new Client();
  const o = await owner.signup('Rita Roles', 'rita@test.test', { workspace: 'Roles Co' });
  const invite = db.prepare('SELECT invite_code FROM workspaces WHERE id = ?').get(o.workspace_id).invite_code;
  const member = new Client();
  const m = await member.signup('Ravi Roles', 'ravi@test.test', { invite });
  const projectId = await newProject(owner, 'Guarded');

  await member.post(`/projects/${projectId}/archive`);
  assert.equal(db.prepare('SELECT archived_at FROM projects WHERE id = ?').get(projectId).archived_at, null);
  await member.post(`/team/${m.id}/role`, { role: 'admin' });
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(m.id).role, 'member');

  await owner.post(`/team/${m.id}/role`, { role: 'admin' });
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(m.id).role, 'admin');

  await member.post(`/projects/${projectId}/archive`);
  assert.notEqual(db.prepare('SELECT archived_at FROM projects WHERE id = ?').get(projectId).archived_at, null);
  await member.post(`/team/${o.id}/remove`);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(o.id));
  await member.post('/billing/upgrade');
  assert.equal(db.prepare('SELECT plan FROM workspaces WHERE id = ?').get(o.workspace_id).plan, 'free');
});

test('every main page renders for a logged-in user', async () => {
  const c = new Client();
  await c.signup('Page Tester', 'pages@test.test', { workspace: 'Pages Co' });
  const projectId = await newProject(c, 'Smoke');
  const task = await newTask(c, projectId, { title: 'Smoke task', due_date: '2026-01-15' });
  for (const url of ['/dashboard', '/tasks', '/calendar', '/calendar?month=2026-01', '/activity', '/notifications',
    '/team', '/billing', '/settings', `/projects/${projectId}`, `/projects/${projectId}?priority=high`, `/tasks/${task.id}`]) {
    const res = await c.get(url);
    assert.equal(res.status, 200, `${url} returned ${res.status}`);
  }
  assert.match((await c.get('/calendar?month=2026-01')).body_, /Smoke task/);
});

test('migration upgrades a version 1 database without losing data', () => {
  const file = path.join(tmp, 'v1.db');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', invite_code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE users (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','member')), created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE projects (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#1f6f50', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium', assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, due_date TEXT, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE billing_events (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, action TEXT NOT NULL, plan TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO workspaces (id, name, invite_code) VALUES (1, 'Old Co', 'abc');
    INSERT INTO users (id, workspace_id, name, email, password_hash, role) VALUES (1, 1, 'Old Owner', 'old@test.test', 'x', 'owner');
    INSERT INTO projects (id, workspace_id, name) VALUES (1, 1, 'Old project');
    INSERT INTO tasks (id, project_id, title, status, assignee_id) VALUES (1, 1, 'Old done task', 'done', 1);
    PRAGMA user_version = 1;
  `);
  old.close();

  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
    const { db } = require('./src/db');
    console.log(JSON.stringify({
      version: db.prepare('PRAGMA user_version').get().user_version,
      task: db.prepare('SELECT title, assignee_id, completed_at IS NOT NULL AS has_completed FROM tasks').get(),
      role: db.prepare("UPDATE users SET role = 'admin' WHERE id = 1 RETURNING role").get().role,
    }));`], { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_PATH: file } }).toString();

  const result = JSON.parse(out);
  assert.equal(result.version, 2);
  assert.deepEqual({ ...result.task }, { title: 'Old done task', assignee_id: 1, has_completed: 1 });
  assert.equal(result.role, 'admin');
});
