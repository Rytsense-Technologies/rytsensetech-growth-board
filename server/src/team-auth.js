import { createHmac, timingSafeEqual } from 'crypto';
import { RYTSENSE_ORG } from './scope.js';

export function teamUsername() {
  return process.env.TEAM_USERNAME || 'rytsensetech';
}

export function teamPassword() {
  return process.env.TEAM_PASSWORD || 'Admin@123#';
}

export function teamUserId() {
  return 'team-' + teamUsername();
}

function sessionSecret() {
  return process.env.SESSION_SECRET || process.env.CRON_SECRET || 'growth-board-team-session';
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

export function checkTeamLogin(username, password) {
  const userOk = safeEqual(String(username || '').trim().toLowerCase(), teamUsername().toLowerCase());
  const passOk = safeEqual(String(password || ''), teamPassword());
  return userOk && passOk;
}

export function signTeamToken(extra = {}) {
  const payload = {
    typ: 'gb-team',
    sub: teamUserId(),
    username: teamUsername(),
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
    ...extra,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  return 'gb.' + body + '.' + sig;
}

export function verifyTeamToken(token) {
  if (!token || !String(token).startsWith('gb.')) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', sessionSecret()).update(parts[1]).digest('base64url');
  if (!safeEqual(parts[2], expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.typ !== 'gb-team') return null;
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

export function teamActor(req, payload) {
  return {
    userId: (payload && payload.sub) || teamUserId(),
    email: teamUsername() + '@rytsensetech.com',
    isPlatformAdmin: true,
    supportOrgId: (req && req.get && req.get('x-support-org')) || RYTSENSE_ORG,
    memberships: [{
      organization_id: RYTSENSE_ORG,
      role: 'admin',
      organizations: { status: 'active' },
    }],
  };
}
