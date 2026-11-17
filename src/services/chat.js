const { db, tx } = require('../db');
const realtime = require('../realtime');
const { notify, findMentions, renderComment } = require('./activity');

const PAGE = 50;

const q = {
  ensureGeneral: db.prepare(`
    INSERT INTO channels (workspace_id, kind, name) SELECT ?, 'general', 'general'
    WHERE NOT EXISTS (SELECT 1 FROM channels WHERE workspace_id = ? AND kind = 'general')`),
  ensureProjects: db.prepare(`
    INSERT INTO channels (workspace_id, kind, name, project_id)
    SELECT p.workspace_id, 'project', p.name, p.id FROM projects p
    WHERE p.workspace_id = ? AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.project_id = p.id)`),
  general: db.prepare("SELECT id FROM channels WHERE workspace_id = ? AND kind = 'general'"),
  channel: db.prepare(`
    SELECT c.*, p.name AS project_name, p.color AS project_color, p.archived_at,
           ua.name AS a_name, ub.name AS b_name
    FROM channels c
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN users ua ON ua.id = c.user_a
    LEFT JOIN users ub ON ub.id = c.user_b
    WHERE c.id = ? AND c.workspace_id = ?`),
  channels: db.prepare(`
    SELECT c.*, p.name AS project_name, p.color AS project_color,
      (SELECT COUNT(*) FROM messages m
        WHERE m.channel_id = c.id AND m.id > COALESCE(r.last_read_id, 0)
          AND (m.user_id IS NULL OR m.user_id != :me) AND m.created_at >= :since) AS unread
    FROM channels c
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = :me
    WHERE c.workspace_id = :ws
      AND (c.kind != 'direct' OR :me IN (c.user_a, c.user_b))
      AND (p.id IS NULL OR p.archived_at IS NULL)
    ORDER BY c.kind = 'general' DESC, c.kind = 'project' DESC, p.name COLLATE NOCASE`),
  unreadTotal: db.prepare(`
    SELECT COUNT(*) AS n FROM messages m
    JOIN channels c ON c.id = m.channel_id
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = :me
    WHERE c.workspace_id = :ws
      AND (c.kind != 'direct' OR :me IN (c.user_a, c.user_b))
      AND (p.id IS NULL OR p.archived_at IS NULL)
      AND m.id > COALESCE(r.last_read_id, 0)
      AND (m.user_id IS NULL OR m.user_id != :me)
      AND m.created_at >= :since`),
  userSince: db.prepare('SELECT created_at FROM users WHERE id = ?'),
  member: db.prepare('SELECT id, name FROM users WHERE id = ? AND workspace_id = ?'),
  members: db.prepare('SELECT id, name, role FROM users WHERE workspace_id = ? ORDER BY name COLLATE NOCASE'),
  findDm: db.prepare('SELECT id FROM channels WHERE workspace_id = ? AND user_a = ? AND user_b = ?'),
  createDm: db.prepare("INSERT INTO channels (workspace_id, kind, user_a, user_b) VALUES (?, 'direct', ?, ?)"),
  latest: db.prepare(`
    SELECT m.*, u.name AS user_name FROM messages m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT ?`),
  before: db.prepare(`
    SELECT m.*, u.name AS user_name FROM messages m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`),
  message: db.prepare(`
    SELECT m.*, c.workspace_id, u.name AS user_name FROM messages m
    JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.user_id
    WHERE m.id = ?`),
  insert: db.prepare('INSERT INTO messages (channel_id, user_id, body) VALUES (?, ?, ?)'),
  remove: db.prepare('DELETE FROM messages WHERE id = ?'),
  maxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = ?'),
  markRead: db.prepare(`
    INSERT INTO channel_reads (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
    ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`),
};

/** Make sure the workspace has #general and one channel per project. */
function ensureChannels(workspaceId) {
  q.ensureGeneral.run(workspaceId, workspaceId);
  q.ensureProjects.run(workspaceId);
}

function generalChannelId(workspaceId) {
  ensureChannels(workspaceId);
  return q.general.get(workspaceId).id;
}

/** Return a channel if this user may see it, otherwise null. */
function channelFor(user, channelId) {
  const c = q.channel.get(channelId, user.workspace_id);
  if (!c) return null;
  if (c.kind === 'direct' && c.user_a !== user.id && c.user_b !== user.id) return null;
  return decorate(c, user);
}

