// Real-time layer (Socket.IO). The server only PUSHES updates over the socket;
// every change (sending a message, moving a task) still goes through a normal
// HTTP route with CSRF protection and permission checks.
//
// Rooms:
//   ws:<workspaceId>   everyone in a workspace (presence, unread pings)
//   user:<userId>      one person's tabs (notifications, DM pings)
//   channel:<id>       people viewing a chat channel
//   project:<id>       people viewing a project's board
const { Server } = require('socket.io');
const { db } = require('./db');

let io = null;
const online = new Map(); // workspaceId -> Map(userId -> open socket count)

const q = {
  user: db.prepare('SELECT id, name, role, workspace_id FROM users WHERE id = ?'),
  project: db.prepare('SELECT id FROM projects WHERE id = ? AND workspace_id = ?'),
};

/** Only accept sockets from our own pages (blocks cross-site WebSocket hijacking). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients do not send cookies cross-site
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function attachRealtime(httpServer, sessionMiddleware) {
  io = new Server(httpServer, {
    allowRequest: (req, cb) => cb(null, sameOrigin(req)),
  });
  io.engine.use(sessionMiddleware);

  io.use((socket, next) => {
    const userId = socket.request.session && socket.request.session.userId;
    const user = userId && q.user.get(userId);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  // Loaded here to avoid a require cycle (the chat service emits through this module).
  const { channelFor } = require('./services/chat');

  io.on('connection', (socket) => {
    const user = socket.data.user;
    const ws = user.workspace_id;
    socket.join(`ws:${ws}`);
    socket.join(`user:${user.id}`);

    if (!online.has(ws)) online.set(ws, new Map());
    const people = online.get(ws);
    const count = (people.get(user.id) || 0) + 1;
    people.set(user.id, count);
    if (count === 1) socket.to(`ws:${ws}`).emit('presence', { userId: user.id, online: true });
    socket.emit('presence:list', [...people.keys()]);

    // The optional ack callback tells the client whether it was allowed in.
    socket.on('channel:join', (id, ack) => {
      const channel = channelFor(user, Number(id));
      if (channel) {
        for (const room of socket.rooms) if (room.startsWith('channel:')) socket.leave(room);
        socket.join(`channel:${channel.id}`);
      }
      if (typeof ack === 'function') ack(Boolean(channel));
    });

    socket.on('typing', (id) => {
      const room = `channel:${Number(id)}`;
      if (socket.rooms.has(room)) socket.to(room).emit('typing', { channelId: Number(id), userId: user.id, name: user.name });
    });

    socket.on('board:join', (id, ack) => {
      const ok = Boolean(q.project.get(Number(id), ws));
      if (ok) socket.join(`project:${Number(id)}`);
      if (typeof ack === 'function') ack(ok);
    });

    socket.on('disconnect', () => {
      const left = (people.get(user.id) || 1) - 1;
      if (left > 0) return people.set(user.id, left);
      people.delete(user.id);
      io.to(`ws:${ws}`).emit('presence', { userId: user.id, online: false });
    });
  });
  return io;
}

/**
 * Send an event to a room. Deferred to the next tick so it fires after the
 * current database transaction has committed, never for rolled-back work.
 */
function emit(room, event, payload) {
  if (!io) return;
  setImmediate(() => io.to(room).emit(event, payload));
}

const toUser = (userId, event, payload) => emit(`user:${userId}`, event, payload);
const toWorkspace = (workspaceId, event, payload) => emit(`ws:${workspaceId}`, event, payload);
const toChannel = (channelId, event, payload) => emit(`channel:${channelId}`, event, payload);

/** Tell everyone looking at a board that it changed, and who changed it. */
function boardChanged(projectId, user) {
  emit(`project:${projectId}`, 'board:changed', { projectId, by: user.id, byName: user.name });
}

/** Disconnect a removed member's open tabs so they stop receiving updates. */
function kickUser(userId) {
  if (io) setImmediate(() => io.in(`user:${userId}`).disconnectSockets(true));
}

function onlineIds(workspaceId) {
  return [...(online.get(workspaceId) || new Map()).keys()];
}

module.exports = { attachRealtime, emit, toUser, toWorkspace, toChannel, boardChanged, kickUser, onlineIds };
