/* Stable ids for what accepting a trainer's proposal adds to a member's document: the same member,
   proposal version, kind and source id always give the same id, so a retried acceptance makes the
   same routines, never a second copy. Server-only (node:crypto); callers check the result against
   unrelated records already in the document before using it. */
import { createHash } from 'node:crypto';

export function proposalEntityId(userId, versionId, kind, sourceId) {
  const bytes = JSON.stringify([userId, versionId, kind, sourceId]);
  return 'gp_' + createHash('sha256').update(bytes).digest('hex').slice(0, 24);
}
