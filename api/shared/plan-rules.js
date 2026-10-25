// The pure rules plan import needs, shared by the app (frontend/src/lib re-exports each from its
// old module, so nothing that imported them changes) and the API (plan-import.js under plain
// Node). Moved here verbatim from pyramid.js, backoff.js, dumbbells.js, units.js,
// routine-backups.js, media-refs.js, muscles.js, superset-meta.js, history.js and progression.js.
// Nothing here may import from the browser build: no catalogue, no i18n, no DOM.

// ---- pyramid.js ----
export const PYRAMID_MAX = 'max'
export const MAX_PYRAMID_SETS = 10

export function isPyramid(cfg) {
  return !!cfg && Array.isArray(cfg.pyramid) && cfg.pyramid.length > 0 && (cfg.mode || 'reps') === 'reps'
}

// What the editor and a hand-edited plan file can hold, kept to what the session can train:
// whole targets of at least one rep, "max", and no more than MAX_PYRAMID_SETS sets. `stride` 2
// is a per-side exercise: each target is rounded up to even, so it splits evenly between L and R.
export function normalizePyramid(list, stride = 1) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const v of list) {
    if (v === PYRAMID_MAX) out.push(PYRAMID_MAX)
    else if (v != null && v !== '' && Number.isFinite(Number(v))) {
      const n = Math.max(1, Math.round(Number(v)))
      out.push(Math.ceil(n / stride) * stride)
    }
  }
  return out.slice(0, MAX_PYRAMID_SETS)
}

export function normalizePyramidRest(rest, length) {
  const src = Array.isArray(rest) ? rest : []
  const out = Array.from({ length }, (_, i) => Math.max(0, Math.round(Number(src[i])) || 0))
  return out.some(v => v > 0) ? out : []
}

// Each set's own planned weight, beside the targets (`pyramidWeight[i]` for `pyramid[i]`), in
// the plan's unit. 0 is "no plan": the set starts from what that same set lifted last time.
// Sized to the list; all zeros is no field at all, like pyramidRest.
export function normalizePyramidWeight(weights, length) {
  const src = Array.isArray(weights) ? weights : []
  const out = Array.from({ length }, (_, i) => {
    const w = Number(src[i])
    return Number.isFinite(w) && w > 0 ? Math.round(w * 100) / 100 : 0
  })
  return out.some(v => v > 0) ? out : []
}

// ---- backoff.js ----
/** Whether a plan asks for back-off sets. Off unless switched on, so every plan saved before
 *  this field existed builds exactly as it did. A pyramid owns each set already, and a
 *  rest-pause trains one work set, so neither has anything to step down. */
export function isBackoff(cfg) {
  return !!cfg && cfg.backoff === true && (cfg.mode || 'reps') === 'reps'
    && !(Array.isArray(cfg.pyramid) && cfg.pyramid.length)
    && cfg.intensifier?.type !== 'restpause'
}

// ---- dumbbells.js ----
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)
/** A stored meaning ('as' | 'each' | 'total'), or null when there is none. S.dbLoad holds `{ mode, _ts }`. */
export function dbLoadOf(value) {
  const m = isMap(value) ? value.mode : value
  return m === 'each' || m === 'total' || m === 'as' ? m : null
}

// ---- units.js ----
export const LB_PER_KG = 2.2046226218

export function convertWeight(value, from, to) {
  if (from === to || value == null || value === '' || !Number.isFinite(Number(value))) return value
  const v = Number(value)
  if (to === 'lb') return Math.round(v * LB_PER_KG * 2) / 2
  return Math.round(v / LB_PER_KG * 4) / 4
}

// ---- routine-backups.js ----
export const MAX_BACKUPS = 5

/**
 * The list as it may be stored: unique string ids, never the exercise itself, only ones `known`
 * says exist, at most MAX_BACKUPS. An empty result is no list at all (the field is left out).
 */
export function cleanBackups(list, selfId, known = () => true) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const id of list) {
    if (typeof id !== 'string' || !id || id === selfId || out.includes(id) || !known(id)) continue
    out.push(id)
    if (out.length >= MAX_BACKUPS) break
  }
  return out
}

// ---- media-refs.js ----
export const MAX_URL = 2048

/**
 * A link as it may be stored and opened: http(s) only, no user name or password in it, at most
 * 2048 characters — or null. A bare "youtube.com/watch?v=…" gets https:// in front, the way people
 * paste links (#246). Anything else with a scheme of its own (javascript:, data:, mailto:, a
 * custom app scheme) is refused rather than guessed at. It runs at save and again at render,
 * because a plan file or a backup can bring any string in.
 */
export function cleanUrl(raw) {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (!s || s.length > MAX_URL) return null
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z0-9+.-]+:/i.test(s)) return null
    s = 'https://' + s
  }
  // Chrome's URL parser takes "https://not a url" and percent-encodes the spaces into the host,
  // so "not a url" typed into the link field was saved as a link (QA 1.3.9). The host has to
  // be one a browser could reach: no whitespace in what was typed, and a dotted name,
  // localhost or an IP address.
  const authority = /^https?:\/\/([^/?#]*)/i.exec(s)?.[1] || ''
  if (/\s/.test(authority)) return null
  let u
  try { u = new URL(s) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!u.hostname || u.username || u.password) return null
  if (!plausibleHost(u.hostname)) return null
  return u.href.length <= MAX_URL ? u.href : null
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i
function plausibleHost(host) {
  if (host.startsWith('[') && host.endsWith(']')) return true               // IPv6
  const h = host.replace(/\.$/, '').toLowerCase()
  if (h === 'localhost') return true
  const labels = h.split('.')
  // xn-- names are how the parser writes an international domain, so they pass as letters.
  return labels.length >= 2 && labels.every(l => LABEL.test(l))
}

// ---- muscles.js ----
// The muscles a map can shade, in head-to-toe order — also the order of any list
// built from them, so "what am I neglecting" reads top-down like a body.
export const MUSCLES = [
  'trapezius', 'deltoids', 'chest', 'upper-back', 'serratus',
  'biceps', 'triceps', 'forearm',
  'abs', 'obliques', 'lower-back',
  'gluteal', 'quadriceps', 'hamstring', 'adductors', 'hip-flexors',
  'calves', 'tibialis',
]

// A picked list in the map's own order rather than the order the chips were tapped in — two
// people building the same exercise get the same exercise. Unknown names keep their place at the end.
export const inMuscleOrder = list => {
  const at = m => { const i = MUSCLES.indexOf(m); return i < 0 ? MUSCLES.length : i }
  return [...(list || [])].sort((a, b) => at(a) - at(b))
}

// ---- superset-meta.js ----
export const SG_NAME_MAX = 40

// ---- history.js ----
// A routine entry can now say so explicitly:
//   reps   — weight × reps      sets look like { w, r }
//   time   — a work duration    sets look like { sec, w }   (w = 0 for bodyweight)
//   cardio — duration + speed   sets look like { min, speed }
// An entry without `mode` behaves exactly as before, so every existing plan, workout and
// plan file is read unchanged and nothing needs migrating. `isCardio` is the catalogue's answer
// for an id (history.js passes its own; the API passes one built from the generated catalogue).
export function modeOfWith(cfg, isCardio) {
  const m = cfg && cfg.mode
  if (m === 'reps' || m === 'time' || m === 'cardio') return m
  return isCardio(cfg && cfg.id) ? 'cardio' : 'reps'
}

/** Beyond this a "warm-up" is its own workout; the config stepper stops here too. */
export const MAX_PLANNED_WARMUPS = 5

// ---- progression.js ----
export const MAX_TRIPLE_SETS = 10
