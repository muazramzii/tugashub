# TugasHub

A multi-tenant task and project management SaaS, built from scratch with **Node.js, Express, EJS and SQLite**.

Teams sign up, get their own workspace, invite members with a link, and run projects on kanban boards. They can discuss work in comments with @mentions, track progress on a calendar and in reports, and control who can do what with roles. Workspaces are on a **Free** plan or a **Pro** plan (RM29/month, simulated checkout) that unlocks reports, CSV export and unlimited usage.

## Features

### Work management
| Feature | What it does |
|---|---|
| Kanban boards | To do / In progress / Done columns with drag and drop, saved instantly. |
| Tasks | Title, description, priority, assignee, due date, labels. Overdue tasks are flagged. |
| Checklists | Break a task into steps; the card shows progress like `2/5`. |
| Labels | Workspace-wide colour labels such as Bug or Design, managed by admins. |
| Board filters | Filter a board by text, assignee, label, priority or due date. |
| Search | One page to search every task, with filters, sorting and pagination. |
| Calendar | Month view of due dates, coloured by project, with an "only mine" toggle. |
| Archiving | Archive finished projects to hide them without deleting anything. |

### Collaboration
| Feature | What it does |
|---|---|
| Comments | Discuss work on the task page. |
| @mentions | Type `@firstname`; the person is highlighted and notified. |
| Notifications | Bell with unread count. You hear about assignments, mentions, comments on your tasks, and completions. |
| Activity log | Every change is recorded: per task, per project, and workspace-wide with day grouping. |
| Team chat | Real-time chat (Socket.IO): #general, one channel per project, and private direct messages. Typing indicator, online status, unread badges, @mentions. |
| Live board | When a teammate changes a board, everyone viewing it sees the update instantly. |

### Analytics and admin
| Feature | What it does |
|---|---|
| Dashboard | Open, in-progress, due-this-week and overdue counts, project progress, your tasks and recent activity. |
| Reports (Pro) | Completion rate, week-on-week change, average days to finish, tasks completed per week, workload per member, open work by priority, project health. Every chart has a table view. |
| CSV export (Pro) | Download any filtered task list. Cells are escaped so spreadsheets cannot run them as formulas. |
| Roles | Owner, Admin and Member, enforced on the server. See the table on the Team page. |
| Billing | Free and Pro plans, usage bars, upgrade / downgrade, billing history. |

### Engineering
- **Multi-tenancy:** every query is scoped to the user's workspace.
- **Security:** bcrypt passwords, CSRF tokens on every form and API call, signed HTTP-only cookies, HTML-escaped user content, CSV formula-injection protection.
- **Database migrations:** versioned with `PRAGMA user_version`, so existing databases upgrade automatically and safely.
- **Real-time:** Socket.IO pushes chat messages, presence, notifications and board changes. Sockets only receive; every change still goes through a checked HTTP route.
- **Automated tests:** 17 end-to-end tests that boot the real app on a throwaway database (`npm test`).
- **Accessible, responsive UI:** keyboard-usable controls, light and dark mode, works on phones, no JavaScript framework.

## How it works

### 1. System architecture

The browser talks to one Node.js server in two ways: normal HTTP requests for pages and changes, and a WebSocket that the server uses to push live updates. All data lives in a single SQLite file.

```mermaid
flowchart TB
  subgraph Browser["Browser"]
    UI["Pages rendered by the server<br/>style.css"]
    JS["app.js and chat.js<br/>drag and drop, filters, chat"]
    SC["Socket.IO client"]
  end

  subgraph Server["Node.js server with Express"]
    MW["Middleware<br/>session, CSRF, login, roles, plan limits"]
    RO["Routes<br/>auth, projects, tasks, search, chat, team, billing"]
    SV["Services<br/>tasks, activity and notifications, chat"]
    VW["EJS views"]
    RT["realtime.js<br/>Socket.IO server"]
  end

  DB[("SQLite database<br/>data/app.db")]

  UI -- "HTTP GET and POST" --> MW
  JS -- "fetch with CSRF token" --> MW
  MW --> RO
  RO --> SV
  SV --> DB
  RO --> VW
  VW -- "HTML" --> UI
  SV -- "emit after commit" --> RT
  RT -- "WebSocket push" --> SC
  SC --> JS
```

### 2. User workflow

How a team uses TugasHub from sign-up to finished work.

