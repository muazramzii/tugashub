// Video meetings. The call itself runs on Jitsi Meet (opened in a new tab);
// TugasHub keeps the meeting record, shared minutes, and turns action items into tasks.
const crypto = require('crypto');
const express = require('express');
const { db, tx } = require('../db');
const { requireAuth, setFlash } = require('../middleware');
const { atLeast } = require('../permissions');
const { logActivity, notify, quote } = require('../services/activity');
const { DATE_RE } = require('../services/tasks');
const { boardChanged } = require('../realtime');

const router = express.Router();
router.use(requireAuth);

// Any Jitsi server works: the public meet.jit.si, a self-hosted one, or 8x8 JaaS.
const JITSI_BASE = (process.env.JITSI_URL || 'https://meet.jit.si').replace(/\/+$/, '');

const q = {
  live: db.prepare(`
    SELECT m.*, p.name AS project_name, p.color AS project_color, u.name AS starter_name
    FROM meetings m LEFT JOIN projects p ON p.id = m.project_id LEFT JOIN users u ON u.id = m.started_by
    WHERE m.workspace_id = ? AND m.ended_at IS NULL ORDER BY m.id DESC`),
  past: db.prepare(`
    SELECT m.*, p.name AS project_name, p.color AS project_color, u.name AS starter_name,
           (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id = m.id) AS task_count
    FROM meetings m LEFT JOIN projects p ON p.id = m.project_id LEFT JOIN users u ON u.id = m.started_by
    WHERE m.workspace_id = ? AND m.ended_at IS NOT NULL ORDER BY m.id DESC LIMIT 50`),
  meeting: db.prepare(`
    SELECT m.*, p.name AS project_name, p.color AS project_color, p.archived_at AS project_archived,
           u.name AS starter_name, n.name AS notes_editor
    FROM meetings m LEFT JOIN projects p ON p.id = m.project_id
    LEFT JOIN users u ON u.id = m.started_by LEFT JOIN users n ON n.id = m.notes_updated_by
    WHERE m.id = ? AND m.workspace_id = ?`),
  insert: db.prepare('INSERT INTO meetings (workspace_id, project_id, title, room, started_by) VALUES (?, ?, ?, ?, ?)'),
  saveNotes: db.prepare("UPDATE meetings SET notes = ?, notes_updated_by = ?, notes_updated_at = datetime('now') WHERE id = ?"),
  end: db.prepare("UPDATE meetings SET ended_at = datetime('now') WHERE id = ? AND ended_at IS NULL"),
  projects: db.prepare('SELECT id, name, color FROM projects WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name COLLATE NOCASE'),
  project: db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ? AND archived_at IS NULL'),
  members: db.prepare('SELECT id, name FROM users WHERE workspace_id = ? ORDER BY name'),
  member: db.prepare('SELECT id, name FROM users WHERE id = ? AND workspace_id = ?'),
  tasks: db.prepare(`
    SELECT t.id, t.title, t.status, t.due_date, a.name AS assignee_name, p.name AS project_name
    FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN users a ON a.id = t.assignee_id
    WHERE t.meeting_id = ? ORDER BY t.id`),
  nextPosition: db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM tasks WHERE project_id = ? AND status = 'todo'"),
  insertTask: db.prepare(`
    INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, created_by, due_date, position, meeting_id)
    VALUES (?, ?, ?, 'todo', 'medium', ?, ?, ?, ?, ?)`),
};

/** Link that opens the call, with the meeting title and the person's name filled in. */
function joinUrl(meeting, user) {
  // Jitsi reads these as JSON values; encodeURIComponent (not URLSearchParams) so spaces stay %20, not "+".
  const param = (key, value) => `${key}=${encodeURIComponent(JSON.stringify(value))}`;
  return `${JITSI_BASE}/${meeting.room}#${param('config.subject', meeting.title)}&${param('userInfo.displayName', user.name)}`;
}

/** Minutes between start and end (or now, for a live meeting). */
function duration(m) {
  const toDate = (s) => new Date(`${s.replace(' ', 'T')}Z`);
  const end = m.ended_at ? toDate(m.ended_at) : new Date();
  return Math.max(1, Math.round((end - toDate(m.created_at)) / 60000));
}

function loadMeeting(req, res, next) {
  const meeting = q.meeting.get(Number(req.params.id), req.workspace.id);
  if (!meeting) {
    return res.status(404).render('error', { title: 'Not found', message: 'That meeting does not exist in your workspace.' });
  }
  req.meeting = meeting;
  next();
}

const canEnd = (user, meeting) => meeting.started_by === user.id || atLeast(user, 'admin');

// ---- List ----
router.get('/meetings', (req, res) => {
  res.render('meetings', {
    title: 'Meetings',
    live: q.live.all(req.workspace.id).map((m) => ({ ...m, minutes: duration(m) })),
    past: q.past.all(req.workspace.id).map((m) => ({ ...m, minutes: duration(m) })),
    projects: q.projects.all(req.workspace.id),
  });
});

