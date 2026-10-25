// The device's own record, per account and server, of what the gym may be told about newly
// recorded workouts (workout-context.js): in localStorage, and on the phone mirrored to a file,
// since the WebView's storage can be evicted. Never part of the personal document (S): it is not
// synced, exported or restored with it, and it carries no authority — the server decides.
import { MOBILE, readJsonFile, writeJsonFile } from '../lib/mobile.js'

const KEY = 'gym_recordings_v1'
const FILE = 'opengym-gym-recordings.json'

const readLocal = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {} } catch { return {} } }
let all = readLocal()
let writing = Promise.resolve()

const keyOf = ctx => (ctx.server || '') + '|' + ctx.account
const save = () => {
  try { localStorage.setItem(KEY, JSON.stringify(all)) } catch { /* full: the file copy, if any, stands */ }
  if (MOBILE) { const copy = all; writing = writing.then(() => writeJsonFile(FILE, copy)) }
}

// Phone: what the file kept for accounts this WebView's storage no longer holds.
export const ready = MOBILE
  ? readJsonFile(FILE).then(f => { if (f && typeof f === 'object') { all = { ...f, ...all }; save() } }).catch(() => {})
  : Promise.resolve()
export const flushed = () => writing

export const read = ctx => all[keyOf(ctx)] || null
export function write(ctx, rec) {
  if (rec) all = { ...all, [keyOf(ctx)]: rec }
  else { const { [keyOf(ctx)]: _gone, ...rest } = all; all = rest }
  save()
}
