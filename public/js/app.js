// Small progressive enhancements. Every action still works without JavaScript
// except drag and drop, which has the status field on the task page as a fallback.

// Ask before destructive form submits.
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset.confirm;
  if (msg && !window.confirm(msg)) e.preventDefault();
});

// Filter forms apply as soon as a select changes; text inputs apply after a pause.
document.querySelectorAll('form[data-autosubmit]').forEach((form) => {
  let timer;
  form.addEventListener('change', (e) => {
    if (e.target.matches('select')) form.requestSubmit();
  });
  form.addEventListener('input', (e) => {
    if (!e.target.matches('input[type="search"]')) return;
    clearTimeout(timer);
    timer = setTimeout(() => form.requestSubmit(), 500);
  });
  // Drop empty fields so URLs stay short and readable.
  form.addEventListener('formdata', (e) => {
    for (const [k, v] of [...e.formData.entries()]) if (v === '') e.formData.delete(k);
  });
});

// Keep the cursor at the end of a pre-filled search box after an auto-submit.
const activeSearch = document.querySelector('form[data-autosubmit] input[type="search"]');
if (activeSearch && activeSearch.value && sessionStorage.getItem('refocus') === location.pathname) {
  activeSearch.focus();
  activeSearch.setSelectionRange(activeSearch.value.length, activeSearch.value.length);
}
document.querySelectorAll('form[data-autosubmit] input[type="search"]').forEach((input) => {
  input.addEventListener('input', () => {
    try { sessionStorage.setItem('refocus', location.pathname); } catch { /* storage blocked */ }
  });
});

// Copy-to-clipboard buttons.
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const input = document.querySelector(btn.dataset.copy);
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    const label = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = label; }, 1500);
  });
});

// Mention chips insert "@name " into the comment box.
document.querySelectorAll('[data-mention]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const box = document.getElementById('comment-body');
    const insert = `@${btn.dataset.mention} `;
    const at = box.selectionStart ?? box.value.length;
    const before = box.value.slice(0, at);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    box.value = before + pad + insert + box.value.slice(at);
    box.focus();
    const pos = (before + pad + insert).length;
    box.setSelectionRange(pos, pos);
  });
});

// Dialogs.
document.querySelectorAll('[data-open]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const dialog = document.getElementById(btn.dataset.open);
    if (btn.dataset.status) {
      const select = dialog.querySelector('select[name="status"]');
      if (select) select.value = btn.dataset.status;
    }
    dialog.showModal();
    dialog.querySelector('input:not([type="hidden"])')?.focus();
  });
});
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
});

// Close the mobile sidebar after choosing a link.
document.querySelectorAll('.sidebar a').forEach((a) => a.addEventListener('click', () => {
  const toggle = document.getElementById('nav-toggle');
  if (toggle) toggle.checked = false;
}));

// Chart tooltips: any element with data-tip, on hover or keyboard focus.
const tip = document.querySelector('.chart-tip');
if (tip) {
  const show = (el) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - t.width - 8, Math.max(8, r.left + r.width / 2 - t.width / 2));
    const top = r.top - t.height - 8 < 8 ? r.bottom + 8 : r.top - t.height - 8;
    tip.style.left = `${left + window.scrollX}px`;
    tip.style.top = `${top + window.scrollY}px`;
  };
  const hide = () => { tip.hidden = true; };
  document.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mouseenter', () => show(el));
    el.addEventListener('focus', () => show(el));
    el.addEventListener('mouseleave', hide);
    el.addEventListener('blur', hide);
  });
}

// ---------------------------------------------------------------------------
// Real-time updates (Socket.IO). Pages work without it; this only adds live updates.
const ME = Number(document.body.dataset.me) || null;
const socket = ME && window.io ? window.io() : null;
window.tugas = { socket, ME, toast, setBadge };

/** Small pop-up message in the corner. */
function toast(text, href) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement(href ? 'a' : 'div');
  el.className = 'toast';
  el.textContent = text;
  if (href) el.href = href;
  box.appendChild(el);
  setTimeout(() => el.classList.add('toast-out'), 4500);
  setTimeout(() => el.remove(), 5000);
}

/** Set (or add to) a number badge; hides it at zero. */
function setBadge(el, value, { add = false } = {}) {
  if (!el) return;
  const n = add ? (Number(el.textContent) || 0) + value : value;
  el.textContent = n > 99 ? '99+' : String(n);
  el.hidden = n <= 0;
}

