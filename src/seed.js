// Creates a demo workspace with realistic sample data spread over the last 8 weeks.
// Demo logins (all use the password: password123)
//   owner:  aina@demo.test
//   admin:  farid@demo.test
//   member: mei@demo.test
//   member: daniel@demo.test
const bcrypt = require('bcryptjs');
const { db, tx } = require('./db');
const { newInviteCode } = require('./routes/auth');

const PASSWORD = 'password123';

// `npm run reset` wipes every workspace first. This works while the server is
// running (Windows locks the database file, so deleting it is not an option).
if (process.argv.includes('--reset')) {
  tx(() => {
    db.exec('DELETE FROM workspaces'); // cascades to everything else
    db.exec('DELETE FROM sqlite_sequence');
  });
  console.log('All data deleted.');
}

if (db.prepare('SELECT id FROM users WHERE email = ?').get('aina@demo.test')) {
  console.log('Demo data already exists. Run "npm run reset" to start over.');
  process.exit(0);
}

const pad = (n) => String(n).padStart(2, '0');
/** UTC timestamp `days` ago, in SQLite's datetime format. */
const ago = (days, hours = 0) => new Date(Date.now() - (days * 24 + hours) * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
/** Local calendar date `offset` days from today. */
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

tx(() => {
  const hash = bcrypt.hashSync(PASSWORD, 10);
  const ws = Number(db.prepare("INSERT INTO workspaces (name, invite_code, plan, created_at) VALUES (?, ?, 'pro', ?)")
    .run('UTHM Mini Project Team', newInviteCode(), ago(60)).lastInsertRowid);
  db.prepare('INSERT INTO billing_events (workspace_id, action, plan, amount, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ws, 'upgrade', 'pro', 29, ago(40));

  const addUser = db.prepare('INSERT INTO users (workspace_id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const U = {
    aina: Number(addUser.run(ws, 'Aina Rahman', 'aina@demo.test', hash, 'owner', ago(60)).lastInsertRowid),
    farid: Number(addUser.run(ws, 'Farid Hakim', 'farid@demo.test', hash, 'admin', ago(58)).lastInsertRowid),
    mei: Number(addUser.run(ws, 'Tan Mei Ling', 'mei@demo.test', hash, 'member', ago(58)).lastInsertRowid),
    daniel: Number(addUser.run(ws, 'Daniel Lee', 'daniel@demo.test', hash, 'member', ago(30)).lastInsertRowid),
  };
  const names = { [U.aina]: 'Aina', [U.farid]: 'Farid', [U.mei]: 'Mei', [U.daniel]: 'Daniel' };

  const addLabel = db.prepare('INSERT INTO labels (workspace_id, name, color) VALUES (?, ?, ?)');
  const L = {};
  for (const [name, color] of [['Bug', '#e34948'], ['Design', '#e87ba4'], ['Docs', '#2a78d6'], ['Research', '#6250d6'], ['Urgent', '#eb6834'], ['Testing', '#1baf7a']]) {
    L[name] = Number(addLabel.run(ws, name, color).lastInsertRowid);
  }

  const addProject = db.prepare('INSERT INTO projects (workspace_id, name, description, color, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)');
  const P = {
    report: Number(addProject.run(ws, 'Final report', 'Chapters 1 to 5, diagrams and references', '#1f6f50', ago(56), null).lastInsertRowid),
    web: Number(addProject.run(ws, 'Website launch', 'Marketing site, sign-up flow and hosting', '#2457a6', ago(50), null).lastInsertRowid),
    app: Number(addProject.run(ws, 'Mobile app prototype', 'Figma prototype and user testing', '#5b4bb7', ago(35), null).lastInsertRowid),
    demo: Number(addProject.run(ws, 'Presentation day', 'Slides, demo video and rehearsal', '#b54708', ago(20), null).lastInsertRowid),
    survey: Number(addProject.run(ws, 'Requirements survey', 'Google Form survey of 40 students', '#3d6b7a', ago(58), ago(30)).lastInsertRowid),
  };

  const addActivity = db.prepare('INSERT INTO activity (workspace_id, user_id, project_id, task_id, action, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const act = (user, project, task, action, summary, at) => addActivity.run(ws, user, project, task, action, summary, at);
  for (const [key, p] of Object.entries(P)) {
    const row = db.prepare('SELECT name, created_at FROM projects WHERE id = ?').get(p);
    act(U.aina, p, null, 'project.created', `created project “${row.name}”`, row.created_at);
    if (key === 'survey') act(U.farid, p, null, 'project.archived', `archived project “${row.name}”`, ago(30));
  }
  act(U.daniel, null, null, 'member.joined', 'joined the workspace', ago(30));
  act(U.aina, null, null, 'plan.upgraded', 'upgraded the workspace to Pro', ago(40));

  const addTask = db.prepare(`INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, created_by, due_date, position, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tagTask = db.prepare('INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)');
  const addItem = db.prepare('INSERT INTO checklist_items (task_id, text, done, position, created_at) VALUES (?, ?, ?, ?, ?)');

  // [project, title, description, status, priority, assignee, due (days from today), created (days ago), completed (days ago), labels, checklist]
  const tasks = [
    [P.report, 'Chapter 1: Introduction', 'Problem statement, objectives, scope', 'done', 'high', U.aina, -40, 54, 44, ['Docs'], [['Problem statement', 1], ['Objectives', 1], ['Scope', 1]]],
    [P.report, 'Chapter 2: Literature review', 'Compare Trello, Asana and Jira', 'done', 'high', U.aina, -20, 50, 22, ['Docs', 'Research'], null],
    [P.report, 'Chapter 3: Methodology', 'Agile with 2-week sprints', 'done', 'medium', U.farid, -12, 40, 13, ['Docs'], null],
    [P.report, 'Draw ERD and use case diagram', 'Use draw.io, export as PNG', 'doing', 'medium', U.mei, 3, 20, null, ['Design', 'Docs'], [['ERD', 1], ['Use case diagram', 0], ['Activity diagram', 0]]],
    [P.report, 'Chapter 4: Implementation', 'Screenshots of every page and key code', 'doing', 'high', U.farid, 6, 14, null, ['Docs'], [['Auth module', 1], ['Kanban board', 1], ['Reports page', 0], ['Billing', 0]]],
    [P.report, 'Chapter 5: Testing results', 'Unit tests and user acceptance tests', 'todo', 'medium', U.daniel, 12, 10, null, ['Docs', 'Testing'], null],
    [P.report, 'Format references in APA 7th', '', 'todo', 'low', null, 18, 8, null, ['Docs'], null],
    [P.report, 'Proofread full report', '', 'todo', 'medium', U.aina, 20, 3, null, ['Docs'], null],
    [P.web, 'Write landing page copy', 'Hero, features and pricing sections', 'done', 'medium', U.mei, -30, 48, 35, ['Design'], null],
    [P.web, 'Design pricing section', '', 'done', 'low', U.mei, -24, 45, 28, ['Design'], null],
    [P.web, 'Build sign-up form validation', 'Email format, password length, duplicate email', 'done', 'high', U.farid, -10, 30, 9, ['Testing'], null],
    [P.web, 'Fix login redirect loop on Safari', 'Users bounce between /login and /dashboard', 'done', 'high', U.farid, -4, 8, 5, ['Bug', 'Urgent'], null],
    [P.web, 'Set up hosting on Render', 'Compare Render and Railway free tiers', 'doing', 'medium', U.farid, -1, 18, null, ['Research'], [['Create account', 1], ['Connect GitHub repo', 1], ['Set environment variables', 0]]],
    [P.web, 'Test on mobile', 'iPhone SE and a mid-range Android', 'todo', 'low', U.daniel, 5, 12, null, ['Testing'], null],
    [P.web, 'Dark mode colour check', '', 'todo', 'low', null, null, 6, null, ['Design'], null],
    [P.web, 'Footer links go to 404', '', 'todo', 'high', U.daniel, -2, 4, null, ['Bug'], null],
    [P.app, 'User interview script', '10 questions about how teams track tasks', 'done', 'medium', U.mei, -25, 34, 27, ['Research'], null],
    [P.app, 'Interview 5 students', '', 'done', 'medium', U.mei, -17, 30, 18, ['Research'], null],
    [P.app, 'Low-fidelity wireframes', '', 'done', 'medium', U.daniel, -14, 26, 15, ['Design'], null],
    [P.app, 'High-fidelity Figma prototype', 'Board, task detail and notifications screens', 'doing', 'high', U.daniel, 4, 16, null, ['Design'], [['Board screen', 1], ['Task detail screen', 1], ['Notifications screen', 0]]],
    [P.app, 'Usability test with 5 users', '', 'todo', 'medium', U.mei, 10, 9, null, ['Testing', 'Research'], null],
    [P.app, 'Summarise usability findings', '', 'todo', 'low', null, 14, 2, null, ['Research'], null],
    [P.demo, 'Prepare presentation slides', '15 slides max, 10 minutes', 'doing', 'high', U.aina, 8, 12, null, ['Design'], [['Outline', 1], ['Draft slides', 0], ['Speaker notes', 0]]],
    [P.demo, 'Record demo video', '3 minutes, show sign-up to reports', 'todo', 'medium', U.mei, 9, 7, null, [], null],
    [P.demo, 'Book lab for rehearsal', '', 'done', 'low', U.farid, -3, 10, 4, [], null],
    [P.demo, 'Rehearsal with supervisor', '', 'todo', 'high', null, 11, 2, null, ['Urgent'], null],
    [P.survey, 'Design survey questions', '', 'done', 'medium', U.mei, -45, 58, 47, ['Research'], null],
    [P.survey, 'Collect 40 responses', '', 'done', 'medium', U.farid, -38, 52, 38, ['Research'], null],
  ];

  const pos = {};
  const T = {};
  for (const [p, title, desc, status, prio, who, due, created, completed, labels, checklist] of tasks) {
    const key = `${p}:${status}`;
    pos[key] = (pos[key] ?? -1) + 1;
    const createdAt = ago(created);
    const completedAt = completed === null ? null : ago(completed, 3);
    const id = Number(addTask.run(p, title, desc, status, prio, who, U.aina, due === null ? null : day(due), pos[key], createdAt, completedAt).lastInsertRowid);
    T[title] = id;
    for (const l of labels) tagTask.run(id, L[l]);
    (checklist || []).forEach(([text, done], i) => addItem.run(id, text, done, i, createdAt));
    act(U.aina, p, id, 'task.created', `created “${title}”`, createdAt);
    if (who) act(U.aina, p, id, 'task.assigned', `assigned “${title}” to ${names[who]}`, ago(created, -1));
    if (status === 'doing') act(who || U.aina, p, id, 'task.moved', `moved “${title}” to In progress`, ago(Math.max(0, created - 2)));
    if (completedAt) act(who || U.aina, p, id, 'task.completed', `completed “${title}”`, completedAt);
  }

  const addComment = db.prepare('INSERT INTO comments (task_id, user_id, body, created_at) VALUES (?, ?, ?, ?)');
  const comments = [
    ['Set up hosting on Render', U.farid, 'Render free tier sleeps after 15 minutes. Railway gives $5 credit. I think Render is fine for the demo.', 3],
    ['Set up hosting on Render', U.aina, '@farid agreed, go with Render. Can you add the env variables by Friday?', 2],
    ['Set up hosting on Render', U.farid, 'Will do. @daniel can you test the live link on your phone once it is up?', 1],
    ['Draw ERD and use case diagram', U.mei, 'First draft of the ERD is in our Drive folder. @aina please check the relationships between tasks and labels.', 2],
    ['Draw ERD and use case diagram', U.aina, 'Looks good. task_labels needs a composite primary key, otherwise perfect.', 1],
    ['Chapter 4: Implementation', U.farid, 'I need screenshots of the reports page. @mei could you take them in dark mode too?', 0.5],
    ['Footer links go to 404', U.daniel, 'Privacy and Terms links point to pages that do not exist yet.', 1],
    ['Prepare presentation slides', U.mei, '@aina I can do the slides on the architecture diagram if you want.', 0.2],
  ];
  for (const [title, who, body, days] of comments) {
    const t = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(T[title]);
    addComment.run(T[title], who, body, ago(days));
    act(who, t.project_id, T[title], 'comment.added', `commented on “${title}”`, ago(days));
  }

  const addNotif = db.prepare('INSERT INTO notifications (user_id, actor_id, task_id, kind, message, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const notifs = [
    [U.aina, U.mei, 'Prepare presentation slides', 'mention', 'Tan Mei Ling mentioned you on “Prepare presentation slides”', null, 0.2],
    [U.aina, U.mei, 'Draw ERD and use case diagram', 'mention', 'Tan Mei Ling mentioned you on “Draw ERD and use case diagram”', null, 2],
    [U.aina, U.farid, 'Set up hosting on Render', 'comment', 'Farid Hakim commented on “Set up hosting on Render”', null, 1],
    [U.aina, U.farid, 'Fix login redirect loop on Safari', 'completed', 'Farid Hakim completed “Fix login redirect loop on Safari”', ago(4), 5],
    [U.farid, U.aina, 'Set up hosting on Render', 'mention', 'Aina Rahman mentioned you on “Set up hosting on Render”', null, 2],
    [U.daniel, U.farid, 'Set up hosting on Render', 'mention', 'Farid Hakim mentioned you on “Set up hosting on Render”', null, 1],
    [U.mei, U.farid, 'Chapter 4: Implementation', 'mention', 'Farid Hakim mentioned you on “Chapter 4: Implementation”', null, 0.5],
  ];
  for (const [user, actor, title, kind, msg, readAt, days] of notifs) addNotif.run(user, actor, T[title], kind, msg, readAt, ago(days));

  // ---- Chat ----
  const addChannel = db.prepare('INSERT INTO channels (workspace_id, kind, name, project_id, user_a, user_b, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const general = Number(addChannel.run(ws, 'general', 'general', null, null, null, ago(60)).lastInsertRowid);
  const channelOf = {};
  for (const [key, p] of Object.entries(P)) {
    const name = db.prepare('SELECT name FROM projects WHERE id = ?').get(p).name;
    channelOf[key] = Number(addChannel.run(ws, 'project', name, p, null, null, ago(50)).lastInsertRowid);
  }
  const [a, b] = [U.aina, U.farid].sort((x, y) => x - y);
  const dm = Number(addChannel.run(ws, 'direct', '', null, a, b, ago(5)).lastInsertRowid);

  const addMessage = db.prepare('INSERT INTO messages (channel_id, user_id, body, created_at) VALUES (?, ?, ?, ?)');
  const chats = [
    [general, U.aina, 'Welcome to TugasHub everyone! Use #general for anything that is not about one project.', 6, 0],
    [general, U.farid, 'Nice. Much better than our WhatsApp group 😄', 6, -0.1],
    [general, U.mei, 'Agreed. Can we meet on Thursday at 3pm in the FSKTM lab?', 2, 0],
    [general, U.daniel, 'Thursday works for me.', 2, -0.2],
    [general, U.farid, 'Me too. I will book the lab.', 2, -0.3],
    [general, U.aina, 'Reminder: progress presentation is in 9 days. Please update your tasks on the boards before Thursday.', 0, 5],
    [general, U.mei, '@aina can we go through the slide outline together tomorrow?', 0, 3],
    [channelOf.web, U.farid, 'Render deploy is working. Only the environment variables are left.', 1, 6],
    [channelOf.web, U.daniel, 'Found the 404 on the footer links. Privacy and Terms pages do not exist yet.', 1, 4],
    [channelOf.web, U.farid, '@daniel just remove those links for now, we can add the pages after the presentation.', 0, 7],
    [channelOf.report, U.aina, 'Chapter 2 is done. @farid you can start on chapter 4 screenshots.', 3, 0],
    [channelOf.report, U.farid, 'On it. Will finish the auth and board sections first.', 3, -0.5],
    [channelOf.app, U.daniel, 'Uploaded the board and task detail screens to Figma.', 1, 2],
    [dm, U.farid, 'Hi Aina, do you want me to handle the demo video as well?', 0, 2],
  ];
  for (const [channel, who, body, days, hours] of chats) addMessage.run(channel, who, body, ago(days, hours));

  // A past meeting with minutes; two of its action items are tasks on the boards.
  const minutes = [
    'Agenda: progress check before presentation day.',
    '',
    '- Report: chapters 1 to 3 done, chapter 4 in progress (Farid).',
    '- Demo: Mei records the video after the board screens are final.',
    '- Decision: rehearse with Dr. Lim before the presentation.',
    '',
    'Action items are on the boards.',
  ].join('\n');
  const meetingId = Number(db.prepare(`INSERT INTO meetings (workspace_id, project_id, title, room, started_by, notes, notes_updated_by, notes_updated_at, created_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ws, P.demo, 'Weekly progress check', `tugashub-${require('crypto').randomBytes(10).toString('hex')}`,
      U.aina, minutes, U.aina, ago(3, -1), ago(3), ago(3, -0.75)).lastInsertRowid);
  db.prepare('UPDATE tasks SET meeting_id = ? WHERE id IN (?, ?)').run(meetingId, T['Rehearsal with supervisor'], T['Proofread full report']);
  act(U.aina, P.demo, null, 'meeting.started', 'started the meeting “Weekly progress check”', ago(3));
  act(U.aina, P.demo, null, 'meeting.ended', 'ended the meeting “Weekly progress check”', ago(3, -0.75));

  // Aina has read everything up to yesterday, so today's messages show as unread.
  const markRead = db.prepare('INSERT INTO channel_reads (user_id, channel_id, last_read_id) VALUES (?, ?, ?)');
  const readUpTo = (channel) => db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = ? AND created_at < datetime('now', '-12 hours')").get(channel).id;
  for (const channel of [general, ...Object.values(channelOf), dm]) markRead.run(U.aina, channel, readUpTo(channel));
});

console.log('Demo data created. Log in as aina@demo.test with password "password123". See README for all demo accounts.');
