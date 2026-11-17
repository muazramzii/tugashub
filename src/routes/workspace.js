const express = require('express');
const bcrypt = require('bcryptjs');
const { db, tx } = require('../db');
const { PLANS } = require('../plans');
const { ROLE_LABELS, can } = require('../permissions');
const { requireAuth, requireRole, setFlash } = require('../middleware');
const { logActivity, mentionHandle } = require('../services/activity');
const { newInviteCode } = require('./auth');
const { kickUser } = require('../realtime');

const router = express.Router();
router.use(requireAuth);

const LABEL_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

const q = {
  members: db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.created_at,
      (SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.assignee_id = u.id AND t.status != 'done' AND p.archived_at IS NULL) AS open_tasks
    FROM users u WHERE u.workspace_id = ?
    ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name`),
  member: db.prepare('SELECT * FROM users WHERE id = ? AND workspace_id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  setInvite: db.prepare('UPDATE workspaces SET invite_code = ? WHERE id = ?'),
  projectCount: db.prepare('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND archived_at IS NULL'),
  memberCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE workspace_id = ?'),
  setPlan: db.prepare('UPDATE workspaces SET plan = ? WHERE id = ?'),
  addBilling: db.prepare('INSERT INTO billing_events (workspace_id, action, plan, amount) VALUES (?, ?, ?, ?)'),
  billingHistory: db.prepare('SELECT * FROM billing_events WHERE workspace_id = ? ORDER BY id DESC LIMIT 20'),
  renameWorkspace: db.prepare('UPDATE workspaces SET name = ? WHERE id = ?'),
  renameUser: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  userHash: db.prepare('SELECT password_hash FROM users WHERE id = ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  labels: db.prepare(`
    SELECT l.*, (SELECT COUNT(*) FROM task_labels tl WHERE tl.label_id = l.id) AS uses
    FROM labels l WHERE l.workspace_id = ? ORDER BY l.name COLLATE NOCASE`),
  label: db.prepare('SELECT * FROM labels WHERE id = ? AND workspace_id = ?'),
  labelByName: db.prepare('SELECT id FROM labels WHERE workspace_id = ? AND name = ? COLLATE NOCASE'),
  addLabel: db.prepare('INSERT INTO labels (workspace_id, name, color) VALUES (?, ?, ?)'),
  deleteLabel: db.prepare('DELETE FROM labels WHERE id = ?'),
};

// ---- Team ----
router.get('/team', (req, res) => {
  res.render('team', {
    title: 'Team',
    members: q.members.all(req.workspace.id),
    inviteUrl: `${req.protocol}://${req.get('host')}/signup?invite=${req.workspace.invite_code}`,
    ROLE_LABELS,
    mentionHandle,
  });
});

router.post('/team/invite/reset', requireRole('admin'), (req, res) => {
  q.setInvite.run(newInviteCode(), req.workspace.id);
  setFlash(req, 'success', 'New invite link created. The old link no longer works.');
  res.redirect('/team');
});

router.post('/team/:userId/role', requireRole('owner'), (req, res) => {
  const member = q.member.get(Number(req.params.userId), req.workspace.id);
  const role = req.body.role;
  if (!member || member.role === 'owner' || !['admin', 'member'].includes(role)) {
    setFlash(req, 'error', 'That role change is not allowed.');
  } else if (member.role !== role) {
    q.setRole.run(role, member.id);
    logActivity({ workspaceId: req.workspace.id, userId: req.user.id, action: 'member.role',
      summary: `made ${member.name} ${role === 'admin' ? 'an admin' : 'a member'}` });
    setFlash(req, 'success', `${member.name} is now ${role === 'admin' ? 'an admin' : 'a member'}.`);
  }
  res.redirect('/team');
});

router.post('/team/:userId/remove', requireRole('admin'), (req, res) => {
  const member = q.member.get(Number(req.params.userId), req.workspace.id);
  if (!member) {
    setFlash(req, 'error', 'That person is not in your workspace.');
  } else if (!can.removeMember(req.user, member)) {
    setFlash(req, 'error', `You can't remove ${member.name}.`);
  } else {
    tx(() => {
      q.deleteUser.run(member.id);
      logActivity({ workspaceId: req.workspace.id, userId: req.user.id, action: 'member.removed', summary: `removed ${member.name} from the workspace` });
    });
    kickUser(member.id);
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

router.post('/billing/upgrade', requireRole('owner'), (req, res) => {
  if (req.workspace.plan === 'pro') return res.redirect('/billing');
  tx(() => {
    q.setPlan.run('pro', req.workspace.id);
    q.addBilling.run(req.workspace.id, 'upgrade', 'pro', PLANS.pro.price);
    logActivity({ workspaceId: req.workspace.id, userId: req.user.id, action: 'plan.upgraded', summary: 'upgraded the workspace to Pro' });
  });
  setFlash(req, 'success', 'You are now on Pro. Reports, CSV export and unlimited projects are unlocked.');
  res.redirect('/billing');
});

router.post('/billing/downgrade', requireRole('owner'), (req, res) => {
  if (req.workspace.plan === 'free') return res.redirect('/billing');
  const u = usage(req.workspace.id);
  const free = PLANS.free;
  if (u.projects > free.maxProjects || u.members > free.maxMembers) {
    setFlash(req, 'error',
      `To move to Free you need at most ${free.maxProjects} active projects and ${free.maxMembers} members. ` +
      `You have ${u.projects} active projects and ${u.members} members.`);
    return res.redirect('/billing');
  }
  tx(() => {
    q.setPlan.run('free', req.workspace.id);
    q.addBilling.run(req.workspace.id, 'downgrade', 'free', 0);
    logActivity({ workspaceId: req.workspace.id, userId: req.user.id, action: 'plan.downgraded', summary: 'moved the workspace to the Free plan' });
  });
  setFlash(req, 'success', 'Your workspace is now on the Free plan.');
  res.redirect('/billing');
});

// ---- Settings ----
router.get('/settings', (req, res) => {
  res.render('settings', { title: 'Settings', labels: q.labels.all(req.workspace.id), labelColors: LABEL_COLORS });
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

router.post('/settings/workspace', requireRole('owner'), (req, res) => {
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
  if (!bcrypt.compareSync(String(current), q.userHash.get(req.user.id).password_hash)) {
    setFlash(req, 'error', 'Your current password is incorrect.');
  } else if (String(next).length < 8) {
    setFlash(req, 'error', 'New password must be at least 8 characters.');
  } else {
    q.setPassword.run(bcrypt.hashSync(String(next), 10), req.user.id);
    setFlash(req, 'success', 'Password changed.');
  }
  res.redirect('/settings');
});

router.post('/settings/labels', requireRole('admin'), (req, res) => {
  const name = (req.body.name || '').trim();
  const color = LABEL_COLORS.includes(req.body.color) ? req.body.color : LABEL_COLORS[0];
  if (!name || name.length > 30) setFlash(req, 'error', 'Label names need 1 to 30 characters.');
  else if (q.labelByName.get(req.workspace.id, name)) setFlash(req, 'error', `There is already a label called "${name}".`);
  else {
    q.addLabel.run(req.workspace.id, name, color);
    setFlash(req, 'success', `Added label "${name}".`);
  }
  res.redirect('/settings#labels');
});

router.post('/settings/labels/:id/delete', requireRole('admin'), (req, res) => {
  const label = q.label.get(Number(req.params.id), req.workspace.id);
  if (label) {
    q.deleteLabel.run(label.id);
    setFlash(req, 'success', `Deleted label "${label.name}".`);
  }
  res.redirect('/settings#labels');
});

module.exports = { router, LABEL_COLORS };