```mermaid
flowchart TD
  START(["Visitor opens TugasHub"]) --> ACC{"Has an account?"}
  ACC -- "No" --> SIGNUP["Sign up"]
  ACC -- "Yes" --> LOGIN["Log in"]
  SIGNUP --> INV{"Opened an invite link?"}
  INV -- "Yes" --> JOIN["Join the team workspace as Member"]
  INV -- "No" --> CREATE["Create a new workspace as Owner<br/>Free plan with default labels"]
  JOIN --> DASH["Dashboard"]
  CREATE --> DASH
  LOGIN --> DASH

  DASH --> TEAM["Team page<br/>share invite link, set Admin or Member"]
  DASH --> PROJ["Create a project"]
  PROJ --> BOARD["Kanban board"]
  BOARD --> TASK["Add a task<br/>priority, assignee, due date, labels"]
  TASK --> WORK["Work on the task<br/>checklist, comments, @mentions"]
  WORK --> MOVE["Drag the card<br/>To do, then In progress, then Done"]
  MOVE --> LOG["Activity log and notifications<br/>teammates see the board update live"]

  DASH --> CHAT["Team chat<br/>general, project channels, direct messages"]
  DASH --> PLAN["Calendar and task search"]
  DASH --> PRO{"Workspace on Pro?"}
  PRO -- "Yes" --> REP["Reports, charts and CSV export"]
  PRO -- "No" --> BILL["Billing: upgrade to Pro"]
  BILL --> REP
  LOG --> ARCH["Archive the project when finished"]
```

### 3. Task lifecycle

Every task moves through three columns. Moving it, by dragging the card or editing its status, updates the board for everyone and is written to the activity log.

```mermaid
stateDiagram-v2
  state "To do" as todo
  state "In progress" as doing
  state "Done" as done

  [*] --> todo: Task created, assignee notified
  todo --> doing: Work started
  doing --> done: Completed, completion time saved, creator notified
  todo --> done: Completed
  done --> doing: Reopened, completion time cleared
  doing --> todo: Moved back
  done --> [*]: Task deleted or project archived
```

### 4. What happens on every change

Example: a member drags a card to another column. Every change in the app follows the same checks.

```mermaid
sequenceDiagram
  participant B as Browser
  participant M as Middleware
  participant R as Route
  participant D as SQLite
  participant S as Socket.IO

  B->>M: POST /tasks/42/move with session cookie and CSRF token
  M->>M: Load the user and workspace from the session
  M->>M: Reject the request if the CSRF token is wrong
  M->>R: Pass the request on
  R->>D: Find task 42 inside this user's workspace only
  alt Task belongs to another workspace
    R-->>B: 404 Not found
  else Allowed
    R->>D: One transaction: move task, log activity, create notifications
    R-->>B: 200 OK
    R->>S: Emit board changed, after the commit
    S-->>B: Teammates viewing the board reload it live
  end
```

### 5. Real-time chat

Messages are saved over HTTP, then pushed to everyone allowed to see them.

```mermaid
sequenceDiagram
  actor F as Farid
  participant S as Server
  participant D as SQLite
  actor A as Aina

  A->>S: Open the chat page, socket joins the channel room
  F->>S: Typing event over the socket
  S-->>A: Show "Farid is typing"
  F->>S: POST /chat/1/messages with CSRF token
  S->>D: Save the message and mark it read for Farid
  S->>D: Create a notification for each @mentioned member
  S-->>F: 201 Created with the rendered message
  S-->>A: New message appears instantly
  S-->>A: Bell and pop-up if Aina was mentioned
  Note over S,A: Members on other pages get an unread badge instead
```

### 6. Database design

