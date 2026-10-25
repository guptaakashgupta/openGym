/* Gym invitations. A token of 256 random bits is handed to the invitee once; only its SHA-256 is
   stored. It names one gym and one role, expires, can be revoked, and is consumed once: the same
   transaction that consumes it creates the membership, so a token cannot enrol two accounts and a
   refused join (already a member elsewhere) does not spend it.

   An invitation without a recipient is possession-based: whoever holds the token can use it, and
   the owner sees who did. One that is forwarded unexpectedly is revoked, not trusted. Binding to a
   recipient needs an existing account; an e-mail address is never treated as proof of identity.

   Lock order (memberships.js): the redeeming account's users row, then the invitation row, then
   the membership the join creates. */
import crypto from 'node:crypto';
import { newId, inTx } from './organisations.js';
import { addMembership, ROLES } from './memberships.js';
import { PlatformError } from './errors.js';

export const INVITATION_TTL_MS = 7 * 86400000;
const hash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const unknown = () => new PlatformError(404, 'invite-unknown', 'that invitation does not exist');
const gone = code => new PlatformError(410, code, 'that invitation can no longer be used');

const view = r => ({
  id: r.id, gymId: r.gym_id, role: r.role, expiresAt: r.expires_at, createdAt: r.created_at,
  recipientUserId: r.recipient_user_id || null, revokedAt: r.revoked_at || null,
  consumedAt: r.consumed_at || null, consumedBy: r.consumed_by || null,
});

export async function createInvitation(db, { gymId, role, createdBy, recipientUserId = null, ttlMs = INVITATION_TTL_MS }) {
  if (!ROLES.includes(role)) throw new PlatformError(400, 'bad-role', 'bad role');
  const token = 'gi_' + crypto.randomBytes(32).toString('base64url');
  const { rows } = await db.query(
    `INSERT INTO gym_invitations (id, gym_id, role, token_hash, created_by, recipient_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + $7 * interval '1 millisecond') RETURNING *`,
    [newId('i'), gymId, role, hash(token), createdBy, recipientUserId, ttlMs]);
  return { token, invitation: view(rows[0]) };
}

// Why a stored invitation cannot be used by `userId` now, or null.
function refusal(inv, userId) {
  if (inv.revoked_at) return gone('invite-revoked');
  if (inv.consumed_at && inv.consumed_by !== userId) return gone('invite-used');
  if (!inv.consumed_at && new Date(inv.expires_at) <= new Date()) return gone('invite-expired');
  if (inv.recipient_user_id && userId !== undefined && inv.recipient_user_id !== userId) return new PlatformError(403, 'invite-recipient', 'this invitation is for another account');
  return null;
}

// What joining would mean, shown before the member confirms. `userId` undefined: a signup that
// has no account yet.
export async function previewInvitation(db, token, userId) {
  const { rows } = await db.query(
    'SELECT i.*, g.name AS gym_name FROM gym_invitations i JOIN gyms g ON g.id = i.gym_id WHERE i.token_hash = $1', [hash(token)]);
  const inv = rows[0];
  if (!inv) throw unknown();
  const no = refusal(inv, userId) || (inv.consumed_at ? gone('invite-used') : null);
  if (no) throw no;
  return { gymName: inv.gym_name, role: inv.role, boundToAccount: !!inv.recipient_user_id, expiresAt: inv.expires_at };
}

export function redeemInvitation(db, { token, userId }) {
  return inTx(db, async client => {
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const { rows } = await client.query('SELECT * FROM gym_invitations WHERE token_hash = $1 FOR UPDATE', [hash(token)]);
    const inv = rows[0];
    if (!inv) throw unknown();
    const no = refusal(inv, userId);
    if (no) throw no;
    // Its own redeemer asking again (a response lost on the way): the same answer, nothing new.
    if (inv.consumed_at) return { alreadyRedeemed: true, membershipId: inv.membership_id, gymId: inv.gym_id, role: inv.role };
    const membership = await addMembership(client, { gymId: inv.gym_id, userId, role: inv.role });
    await client.query('UPDATE gym_invitations SET consumed_at = now(), consumed_by = $2, membership_id = $3 WHERE id = $1', [inv.id, userId, membership.id]);
    return { alreadyRedeemed: false, membershipId: membership.id, gymId: inv.gym_id, role: inv.role };
  });
}

export async function listInvitations(db, gymId) {
  const { rows } = await db.query('SELECT * FROM gym_invitations WHERE gym_id = $1 ORDER BY created_at DESC, id', [gymId]);
  return rows.map(view);
}

export async function revokeInvitation(db, { gymId, invitationId }) {
  const { rows } = await db.query(
    'UPDATE gym_invitations SET revoked_at = now() WHERE id = $1 AND gym_id = $2 AND revoked_at IS NULL AND consumed_at IS NULL RETURNING id',
    [invitationId, gymId]);
  if (!rows[0]) throw new PlatformError(404, 'not-found', 'not found');
}
