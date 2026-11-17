const express = require('express');
const { db } = require('../db');
const { requireAuth, setFlash } = require('../middleware');
const { atLeast } = require('../permissions');
const chat = require('../services/chat');
const { onlineIds } = require('../realtime');

const router = express.Router();
router.use(requireAuth);

const members = db.prepare('SELECT id, name FROM users WHERE workspace_id = ?');
const wantsJson = (req) => req.is('json') || (req.get('accept') || '').includes('application/json');

/** Render the message-list partial to a string (used for live pushes and "load older"). */
function renderMessages(req, list) {
  return new Promise((resolve, reject) => {
    req.app.render('partials/messages', { messages: list }, (err, html) => (err ? reject(err) : resolve(html)));
  });
}

function loadChannel(req, res, next) {
  const channel = chat.channelFor(req.user, Number(req.params.id));
  if (!channel) {
    if (wantsJson(req)) return res.status(404).json({ error: 'Channel not found' });
    return res.status(404).render('error', { title: 'Not found', message: 'That conversation does not exist or is private.' });
  }
  req.channel = channel;
  next();
}

router.get('/chat', (req, res) => {
  res.redirect(`/chat/${chat.generalChannelId(req.workspace.id)}`);
});

router.get('/chat/dm/:userId', (req, res) => {
  const id = chat.directChannel(req.user, Number(req.params.userId));
  if (!id) return res.redirect('/chat');
  res.redirect(`/chat/${id}`);
});

router.get('/chat/:id', loadChannel, (req, res) => {
  const { messages, hasOlder } = chat.messages(req.channel, members.all(req.workspace.id));
  chat.markRead(req.user, req.channel.id);
  const { rooms, people } = chat.sidebar(req.user);
  res.locals.chatUnread = chat.unreadTotal(req.user); // reflect what we just marked read
  res.render('chat', {
    title: req.channel.title,
    channel: req.channel,
    messages,
    hasOlder,
    rooms,
    people,
    online: new Set(onlineIds(req.workspace.id)),
    isAdmin: atLeast(req.user, 'admin'),
  });
});

// Older messages for infinite scroll.
router.get('/chat/:id/messages', loadChannel, async (req, res, next) => {
  try {
    const before = Number.parseInt(req.query.before, 10);
    if (!before) return res.status(400).json({ error: 'before is required' });
    const { messages, hasOlder } = chat.messages(req.channel, members.all(req.workspace.id), before);
    res.json({ html: await renderMessages(req, messages), hasOlder, count: messages.length });
  } catch (err) {
    next(err);
  }
});

router.post('/chat/:id/messages', loadChannel, async (req, res, next) => {
  try {
    const body = String(req.body.body || '').trim();
    if (!body || body.length > 2000) {
      const error = 'Messages need 1 to 2000 characters.';
      if (wantsJson(req)) return res.status(400).json({ error });
      setFlash(req, 'error', error);
      return res.redirect(`/chat/${req.channel.id}`);
    }
    const message = chat.send(req.user, req.channel, body);
    const html = await renderMessages(req, [message]);
    chat.announce(req.channel, message, html);
    if (wantsJson(req)) return res.status(201).json({ id: message.id, html });
    res.redirect(`/chat/${req.channel.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/chat/:id/read', loadChannel, (req, res) => {
  const upTo = Number.parseInt(req.body.lastId, 10) || null;
  chat.markRead(req.user, req.channel.id, upTo);
  res.json({ ok: true });
});

router.post('/chat/messages/:messageId/delete', (req, res) => {
  const message = chat.getMessage(Number(req.params.messageId));
  const channel = message && chat.channelFor(req.user, message.channel_id);
  if (!channel) return res.status(404).json({ error: 'Message not found' });
  if (message.user_id !== req.user.id && !atLeast(req.user, 'admin')) {
    return res.status(403).json({ error: 'You can only delete your own messages.' });
  }
  chat.deleteMessage(message);
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect(`/chat/${channel.id}`);
});

module.exports = { router };
