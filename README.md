# TugasHub

A multi-tenant task and project management SaaS, built from scratch with **Node.js, Express, EJS and SQLite**.

Teams sign up, get their own workspace, invite members with a link, and manage tasks on kanban boards. Workspaces are on a **Free** plan (3 projects, 3 members) or a **Pro** plan (unlimited, RM29/month, simulated checkout).

## Features

| Area | What it does |
|---|---|
| Accounts | Sign up, log in, log out. Passwords hashed with bcrypt. |
| Multi-tenancy | Each sign-up creates a workspace. Every query is scoped to the user's workspace, so teams never see each other's data. |
| Projects | Create, rename and delete projects, each with a colour and a progress bar. |
| Kanban board | To do / In progress / Done columns. Drag and drop to move tasks (saved straight away). |
| Tasks | Title, description, priority, assignee, due date. Overdue tasks are flagged. |
| Dashboard | Open / in-progress / done / overdue counts, project progress, tasks assigned to you. |
| Team | Shareable invite link, reset link, member list, owner can remove members. |
| Billing | Plan limits, usage bars, upgrade / downgrade, billing history. |
| Settings | Edit profile, rename workspace, change password. |
| Security | CSRF tokens on every form, HTTP-only signed session cookie, owner-only actions checked on the server. |

## Requirements

- Node.js **22.13 or newer** (uses the built-in `node:sqlite` module, so there is no database server to install).

## Run it

```bash
npm install
npm run seed     # optional: creates a demo workspace with sample data
npm run dev      # starts on http://localhost:3000 and restarts on file changes
```

Use `npm start` instead of `npm run dev` to run without auto-restart. Set `PORT` to change the port.

### Demo accounts (created by `npm run seed`)

All use the password `password123`.

| Email | Role |
|---|---|
| aina@demo.test | Owner |
| farid@demo.test | Member |
| mei@demo.test | Member |

To reset all data, stop the server, delete the `data/` folder, and run `npm run seed` again.

## Project structure

```
src/
  server.js            Express app setup, sessions, shared view helpers
  db.js                SQLite connection and schema (tables are created on start)
  plans.js             Free / Pro plan definitions and limits
  middleware.js        Auth, owner check, flash messages, CSRF
  seed.js              Demo data
  routes/
    auth.js            Sign up (incl. invite links), log in, log out
    projects.js        Dashboard, projects, tasks, drag-and-drop move API
    workspace.js       Team, billing, settings
views/                 EJS templates (partials/ holds the shared header and footer)
public/
  css/style.css        All styling, light and dark mode
  js/app.js            Drag and drop, dialogs, copy button, confirm prompts
data/                  SQLite database and session secret (created at runtime, git-ignored)
```

## Database schema

```
workspaces     (id, name, plan, invite_code, created_at)
users          (id, workspace_id → workspaces, name, email, password_hash, role, created_at)
projects       (id, workspace_id → workspaces, name, description, color, created_at)
tasks          (id, project_id → projects, title, description, status, priority,
                assignee_id → users, created_by → users, due_date, position, created_at)
billing_events (id, workspace_id → workspaces, action, plan, amount, created_at)
```

Deleting a workspace or project cascades to its children. Removing a member leaves their tasks unassigned.

## Notes and limits

- Payments are **simulated**: upgrading records a billing event but charges nothing. A real version would use a payment provider such as Stripe or Billplz.
- Invites work by link only. No emails are sent.
- Each user belongs to one workspace.
