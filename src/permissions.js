// Role-based access control.
//   owner  - everything, including billing, renaming the workspace and changing roles
//   admin  - manage members (not other admins), labels, invite link, archive/delete projects
//   member - work on projects and tasks
const RANK = { member: 1, admin: 2, owner: 3 };
const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', member: 'Member' };

function atLeast(user, role) {
  return (RANK[user.role] || 0) >= RANK[role];
}

const can = {
  manageBilling: (u) => atLeast(u, 'owner'),
  renameWorkspace: (u) => atLeast(u, 'owner'),
  changeRoles: (u) => atLeast(u, 'owner'),
  manageInvites: (u) => atLeast(u, 'admin'),
  manageLabels: (u) => atLeast(u, 'admin'),
  manageProjects: (u) => atLeast(u, 'admin'),
  /** Owners can remove anyone but themselves; admins can remove plain members. */
  removeMember: (u, target) => u.id !== target.id && target.role !== 'owner' &&
    RANK[u.role] > RANK[target.role] && atLeast(u, 'admin'),
  deleteComment: (u, comment) => comment.user_id === u.id || atLeast(u, 'admin'),
};

module.exports = { RANK, ROLE_LABELS, atLeast, can };
