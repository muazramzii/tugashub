const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, tx } = require('../db');
const { planFor } = require('../plans');
const { setFlash } = require('../middleware');
const { logActivity } = require('../services/activity');

const router = express.Router();
const DEFAULT_LABELS = [['Bug', '#e34948'], ['Design', '#e87ba4'], ['Docs', '#2a78d6'], ['Research', '#6250d6']];
const insertLabel = db.prepare('INSERT INTO labels (workspace_id, name, color) VALUES (?, ?, ?)');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const workspaceByInvite = db.prepare('SELECT * FROM workspaces WHERE invite_code = ?');
const memberCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE workspace_id = ?');
const userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const insertWorkspace = db.prepare('INSERT INTO workspaces (name, invite_code) VALUES (?, ?)');
const insertUser = db.prepare('INSERT INTO users (workspace_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)');

function newInviteCode() {
  return crypto.randomBytes(9).toString('base64url');
}

function startSession(req, userId) {
  req.session.userId = userId;
  req.session.csrf = crypto.randomBytes(24).toString('hex');
}

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  const invite = req.query.invite ? workspaceByInvite.get(String(req.query.invite)) : null;
  res.render('auth/signup', { title: 'Create account', invite, inviteCode: req.query.invite || '', values: {}, error: null });
});

router.post('/signup', (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const workspaceName = (req.body.workspace || '').trim();
  const inviteCode = (req.body.invite || '').trim();
  const invite = inviteCode ? workspaceByInvite.get(inviteCode) : null;

  const fail = (error) => res.status(400).render('auth/signup', {
    title: 'Create account', invite, inviteCode, values: { name, email, workspace: workspaceName }, error,
  });

  if (inviteCode && !invite) return fail('This invite link is no longer valid. Ask your team owner for a new one.');
  if (!name || name.length > 80) return fail('Enter your name.');
  if (!EMAIL_RE.test(email)) return fail('Enter a valid email address.');
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  if (!invite && !workspaceName) return fail('Give your workspace a name.');
  if (userByEmail.get(email)) return fail('An account with this email already exists. Log in instead.');

  if (invite) {
    const limit = planFor(invite).maxMembers;
    if (memberCount.get(invite.id).n >= limit) {
      return fail(`${invite.name} has reached the ${limit}-member limit of the Free plan. Ask the owner to upgrade to Pro.`);
    }
  }

  const hash = bcrypt.hashSync(password, 10);
  const userId = tx(() => {
    if (invite) {
      const id = Number(insertUser.run(invite.id, name, email, hash, 'member').lastInsertRowid);
      logActivity({ workspaceId: invite.id, userId: id, action: 'member.joined', summary: 'joined the workspace' });
      return id;
    }
    const wsId = Number(insertWorkspace.run(workspaceName.slice(0, 80), newInviteCode()).lastInsertRowid);
    const id = Number(insertUser.run(wsId, name, email, hash, 'owner').lastInsertRowid);
    for (const [label, color] of DEFAULT_LABELS) insertLabel.run(wsId, label, color);
    logActivity({ workspaceId: wsId, userId: id, action: 'workspace.created', summary: 'created the workspace' });
    return id;
  });

  startSession(req, userId);
  setFlash(req, 'success', invite ? `Welcome to ${invite.name}!` : 'Your workspace is ready. Create your first project.');
  res.redirect('/dashboard');
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('auth/login', { title: 'Log in', values: {}, error: null });
});

router.post('/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const user = userByEmail.get(email);
  if (!user || !bcrypt.compareSync(req.body.password || '', user.password_hash)) {
    return res.status(401).render('auth/login', { title: 'Log in', values: { email }, error: 'Email or password is incorrect.' });
  }
  startSession(req, user.id);
  res.redirect('/dashboard');
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

module.exports = { router, newInviteCode };