```mermaid
erDiagram
  WORKSPACES ||--o{ USERS : "has members"
  WORKSPACES ||--o{ PROJECTS : owns
  WORKSPACES ||--o{ LABELS : defines
  WORKSPACES ||--o{ CHANNELS : has
  WORKSPACES ||--o{ ACTIVITY : logs
  WORKSPACES ||--o{ BILLING_EVENTS : records
  PROJECTS ||--o{ TASKS : contains
  PROJECTS |o--o| CHANNELS : "has chat"
  USERS |o--o{ TASKS : "assigned to"
  TASKS ||--o{ CHECKLIST_ITEMS : has
  TASKS ||--o{ COMMENTS : has
  TASKS ||--o{ TASK_LABELS : "tagged with"
  LABELS ||--o{ TASK_LABELS : "used by"
  USERS ||--o{ COMMENTS : writes
  USERS ||--o{ NOTIFICATIONS : receives
  CHANNELS ||--o{ MESSAGES : contains
  USERS ||--o{ MESSAGES : sends
  CHANNELS ||--o{ CHANNEL_READS : "read position"
  USERS ||--o{ CHANNEL_READS : tracks

  WORKSPACES {
    int id PK
    string name
    string plan "free or pro"
    string invite_code
  }
  USERS {
    int id PK
    int workspace_id FK
    string email
    string role "owner, admin or member"
  }
  PROJECTS {
    int id PK
    int workspace_id FK
    string name
    datetime archived_at
  }
  TASKS {
    int id PK
    int project_id FK
    string status "todo, doing or done"
    string priority
    int assignee_id FK
    date due_date
    datetime completed_at
  }
  CHANNELS {
    int id PK
    string kind "general, project or direct"
    int project_id FK
    int user_a FK
    int user_b FK
  }
  MESSAGES {
    int id PK
    int channel_id FK
    int user_id FK
    string body
  }
```

## Requirements

- Node.js **22.13 or newer** (uses the built-in `node:sqlite` module, so there is no database server to install).

## Run it

```bash
npm install
npm run seed     # optional: creates a demo workspace with 8 weeks of sample data
npm run dev      # starts on http://localhost:3000 and restarts on file changes
npm test         # runs the test suite
```

Use `npm start` instead of `npm run dev` to run without auto-restart. Set `PORT` to change the port.

### Demo accounts (created by `npm run seed`)

All use the password `password123`. The demo workspace is on the Pro plan.

| Email | Role |
|---|---|
| aina@demo.test | Owner |
| farid@demo.test | Admin |
| mei@demo.test | Member |
| daniel@demo.test | Member |

To reset all data back to the demo, run `npm run reset` (works while the server is running).

## Project structure

```
src/
  server.js              Starts the HTTP server
  app.js                 Express app: sessions, view helpers, route mounting
  db.js                  SQLite connection and versioned migrations
  plans.js               Free / Pro plan limits and features
  permissions.js         Owner / Admin / Member rules
  middleware.js          Auth, roles, plan gates, flash messages, CSRF
  icons.js               Inline SVG icons
  seed.js                Demo data
  services/
    tasks.js             Shared task search/filter engine, moving tasks between columns
    activity.js          Activity log, notifications, @mention parsing and rendering
  routes/
    auth.js              Sign up (incl. invite links), log in, log out
    projects.js          Dashboard, projects, boards, archiving
    tasks.js             Task page, edits, drag-and-drop API, checklist, comments
    views.js             Search, CSV export, calendar, reports
    feed.js              Notifications and activity log
    workspace.js         Team and roles, billing, settings, labels
views/                   EJS templates (partials/ holds the shell and shared pieces)
public/
  css/style.css          All styling, light and dark mode
  js/app.js              Drag and drop, filters, dialogs, mention chips, chart tooltips
test/app.test.js         End-to-end tests
data/                    SQLite database and session secret (created at runtime, git-ignored)
```

## Database schema

```
workspaces      (id, name, plan, invite_code, created_at)
users           (id, workspace_id, name, email, password_hash, role, created_at)
projects        (id, workspace_id, name, description, color, archived_at, created_at)
tasks           (id, project_id, title, description, status, priority, assignee_id,
                 created_by, due_date, position, completed_at, created_at)
labels          (id, workspace_id, name, color)
task_labels     (task_id, label_id)
checklist_items (id, task_id, text, done, position, created_at)
comments        (id, task_id, user_id, body, created_at)
activity        (id, workspace_id, user_id, project_id, task_id, action, summary, created_at)
notifications   (id, user_id, actor_id, task_id, kind, message, url, read_at, created_at)
billing_events  (id, workspace_id, action, plan, amount, created_at)
channels        (id, workspace_id, kind, name, project_id, user_a, user_b, created_at)
messages        (id, channel_id, user_id, body, created_at)
channel_reads   (user_id, channel_id, last_read_id)
```

Deleting a workspace, project or task cascades to its children. Removing a member leaves their tasks unassigned and keeps their comments and history.

## Notes and limits

- Payments are **simulated**: upgrading records a billing event but charges nothing. A real version would use a payment provider such as Stripe or Billplz.
- Invites work by link only, and notifications are in-app only. No emails are sent.
- Each user belongs to one workspace.
