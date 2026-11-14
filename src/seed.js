// Creates a demo workspace with sample data.
// Demo logins (all use the password: password123)
//   owner:  aina@demo.test
//   member: farid@demo.test
//   member: mei@demo.test
const bcrypt = require('bcryptjs');
const { db, tx } = require('./db');
const { newInviteCode } = require('./routes/auth');

const PASSWORD = 'password123';

if (db.prepare('SELECT id FROM users WHERE email = ?').get('aina@demo.test')) {
  console.log('Demo data already exists. Delete the data/ folder to reset it.');
  process.exit(0);
}

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

tx(() => {
  const hash = bcrypt.hashSync(PASSWORD, 10);
  const ws = Number(db.prepare('INSERT INTO workspaces (name, invite_code) VALUES (?, ?)')
    .run('UTHM Mini Project Team', newInviteCode()).lastInsertRowid);

  const addUser = db.prepare('INSERT INTO users (workspace_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)');
  const aina = Number(addUser.run(ws, 'Aina Rahman', 'aina@demo.test', hash, 'owner').lastInsertRowid);
  const farid = Number(addUser.run(ws, 'Farid Hakim', 'farid@demo.test', hash, 'member').lastInsertRowid);
  const mei = Number(addUser.run(ws, 'Tan Mei Ling', 'mei@demo.test', hash, 'member').lastInsertRowid);

  const addProject = db.prepare('INSERT INTO projects (workspace_id, name, description, color) VALUES (?, ?, ?, ?)');
  const addTask = db.prepare(`INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, created_by, due_date, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const web = Number(addProject.run(ws, 'Website launch', 'Marketing site and sign-up flow', '#2457a6').lastInsertRowid);
  const report = Number(addProject.run(ws, 'Final report', 'Chapters 1 to 5 and presentation slides', '#1f6f50').lastInsertRowid);

  const tasks = [
    [web, 'Write landing page copy', 'Hero, features and pricing sections', 'done', 'medium', mei, day(-6)],
    [web, 'Design pricing section', '', 'done', 'low', mei, day(-3)],
    [web, 'Build sign-up form validation', 'Email format, password length, duplicate email', 'doing', 'high', farid, day(2)],
    [web, 'Set up hosting', 'Compare Render and Railway free tiers', 'todo', 'medium', farid, day(5)],
    [web, 'Test on mobile', '', 'todo', 'low', null, day(7)],
    [report, 'Chapter 1: Introduction', 'Problem statement, objectives, scope', 'done', 'high', aina, day(-10)],
    [report, 'Chapter 2: Literature review', 'Compare Trello, Asana and Jira', 'doing', 'high', aina, day(-1)],
    [report, 'Draw ERD and use case diagram', '', 'doing', 'medium', mei, day(3)],
    [report, 'Chapter 4: Testing results', '', 'todo', 'medium', farid, day(12)],
    [report, 'Prepare presentation slides', '', 'todo', 'low', null, null],
  ];
  const pos = {};
  for (const [p, title, desc, status, prio, who, due] of tasks) {
    const key = p + status;
    pos[key] = (pos[key] ?? -1) + 1;
    addTask.run(p, title, desc, status, prio, who, aina, due, pos[key]);
  }
});

console.log('Demo data created. Log in as aina@demo.test with password "password123".');
