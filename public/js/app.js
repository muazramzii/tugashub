// Small progressive enhancements. Every action still works without JavaScript
// except drag and drop, which has the status field on the edit page as a fallback.

// Ask before destructive form submits.
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset.confirm;
  if (msg && !window.confirm(msg)) e.preventDefault();
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

// Kanban drag and drop.
const board = document.querySelector('.board');
if (board) {
  const csrf = board.dataset.csrf;
  let dragging = null;
  let origin = null;

  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.task-card');
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
