/* PUT /api/data's validation and stamping, moved out of server.js unchanged so every storage
   adapter applies the same rules inside its own compare-and-write. `prepareWrite` never persists:
   it returns `{ status, body }` to answer with, plus `state` and `text` to store when status is
   200. The caller must not acknowledge the write until its store has committed `text`. */
import { stampPut } from '../sync-stamps.js';

// How many earlier write ids a document keeps (`_wids`, see PUT /api/data): a device that last
// synced more writes ago than this merges on its next pull instead of taking the server's copy.
export const WID_KEEP = 50;

// A stored document as a client gets it: without the server's own notes `_unstamped` and `_prior`.
export function forClient(S) {
  if (!S || typeof S !== 'object' || !('_unstamped' in S || '_prior' in S)) return S;
  const { _unstamped, _prior, ...rest } = S;
  return rest;
}
// An entry is an object a reader can dereference, and `records` is every entry of a stored
// list. PUT /api/data drops the rest on the way in — a null workout, a routine that is a
// number — and refuses a list that is not an array at all, but a file written before it did
// answers to nobody, and the readers below walk those lists (`r.id`, `w.d`, `.slice()`). One
// throw inside an admin route is a 500 for that whole profile: the drill-down never leaves
// "Loading…", the Disable button lives inside it, and the account an operator opened the
// dashboard to stop is exactly the one they then cannot. Answering with the entries that are
// there is the honest reading of such a file — what was dropped carried nothing to show.
export const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
export const records = v => (Array.isArray(v) ? v.filter(record) : []);

const bad = error => ({ status: 400, body: { error } });

/* The checks that need only the request, run before the stored document is read (so a malformed
   push is a 400 even when the stored file is unreadable). Normalises body.state in place; running
   it twice is harmless. Returns null when the request may proceed. */
export function validateWrite(body) {
  if (!body.state || typeof body.state !== 'object') return bad('state required');
  // An object with nothing of the profile in it empties the document with the counter left
  // intact: what lands on disk is `{"_rev":n+1}`, every routine, workout and weigh-in gone, and
  // the next poll reports a revision the client accepts as its own. `_rev` and `_ts` do not
  // count towards "something of the profile" — both are bookkeeping this route writes or echoes
  // itself, so `{}` and `{"_rev":5}` are the same push and get the same refusal. Nothing
  // shipped sends either: the web and mobile clients push a state built on DEF
  // (frontend/src/store/useStore.js), which always carries its keys. An array is a document
  // loss of its own and is left to the `invalid state` check below, which already refuses it.
  if (!Array.isArray(body.state) && !Object.keys(body.state).some(k => k !== '_rev' && k !== '_ts')) {
    return bad('state required');
  }
  // The reminder tick and the admin routes iterate these two on the server's side, so a truthy
  // non-array would throw there on every pass for as long as it sat on disk. Absent or null is
  // fine — every client fills its own defaults. An array is `typeof 'object'` but no document:
  // `_rev` set on it is dropped by JSON.stringify, so the file would read back as rev 0 while
  // the response claimed the next revision.
  const list = v => v == null || Array.isArray(v);
  if (Array.isArray(body.state) || !list(body.state.workouts) || !list(body.state.routines)) return bad('invalid state');
  // The same readers walk every entry (`w.d`, `w.name`). They skip what is not an entry now
  // (`records` above), but nothing should be storing one. Dropped, not refused:
  // such an entry carries nothing worth keeping, whereas a 400 would strand a client whose own
  // copy is already malformed — it keeps re-sending the same document and never syncs again.
  for (const k of ['workouts', 'routines']) if (Array.isArray(body.state[k])) body.state[k] = records(body.state[k]);
  return null;
}

/* `cur` is the stored document or null when there is none (an unreadable one is the caller's 503).
   `nextWriteId` mints `_wid`; `now`, when given, is the stamping clock (sync-stamps.js). */
export function prepareWrite(cur, body, { nextWriteId, now } = {}) {
  const invalid = validateWrite(body);
  if (invalid) return invalid;
  // Conditional write: a `baseRev` that is not the current revision means this client last
  // read an older document — another device has written since — and the copy it is about to
  // push would silently drop that write. The current document travels back with the 409, so
  // the client can merge and try again without a second request. No `baseRev` (a client from
  // before revisions, or a deliberate replace such as a backup import) overwrites, as before.
  const curRev = cur?._rev || 0;
  // `_rev` is a counter, so after the data directory went back in time (a restored backup, a
  // write lost to a power cut) the same number names a different document. Every write also gets
  // a write id (`_wid`) and keeps its ancestors' (`_wids`): a client quoting the id it last saw
  // (`baseWid`) is refused when the stored document is not that one, whatever the numbers say,
  // and a client reading a document can tell whether it descends from its own (useStore pullState).
  if ((body.baseRev != null && body.baseRev !== curRev) ||
      (body.baseRev != null && typeof body.baseWid === 'string' && cur?._wid && body.baseWid !== cur._wid)) {
    return { status: 409, body: { error: 'conflict', rev: curRev, state: forClient(cur) } };
  }
  delete body.state.active;              // in-progress workouts stay device-local
  // "Reset everything" stamps the profile (`resetAt`, with `resetIds`: what it wiped). The stamp
  // only moves forward: a write without it, or with an older one — a client from before it, a
  // backup restored over the profile — keeps the stored stamp. Otherwise every device that saw
  // the reset would take that copy for one older than the reset, and wipe it again on its next
  // merge (frontend/src/lib/sync-merge.js).
  const storedReset = Number(cur?.resetAt) || 0;
  if (storedReset > (Number(body.state.resetAt) || 0)) {
    body.state.resetAt = cur.resetAt;
    if (cur.resetIds && typeof cur.resetIds === 'object') body.state.resetIds = cur.resetIds;
    else delete body.state.resetIds;
  }
  // The records of removals and edits only grow, and what a writer that does not stamp its own
  // changes (an older app, an API script) changed is stamped here, so it is neither wiped nor
  // undone by the next device that merges (sync-stamps.js).
  // A document nested too deep to compare is the bad request the stringify below refuses too.
  const report = {};
  try { stampPut(cur, body.state, { overRead: body.baseRev != null && body.baseRev === curRev, stamped: body.stamped === true, report, ...(now ? { now: now() } : {}) }); }
  catch (e) { if (e instanceof RangeError) return bad('invalid state'); throw e; }
  body.state._rev = curRev + 1;          // server-owned; whatever the client sent is ignored
  // A writer that does not stamp (an older app) takes the revision it is told for the document it
  // sent, and only reads the profile again once the revision moves. When the server put back
  // something it left out or set back (sync-stamps.js), the document stored is not that one: it
  // goes in one revision further, so the writer's next check of the revision (every half minute)
  // finds it moved and reads it, and its next push over the one it was told is a conflict to merge.
  if (report.changed) body.state._rev = curRev + 2;
  body.state._wids = [...(Array.isArray(cur?._wids) ? cur._wids : []), ...(cur?._wid ? [cur._wid] : [])]
    .filter(x => typeof x === 'string').slice(-WID_KEEP);
  body.state._wid = nextWriteId();
  // JSON.parse takes any nesting, JSON.stringify recurses and runs out of stack on a document
  // nested some thousands deep. No client builds one; it is a bad request, not a server error.
  let text;
  try { text = JSON.stringify(body.state); }
  catch (e) { if (e instanceof RangeError) return bad('invalid state'); throw e; }
  return { status: 200, state: body.state, text, body: { ok: true, ts: body.state._ts || null, rev: curRev + 1, wid: body.state._wid } };
}
