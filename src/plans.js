// Subscription plans. Prices are in RM per month.
const PLANS = {
  free: {
    key: 'free',
    name: 'Free',
    price: 0,
    maxProjects: 3,
    maxMembers: 3,
    reports: false,
    export: false,
    features: [
      'Up to 3 active projects',
      'Up to 3 team members',
      'Kanban boards, calendar and search',
      'Comments, checklists and labels',
    ],
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    price: 29,
    maxProjects: Infinity,
    maxMembers: Infinity,
    reports: true,
    export: true,
    features: [
      'Unlimited projects and members',
      'Reports and charts',
      'CSV export',
      'Everything in Free',
    ],
  },
};

function planFor(workspace) {
  return PLANS[workspace.plan] || PLANS.free;
}

function formatLimit(n) {
  return n === Infinity ? 'Unlimited' : String(n);
}

module.exports = { PLANS, planFor, formatLimit };