if (socket) {
  // Who is online: any element with data-presence="<userId>" gets an "online" class.
  const online = new Set();
  const paintPresence = () => {
    document.querySelectorAll('[data-presence]').forEach((el) => {
      el.classList.toggle('online', online.has(Number(el.dataset.presence)));
    });
    const count = document.querySelector('[data-online-count]');
    if (count) count.textContent = online.size;
  };
  socket.on('presence:list', (ids) => { online.clear(); ids.forEach((id) => online.add(id)); online.add(ME); paintPresence(); });
  socket.on('presence', ({ userId, online: on }) => { if (on) online.add(userId); else online.delete(userId); paintPresence(); });

  // Live notifications: bump the bell and show a toast.
  socket.on('notification', ({ message, url }) => {
    const bell = document.querySelector('.bell');
    let count = bell && bell.querySelector('.bell-count');
    if (bell && !count) {
      count = document.createElement('span');
      count.className = 'bell-count';
      count.textContent = '0';
      bell.appendChild(count);
    }
    if (count) count.textContent = String((Number(count.textContent) || 0) + 1);
    toast(message, url);
  });

  // New chat messages elsewhere: bump the sidebar badge (chat.js handles the open channel).
  socket.on('chat:unread', ({ channelId, from }) => {
    if (from === ME) return;
    const chatPage = document.getElementById('chat');
    const viewing = chatPage && Number(chatPage.dataset.channel) === channelId;
    if (viewing && !document.hidden) return;
    setBadge(document.querySelector('[data-chat-badge]'), 1, { add: true });
    if (!viewing) setBadge(document.querySelector(`[data-unread="${channelId}"]`), 1, { add: true });
  });
}

// Kanban drag and drop.
const board = document.querySelector('.board');
if (board) {
  const csrf = board.dataset.csrf;
  let dragging = null;
  let origin = null;
  let refreshPending = false;

  // Live board: when a teammate changes something, reload the columns in place.
  if (socket) {
    socket.on('connect', () => socket.emit('board:join', board.dataset.project));
    socket.on('board:changed', ({ by, byName }) => {
      if (by === ME) return;
      if (dragging) { refreshPending = true; return; }
      refreshBoard().then(() => toast(`${byName} updated the board`));
    });
  }

  async function refreshBoard() {
    const res = await fetch(location.href, { headers: { Accept: 'text/html' } });
    if (!res.ok) return;
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const fresh = doc.querySelector('.board');
    if (fresh) board.innerHTML = fresh.innerHTML;
    const hint = doc.querySelector('.board-hint');
    if (hint) document.querySelector('.board-hint').innerHTML = hint.innerHTML;
    // Re-bind the "+ Add task" buttons inside the columns.
    board.querySelectorAll('[data-open]').forEach((btn) => btn.addEventListener('click', () => {
      const dialog = document.getElementById(btn.dataset.open);
      const select = dialog.querySelector('select[name="status"]');
      if (select && btn.dataset.status) select.value = btn.dataset.status;
      dialog.showModal();
    }));
  }

  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.task-card[draggable="true"]');
    if (!card) return;
    dragging = card;
    origin = { list: card.parentElement, next: card.nextElementSibling };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.id);
    requestAnimationFrame(() => card.classList.add('dragging'));
  });

  board.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    board.querySelectorAll('.column').forEach((c) => c.classList.remove('drop-target'));
    dragging = null;
    if (refreshPending) {
      refreshPending = false;
      setTimeout(refreshBoard, 300); // after our own move has been saved
    }
  });

  board.addEventListener('dragover', (e) => {
    const column = e.target.closest('.column');
    if (!dragging || !column) return;
    e.preventDefault();
    board.querySelectorAll('.column').forEach((c) => c.classList.toggle('drop-target', c === column));
    const list = column.querySelector('.cards');
    const after = cardAfter(list, e.clientY);
    if (after) list.insertBefore(dragging, after);
    else list.appendChild(dragging);
  });

  board.addEventListener('drop', async (e) => {
    const column = e.target.closest('.column');
    if (!dragging || !column) return;
    e.preventDefault();
    const card = dragging;
    const list = column.querySelector('.cards');
    const status = column.dataset.status;
    const index = [...list.children].indexOf(card);
    card.classList.toggle('is-done', status === 'done');
    updateCounts();

    try {
      const res = await fetch(`/tasks/${card.dataset.id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ status, index }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      // Put the card back where it was and tell the user.
      origin.list.insertBefore(card, origin.next);
      card.classList.toggle('is-done', origin.list.closest('.column').dataset.status === 'done');
      updateCounts();
      alert('Could not move the task. Refresh the page and try again.');
    }
  });

  function cardAfter(list, y) {
    const cards = [...list.querySelectorAll('.task-card:not(.dragging)')];
    return cards.find((c) => {
      const box = c.getBoundingClientRect();
      return y < box.top + box.height / 2;
    });
  }

  function updateCounts() {
    board.querySelectorAll('.column').forEach((col) => {
      col.querySelector('.count').textContent = col.querySelectorAll('.task-card').length;
    });
  }
}
