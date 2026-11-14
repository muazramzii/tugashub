const express = require('express');
const bcrypt = require('bcryptjs');
const { db, tx } = require('../db');
const { PLANS, planFor } = require('../plans');
const { requireAuth, requireOwner, setFlash } = require('../middleware');
const { newInviteCode } = require('./auth');

const router = express.Router();
router.use(requireAuth);

const q = {
  members: db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.created_at,
           (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status != 'done') AS open_tasks
    FROM users u WHERE u.workspace_id = ?
    ORDER BY u.role = 'owner' DESC, u.name`),
  member: db.prepare('SELECT * FROM users WHERE id = ? AND workspace_id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  setInvite: db.prepare('UPDATE workspaces SET invite_code = ? WHERE id = ?'),
  projectCount: db.prepare('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?'),
  memberCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE workspace_id = ?'),
  setPlan: db.prepare('UPDATE workspaces SET plan = ? WHERE id = ?'),
  addBilling: db.prepare('INSERT INTO billing_events (workspace_id, action, plan, amount) VALUES (?, ?, ?, ?)'),
  billingHistory: db.prepare('SELECT * FROM billing_events WHERE workspace_id = ? ORDER BY id DESC LIMIT 20'),
  renameWorkspace: db.prepare('UPDATE workspaces SET name = ? WHERE id = ?'),
  renameUser: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  userHash: db.prepare('SELECT password_hash FROM users WHERE id = ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
};

// ---- Team ----
router.get('/team', (req, res) => {
  res.render('team', {
    title: 'Team',
    members: q.members.all(req.workspace.id),
    inviteUrl: `${req.protocol}://${req.get('host')}/signup?invite=${req.workspace.invite_code}`,
  });
});

router.post('/team/invite/reset', requireOwner, (req, res) => {
  q.setInvite.run(newInviteCode(), req.workspace.id);
  setFlash(req, 'success', 'New invite link created. The old link no longer works.');
  res.redirect('/team');
});

router.post('/team/:userId/remove', requireOwner, (req, res) => {
  const member = q.member.get(Number(req.params.userId), req.workspace.id);
  if (!member) {
    setFlash(req, 'error', 'That person is not in your workspace.');
  } else if (member.role === 'owner') {
    setFlash(req, 'error', 'The owner cannot be removed.');
  } else {
    q.deleteUser.run(member.id);
    setFlash(req, 'success', `${member.name} was removed. Their tasks are now unassigned.`);
  }
  res.redirect('/team');
});

// ---- Billing ----
function usage(workspaceId) {
  return {
    projects: q.projectCount.get(workspaceId).n,
    members: q.memberCount.get(workspaceId).n,
  };
}

router.get('/billing', (req, res) => {
  res.render('billing', {
    title: 'Billing',
    plans: PLANS,
    usage: usage(req.workspace.id),
    history: q.billingHistory.all(req.workspace.id),
  });
});

router.post('/billing/upgrade', requireOwner, (req, res) => {
  if (req.workspace.plan === 'pro') return res.redirect('/billing');
  tx(() => {
    q.setPlan.run('pro', req.workspace.id);
    q.addBilling.run(req.workspace.id, 'upgrade', 'pro', PLANS.pro.price);
  });
  setFlash(req, 'success', 'You are now on Pro. Projects and members are unlimited.');
  res.redirect('/billing');
});

router.post('/billing/downgrade', requireOwner, (req, res) => {
  if (req.workspace.plan === 'free') return res.redirect('/billing');
  const u = usage(req.workspace.id);
  const free = PLANS.free;
  if (u.projects > free.maxProjects || u.members > free.maxMembers) {
    setFlash(req, 'error',
      `To move to Free you need at most ${free.maxProjects} projects and ${free.maxMembers} members. ` +
      `You have ${u.projects} projects and ${u.members} members.`);
    return res.redirect('/billing');
  }
  tx(() => {
    q.setPlan.run('free', req.workspace.id);
    q.addBilling.run(req.workspace.id, 'downgrade', 'free', 0);
  });
  setFlash(req, 'success', 'Your workspace is now on the Free plan.');
  res.redirect('/billing');
});

// ---- Settings ----
router.get('/settings', (req, res) => {
  res.render('settings', { title: 'Settings' });
});

router.post('/settings/profile', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name || name.length > 80) setFlash(req, 'error', 'Enter your name.');
  else {
    q.renameUser.run(name, req.user.id);
    setFlash(req, 'success', 'Profile saved.');
  }
  res.redirect('/settings');
});

router.post('/settings/workspace', requireOwner, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name || name.length > 80) setFlash(req, 'error', 'Enter a workspace name.');
  else {
    q.renameWorkspace.run(name, req.workspace.id);
    setFlash(req, 'success', 'Workspace renamed.');
  }
  res.redirect('/settings');
});

router.post('/settings/password', (req, res) => {
  const { current = '', next = '' } = req.body;
  if (!bcrypt.compareSync(current, q.userHash.get(req.user.id).password_hash)) {
    setFlash(req, 'error', 'Your current password is incorrect.');
  } else if (next.length < 8) {
    setFlash(req, 'error', 'New password must be at least 8 characters.');
  } else {
    q.setPassword.run(bcrypt.hashSync(next, 10), req.user.id);
    setFlash(req, 'success', 'Password changed.');
  }
  res.redirect('/settings');
});

module.exports = { router, planFor };
