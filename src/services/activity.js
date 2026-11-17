const { db } = require('../db');
const realtime = require('../realtime');

const insertActivity = db.prepare(`
  INSERT INTO activity (workspace_id, user_id, project_id, task_id, action, summary)
  VALUES (?, ?, ?, ?, ?, ?)`);
const insertNotification = db.prepare(`
  INSERT INTO notifications (user_id, actor_id, task_id, kind, message, url) VALUES (?, ?, ?, ?, ?, ?)`);
const membersOf = db.prepare('SELECT id, name FROM users WHERE workspace_id = ?');

const quote = (s) => `“${s}”`;

/**
 * Record something that happened in a workspace.
 * summary reads after the actor's name, e.g. 'moved “Fix login” to Done'.
 */
function logActivity({ workspaceId, userId = null, projectId = null, taskId = null, action, summary }) {
  insertActivity.run(workspaceId, userId, projectId, taskId, action, summary);
}

/** Notify a user (unless they caused the event themselves) and ping their open tabs. */
function notify({ userId, actorId, taskId = null, kind, message, url = null }) {
  if (!userId || userId === actorId) return;
  const id = Number(insertNotification.run(userId, actorId, taskId, kind, message, url).lastInsertRowid);
  realtime.toUser(userId, 'notification', { message, url: `/notifications/${id}` });
}

/** Handle a member can be @mentioned by: their first name, lower-case. */
function mentionHandle(name) {
  return name.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

/** Find the members mentioned in text like "thanks @farid and @mei". */
function findMentions(text, workspaceId) {
  const handles = new Set([...text.matchAll(/(^|[^\w@])@([a-z0-9._-]+)/gi)].map((m) => m[2].toLowerCase()));
  if (!handles.size) return [];
  return membersOf.all(workspaceId).filter((m) => handles.has(mentionHandle(m.name)));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Escape a comment and highlight @mentions of real members. Safe to output raw. */
function renderComment(body, members) {
  const handles = new Set(members.map((m) => mentionHandle(m.name)));
  return escapeHtml(body)
    .replace(/(^|[^\w@])@([a-z0-9._-]+)/gi, (all, pre, h) =>
      handles.has(h.toLowerCase()) ? `${pre}<span class="mention">@${h}</span>` : all)
    .replace(/\n/g, '<br>');
}

module.exports = { logActivity, notify, findMentions, mentionHandle, renderComment, escapeHtml, quote };
