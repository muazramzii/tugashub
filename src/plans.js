// Subscription plans. Prices are in RM per month.
const PLANS = {
  free: {
    key: 'free',
    name: 'Free',
    price: 0,
    maxProjects: 3,
    maxMembers: 3,
    features: ['Up to 3 projects', 'Up to 3 team members', 'Kanban boards', 'Task assignment and due dates'],
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    price: 29,
    maxProjects: Infinity,
    maxMembers: Infinity,
    features: ['Unlimited projects', 'Unlimited team members', 'Everything in Free', 'Priority support'],
  },
};

function planFor(workspace) {
  return PLANS[workspace.plan] || PLANS.free;
}

function formatLimit(n) {
  return n === Infinity ? 'Unlimited' : String(n);
}

module.exports = { PLANS, planFor, formatLimit };
