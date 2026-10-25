/* The answers platform routes give for refusals. 404 for a resource of a gym the caller has no
   role in (its existence is not confirmed), 403 for an action the caller's role may not take,
   409 for a state conflict, 400 for a malformed or nonsensical request. */
import { MembershipError } from './memberships.js';

export class PlatformError extends Error {
  constructor(status, code, message = code) { super(message); this.name = 'PlatformError'; this.status = status; this.code = code; }
}
export const notFound = () => new PlatformError(404, 'not-found', 'not found');
export const forbidden = () => new PlatformError(403, 'forbidden', 'not allowed');
export const badRequest = code => new PlatformError(400, code, 'bad request');

const MEMBERSHIP_STATUS = { 'not-found': 404, already: 409, 'member-elsewhere': 409, 'wrong-role': 400, 'bad-role': 400 };

// The answer for a thrown error, or null when it is not one of ours (the caller rethrows).
export function errorAnswer(e) {
  if (e instanceof PlatformError) return { status: e.status, body: { error: e.message, code: e.code } };
  if (e instanceof MembershipError) {
    const status = MEMBERSHIP_STATUS[e.code] || 400;
    return { status, body: { error: status === 404 ? 'not found' : e.message, code: e.code } };
  }
  return null;
}
