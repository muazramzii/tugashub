const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

/** Run fn inside a transaction; roll back if it throws. */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Schema migrations. Each runs once, in order, and bumps PRAGMA user_version.
 * Never edit a migration that has shipped; add a new one instead.
 */
const migrations = [
  // v1: initial schema
  `
  CREATE TABLE IF NOT EXISTS workspaces (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    plan        TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
    invite_code TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id  INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    color        TEXT NOT NULL DEFAULT '#1f6f50',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
    priority    TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    due_date    TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS billing_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    action       TEXT NOT NULL,
    plan         TEXT NOT NULL,
    amount       INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_workspace ON users(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status, position);
  CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
  `,

  // v2: admin role, archiving, completion time, comments, checklists, labels,
  // activity log and notifications.
  `
  CREATE TABLE users_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id  INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO users_new SELECT id, workspace_id, name, email, password_hash, role, created_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  CREATE INDEX idx_users_workspace ON users(workspace_id);

  ALTER TABLE projects ADD COLUMN archived_at TEXT;
  ALTER TABLE tasks ADD COLUMN completed_at TEXT;
  UPDATE tasks SET completed_at = created_at WHERE status = 'done';

  CREATE TABLE comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_comments_task ON comments(task_id);

  CREATE TABLE checklist_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_checklist_task ON checklist_items(task_id, position);

  CREATE TABLE labels (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    color        TEXT NOT NULL,
    UNIQUE (workspace_id, name)
  );
  CREATE TABLE task_labels (
    task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
  );
  CREATE INDEX idx_task_labels_label ON task_labels(label_id);

  CREATE TABLE activity (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    action       TEXT NOT NULL,
    summary      TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_activity_workspace ON activity(workspace_id, id DESC);
  CREATE INDEX idx_activity_task ON activity(task_id);

  CREATE TABLE notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    message    TEXT NOT NULL,
    read_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, id DESC);
  `,

  // v3: team chat (general, per-project and direct-message channels).
  `
  CREATE TABLE channels (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('general', 'project', 'direct')),
    name         TEXT NOT NULL DEFAULT '',
    project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    user_a       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    user_b       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id),
    UNIQUE (workspace_id, user_a, user_b),
    CHECK (kind != 'direct' OR (user_a IS NOT NULL AND user_b IS NOT NULL AND user_a < user_b))
  );
  CREATE UNIQUE INDEX idx_channels_general ON channels(workspace_id) WHERE kind = 'general';

  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_messages_channel ON messages(channel_id, id);

  CREATE TABLE channel_reads (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
  );

  ALTER TABLE notifications ADD COLUMN url TEXT;
  `,

  // v4: video meetings (Jitsi rooms) with shared minutes; action items become tasks.
  `
  CREATE TABLE meetings (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id     INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    title            TEXT NOT NULL,
    room             TEXT NOT NULL UNIQUE,
    started_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    notes            TEXT NOT NULL DEFAULT '',
    notes_updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    notes_updated_at TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at         TEXT
  );
  CREATE INDEX idx_meetings_workspace ON meetings(workspace_id, id DESC);

  ALTER TABLE tasks ADD COLUMN meeting_id INTEGER REFERENCES meetings(id) ON DELETE SET NULL;
  `,
];

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < migrations.length; v++) {
    // Foreign keys must be off while tables are rebuilt; the pragma has no
    // effect inside a transaction, so toggle it around each migration.
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(() => {
        db.exec(migrations[v]);
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`Migration ${v + 1} broke foreign keys`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

migrate();

module.exports = { db, tx };