// ---- Start ----
router.post('/meetings', (req, res) => {
  const project = req.body.project_id ? q.project.get(Number(req.body.project_id), req.workspace.id) : null;
  if (req.body.project_id && !project) {
    setFlash(req, 'error', 'That project does not exist or is archived.');
    return res.redirect('/meetings');
  }
  const title = (req.body.title || '').trim().slice(0, 120) || (project ? `${project.name} meeting` : 'Team meeting');
  // Unguessable room name: anyone with the Jitsi link can join, so it must not be predictable.
  const room = `tugashub-${crypto.randomBytes(10).toString('hex')}`;
  const id = tx(() => {
    const meetingId = Number(q.insert.run(req.workspace.id, project ? project.id : null, title, room, req.user.id).lastInsertRowid);
    logActivity({ workspaceId: req.workspace.id, userId: req.user.id, projectId: project ? project.id : null,
      action: 'meeting.started', summary: `started the meeting ${quote(title)}` });
    for (const m of q.members.all(req.workspace.id)) {
      notify({ userId: m.id, actorId: req.user.id, kind: 'meeting',
        message: `${req.user.name} started a meeting: ${quote(title)}`, url: `/meetings/${meetingId}` });
    }
    return meetingId;
  });
  res.redirect(`/meetings/${id}`);
});

// ---- Detail ----
router.get('/meetings/:id', loadMeeting, (req, res) => {
  const m = req.meeting;
  res.render('meeting', {
    title: m.title,
    meeting: { ...m, minutes: duration(m) },
    joinUrl: joinUrl(m, req.user),
    canEnd: canEnd(req.user, m),
    tasks: q.tasks.all(m.id),
    members: q.members.all(req.workspace.id),
    projects: q.projects.all(req.workspace.id),
    defaultProject: m.project_id && !m.project_archived ? m.project_id : null,
  });
});

// ---- Minutes ----
router.post('/meetings/:id/notes', loadMeeting, (req, res) => {
  const notes = String(req.body.notes || '').slice(0, 20000);
  q.saveNotes.run(notes, req.user.id, req.meeting.id);
  setFlash(req, 'success', 'Minutes saved.');
  res.redirect(`/meetings/${req.meeting.id}#minutes`);
});

// ---- Action item -> task ----
router.post('/meetings/:id/tasks', loadMeeting, (req, res) => {
  const m = req.meeting;
  const back = `/meetings/${m.id}#actions`;
  const title = (req.body.title || '').trim();
  const due = (req.body.due_date || '').trim();
  const project = q.project.get(Number(req.body.project_id), req.workspace.id);
  const assignee = req.body.assignee_id ? q.member.get(Number(req.body.assignee_id), req.workspace.id) : null;
  const error = !title ? 'An action item needs a title.'
    : title.length > 200 ? 'Keep the action item under 200 characters.'
      : !project ? 'Choose an active project for the task.'
        : due && !DATE_RE.test(due) ? 'Due date is not a valid date.' : null;
  if (error) {
    setFlash(req, 'error', error);
    return res.redirect(back);
  }
  tx(() => {
    const id = Number(q.insertTask.run(project.id, title, `Action item from the meeting ${quote(m.title)}.`,
      assignee ? assignee.id : null, req.user.id, due || null, q.nextPosition.get(project.id).pos, m.id).lastInsertRowid);
    logActivity({ workspaceId: req.workspace.id, userId: req.user.id, projectId: project.id, taskId: id,
      action: 'task.created', summary: `created ${quote(title)} in ${project.name} from the meeting ${quote(m.title)}` });
    if (assignee) {
      notify({ userId: assignee.id, actorId: req.user.id, taskId: id, kind: 'assigned',
        message: `${req.user.name} assigned you ${quote(title)} from the meeting ${quote(m.title)}` });
    }
  });
  boardChanged(project.id, req.user);
  setFlash(req, 'success', `Task created in ${project.name}.`);
  res.redirect(back);
});

// ---- End ----
router.post('/meetings/:id/end', loadMeeting, (req, res) => {
  const m = req.meeting;
  if (!canEnd(req.user, m)) {
    return res.status(403).render('error', { title: 'Not allowed', message: 'Only the person who started the meeting or an admin can end it.' });
  }
  if (q.end.run(m.id).changes) {
    logActivity({ workspaceId: req.workspace.id, userId: req.user.id, projectId: m.project_id,
      action: 'meeting.ended', summary: `ended the meeting ${quote(m.title)}` });
  }
  setFlash(req, 'success', 'Meeting ended. The minutes and action items stay here.');
  res.redirect(`/meetings/${m.id}`);
});

module.exports = { router, joinUrl };
