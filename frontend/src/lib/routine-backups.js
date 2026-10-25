// Planned substitutes for an exercise in a routine (Discord "Substitutions for a routine"): the
// machine is taken, the bar is busy, and the plan already says what to do instead. An optional
// list of exercise ids on the routine's entry, `subs`, picked in the routine editor; a running
// workout's swap sheet shows them first ("Your backups"). Nothing else reads it, and a routine
// entry without it is exactly what it was.

// MAX_BACKUPS and cleanBackups: api/shared/plan-rules.js (shared with the API's plan import).
import { MAX_BACKUPS, cleanBackups } from '../../../api/shared/plan-rules.js'
export { MAX_BACKUPS, cleanBackups }


/** `{ subs }` to spread into a saved entry, or nothing when there are none. */
export const withBackups = (list, selfId, known) => {
  const subs = cleanBackups(list, selfId, known)
  return subs.length ? { subs } : {}
}