/** Add a display title (and the other person, for DMs). */
function decorate(c, user) {
  if (c.kind === 'general') c.title = '# general';
  else if (c.kind === 'project') c.title = `# ${c.project_name}`;
  else {
    c.other_id = c.user_a === user.id ? c.user_b : c.user_a;
    c.title = c.user_a === user.id ? c.b_name : c.a_name;
  }
  return c;
}

function since(user) {
  return q.userSince.get(user.id).created_at;
}

/** Channels for the sidebar: general + projects, then one DM row per teammate. */
function sidebar(user) {
  ensureChannels(user.workspace_id);
  const rows = q.channels.all({ me: user.id, ws: user.workspace_id, since: since(user) });
  const dms = new Map();
  const rooms = [];
  for (const c of rows) {
    if (c.kind === 'direct') dms.set(c.user_a === user.id ? c.user_b : c.user_a, c);
    else rooms.push(decorate(c, user));
  }
  const people = q.members.all(user.workspace_id)
    .filter((m) => m.id !== user.id)
    .map((m) => ({ ...m, channel_id: dms.get(m.id)?.id || null, unread: dms.get(m.id)?.unread || 0 }));
  return { rooms, people };
}

function unreadTotal(user) {
  return q.unreadTotal.get({ me: user.id, ws: user.workspace_id, since: since(user) }).n;
}

/** Find or create the direct-message channel between two members. */
function directChannel(user, otherId) {
  const other = q.member.get(otherId, user.workspace_id);
  if (!other || other.id === user.id) return null;
  const [a, b] = user.id < other.id ? [user.id, other.id] : [other.id, user.id];
  const existing = q.findDm.get(user.workspace_id, a, b);
  if (existing) return existing.id;
  return Number(q.createDm.run(user.workspace_id, a, b).lastInsertRowid);
}

/** Messages oldest-first, with safe HTML. Returns { messages, hasOlder }. */
function messages(channel, members, beforeId = null) {
  const rows = beforeId ? q.before.all(channel.id, beforeId, PAGE + 1) : q.latest.all(channel.id, PAGE + 1);
  const hasOlder = rows.length > PAGE;
  return { messages: rows.slice(0, PAGE).reverse().map((m) => toDto(m, members)), hasOlder };
}

function toDto(m, members) {
  return { ...m, html: renderComment(m.body, members) };
}

function markRead(user, channelId, upTo = null) {
  const id = upTo || q.maxId.get(channelId).id;
  q.markRead.run(user.id, channelId, id);
}

/** Store a message, notify mentioned people, and push it to everyone allowed to see it. */
function send(user, channel, body) {
  const members = q.members.all(user.workspace_id);
  const message = tx(() => {
    const id = Number(q.insert.run(channel.id, user.id, body).lastInsertRowid);
    q.markRead.run(user.id, channel.id, id);
    const where = channel.kind === 'direct' ? 'your direct messages' : channel.title.replace('# ', '#');
    for (const m of findMentions(body, user.workspace_id)) {
      // In a DM only the other person can read it, so only they can be notified.
      if (channel.kind === 'direct' && m.id !== channel.other_id) continue;
      notify({ userId: m.id, actorId: user.id, kind: 'mention', url: `/chat/${channel.id}`,
        message: `${user.name} mentioned you in ${where}` });
    }
    return toDto(q.message.get(id), members);
  });
  return message;
}

/** Ping everyone who can see the channel so their unread badges update. */
function announce(channel, message, html) {
  realtime.toChannel(channel.id, 'message:new', { id: message.id, channelId: channel.id, userId: message.user_id, html });
  const ping = { channelId: channel.id, from: message.user_id };
  if (channel.kind === 'direct') {
    realtime.toUser(channel.user_a, 'chat:unread', ping);
    realtime.toUser(channel.user_b, 'chat:unread', ping);
  } else {
    realtime.toWorkspace(channel.workspace_id, 'chat:unread', ping);
  }
}

function getMessage(id) {
  return q.message.get(id);
}

function deleteMessage(message) {
  q.remove.run(message.id);
  realtime.toChannel(message.channel_id, 'message:deleted', { id: message.id });
}

module.exports = {
  ensureChannels, generalChannelId, channelFor, sidebar, unreadTotal, directChannel,
  messages, markRead, send, announce, getMessage, deleteMessage,
};
