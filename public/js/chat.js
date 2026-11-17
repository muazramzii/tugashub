// Chat page: send messages, receive them live, typing indicator, load older history.
(() => {
  const root = document.getElementById('chat');
  if (!root) return;
  const { socket, ME, setBadge } = window.tugas;
  const channelId = Number(root.dataset.channel);
  const csrf = root.dataset.csrf;
  const isAdmin = root.dataset.admin === '1';
  const scroller = document.getElementById('chat-scroll');
  const list = document.getElementById('msg-list');
  const empty = document.getElementById('chat-empty');
  const form = document.getElementById('composer');
  const input = document.getElementById('composer-input');
  const typingEl = document.getElementById('typing');
  const newBelow = document.getElementById('new-below');
  let olderBtn = document.getElementById('load-older');
  let unseen = 0; // messages that arrived while the tab was hidden

  const post = (url, data) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify(data),
  });

  // ---- Layout helpers ----
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; newBelow.hidden = true; };

  function dayLabel(key) {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - date) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return date.toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  /** Rebuild day separators, group consecutive messages, and show delete buttons. */
  function normalize() {
    list.querySelectorAll('.day-sep').forEach((el) => el.remove());
    let prev = null;
    for (const msg of list.querySelectorAll('.msg')) {
      if (!prev || prev.dataset.day !== msg.dataset.day) {
        const sep = document.createElement('li');
        sep.className = 'day-sep';
        sep.innerHTML = '<span></span>';
        sep.firstChild.textContent = dayLabel(msg.dataset.day);
        list.insertBefore(sep, msg);
      }
      const close = prev && prev.dataset.user === msg.dataset.user && prev.dataset.day === msg.dataset.day &&
        new Date(msg.dataset.ts) - new Date(prev.dataset.ts) < 5 * 60e3;
      msg.classList.toggle('msg-cont', Boolean(close));
      const del = msg.querySelector('[data-delete-msg]');
      if (del) del.hidden = !(Number(msg.dataset.user) === ME || isAdmin);
      prev = msg;
    }
    empty.hidden = Boolean(list.querySelector('.msg'));
  }

  /** Insert server-rendered message HTML, skipping any we already have. */
  function addMessages(html, { prepend = false } = {}) {
    const tmp = document.createElement('ol');
    tmp.innerHTML = html;
    const fresh = [...tmp.querySelectorAll('.msg')].filter((m) => !document.getElementById(m.id));
    if (prepend) list.prepend(...fresh);
    else list.append(...fresh);
    normalize();
    return fresh.length;
  }

  function markRead() {
    const last = [...list.querySelectorAll('.msg')].pop();
    post(`/chat/${channelId}/read`, { lastId: last ? Number(last.dataset.id) : 0 }).catch(() => {});
  }

  // ---- Sending ----
  async function send() {
    const body = input.value.trim();
    if (!body) return;
    input.disabled = true;
    try {
      const res = await post(`/chat/${channelId}/messages`, { body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send');
      input.value = '';
      autosize();
      addMessages(data.html);
      toBottom();
    } catch (err) {
      window.tugas.toast(err.message || 'Could not send the message. Check your connection.');
    } finally {
      input.disabled = false;
      input.focus();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  let lastTyping = 0;
  input.addEventListener('input', () => {
    autosize();
    if (socket && Date.now() - lastTyping > 1500) {
      lastTyping = Date.now();
      socket.emit('typing', channelId);
    }
  });

  // ---- Deleting ----
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-delete-msg]');
    if (!btn || !window.confirm('Delete this message?')) return;
    const res = await post(`/chat/messages/${btn.dataset.deleteMsg}/delete`, {});
    if (res.ok) {
      document.getElementById(`m${btn.dataset.deleteMsg}`)?.remove();
      normalize();
    }
  });

  // ---- Older history ----
  async function loadOlder() {
    const first = list.querySelector('.msg');
    if (!first || !olderBtn) return;
    olderBtn.disabled = true;
    const res = await fetch(`/chat/${channelId}/messages?before=${first.dataset.id}`, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    const height = scroller.scrollHeight;
    addMessages(data.html, { prepend: true });
    scroller.scrollTop += scroller.scrollHeight - height; // keep the view steady
    if (!data.hasOlder) {
      olderBtn.remove();
      olderBtn = null;
    } else {
      olderBtn.disabled = false;
    }
  }
  if (olderBtn) olderBtn.addEventListener('click', loadOlder);

  newBelow.addEventListener('click', toBottom);
  scroller.addEventListener('scroll', () => { if (nearBottom()) newBelow.hidden = true; });

  // ---- Typing indicator ----
  const typists = new Map(); // userId -> { name, timer }
  function paintTyping() {
    const names = [...typists.values()].map((t) => t.name.split(' ')[0]);
    typingEl.textContent = names.length === 0 ? ''
      : names.length === 1 ? `${names[0]} is typing…`
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing…`;
  }

  // ---- Live updates ----
  if (socket) {
    socket.on('connect', () => socket.emit('channel:join', channelId));
    socket.on('message:new', (m) => {
      if (m.channelId !== channelId) return;
      const stick = nearBottom();
      if (!addMessages(m.html)) return;
      const t = typists.get(m.userId);
      if (t) { clearTimeout(t.timer); typists.delete(m.userId); paintTyping(); }
      if (m.userId === ME) return toBottom();
      if (stick) toBottom();
      else newBelow.hidden = false;
      if (document.hidden) unseen++;
      else markRead();
    });
    socket.on('message:deleted', ({ id }) => {
      document.getElementById(`m${id}`)?.remove();
      normalize();
    });
    socket.on('typing', ({ channelId: id, userId, name }) => {
      if (id !== channelId || userId === ME) return;
      const old = typists.get(userId);
      if (old) clearTimeout(old.timer);
      typists.set(userId, { name, timer: setTimeout(() => { typists.delete(userId); paintTyping(); }, 3500) });
      paintTyping();
    });
  }

  // Coming back to the tab: everything here is now read.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !unseen) return;
    setBadge(document.querySelector('[data-chat-badge]'), -unseen, { add: true });
    unseen = 0;
    markRead();
  });

  normalize();
  autosize();
  toBottom();
  input.focus();
})();
