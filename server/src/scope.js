export const RYTSENSE_ORG = '11111111-1111-4111-8111-111111111111';
export const RYTSENSE_SITE = '22222222-2222-4222-8222-222222222222';

export function membershipFor(actor, organizationId) {
  if (!actor || !organizationId) return null;
  return (actor.memberships || []).find((m) => m.organization_id === organizationId) || null;
}

export function canReadOrg(actor, organizationId) {
  if (!actor || !organizationId) return false;
  if (actor.isPlatformAdmin && actor.supportOrgId === organizationId) return true;
  return Boolean(membershipFor(actor, organizationId));
}

export function canAsk(role) {
  return role === 'admin' || role === 'seo' || role === 'dev';
}

export function canWriteTask(role) {
  return role === 'admin' || role === 'seo' || role === 'dev';
}

export function canAdminOrg(role) {
  return role === 'admin';
}

export function assertSameOrg(rowOrg, actorOrg) {
  if (!rowOrg || rowOrg !== actorOrg) {
    const err = new Error('forbidden');
    err.status = 403;
    throw err;
  }
}

export function parseReview(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('not json');
  const obj = JSON.parse(raw.slice(start, end + 1));
  for (const key of ['why', 'fix', 'owner_team', 'effort']) {
    if (typeof obj[key] !== 'string' || !obj[key].trim()) throw new Error('missing ' + key);
  }
  return {
    why: obj.why.trim(),
    fix: obj.fix.trim(),
    owner_team: obj.owner_team.trim(),
    effort: obj.effort.trim(),
    observed_status: obj.observed_status == null ? null : String(obj.observed_status),
  };
}

export const REVIEW_ORDER = ['403', 'error', '404', 'fix', 'not-indexed', 'us-page', 'global-page'];
export const REVIEW_BATCH = 60;
