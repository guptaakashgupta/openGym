/* What both identity stores agree on: upstream's rules for which identifiers a profile claims
   (server.js nameTaken/emailTaken/passwordHolder). A name is claimed only while the profile can
   sign in with it (a password, or a reset code that is still valid); an e-mail always; names and
   e-mails share one namespace, so `a@b.io` as a name and as an address collide, except on the
   same profile. */
import { nameKey } from '../password.js';

export class IdentityConflictError extends Error {
  constructor(field) { super(`${field} already taken`); this.name = 'IdentityConflictError'; this.field = field; }
}

export const hasPassword = u => !!(u && u.pw && typeof u.pw.h === 'string');
export const holdsName = (u, now = Date.now()) => hasPassword(u) || !!(u?.pwReset && u.pwReset.exp > now);

/* key -> { name, email }: what this profile claims. The name claim wins the reported field when a
   key carries both, matching the order upstream checks them in. */
export function claimsOf(u, now = Date.now()) {
  const claims = new Map();
  if (holdsName(u, now)) claims.set(nameKey(u.name), { name: true, email: false });
  if (typeof u.email === 'string' && u.email) {
    const c = claims.get(u.email) || { name: false, email: false };
    c.email = true;
    claims.set(u.email, c);
  }
  return claims;
}
export const conflictField = c => (c.name ? 'name' : 'email');

export function assertSameId(before, after) {
  if (!after || after.id !== before.id) throw new Error(`an update cannot change the account id (${before.id})`);
}
