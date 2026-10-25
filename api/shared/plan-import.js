// Plan import, shared by the app (frontend/src/lib/plan-share.js, a friend's plan file) and the
// API (a trainer's proposal, accepted on the server). Moved here from plan-share.js unchanged in
// behaviour; what differs between the two runtimes is passed in:
//   t          translation (the API passes the identity; its messages are never shown as is)
//   catalogue  { exists(id), isBuiltIn(id), isCardio(id), isBodyweightEq(id), canonical(id) }
//   newId      a fresh id (the app's uid())
//   today      today's ISO date
// Nothing here imports from the browser build; it loads under plain Node.
import {
  isPyramid, normalizePyramid, normalizePyramidRest, normalizePyramidWeight, isBackoff, dbLoadOf,
  convertWeight, cleanBackups, cleanUrl, MUSCLES, inMuscleOrder, SG_NAME_MAX, modeOfWith,
  MAX_PLANNED_WARMUPS, MAX_TRIPLE_SETS,
} from './plan-rules.js'

export const PLAN_FMT = 1
export const WEEK_DAYS = [1, 2, 3, 4, 5, 6, 0]   // every getDay() index; only the reader's own
                                                 // screen puts them in an order (see weekOrder)
const PLAN_UNITS = new Set(['kg', 'lb'])

// A plan's numbers are in the unit that wrote it. Missing unit is deliberately legacy-compatible:
// old files were read as already being in the recipient's unit, so keep their values unchanged.
const planUnit = value => value === 'lbs' ? 'lb' : PLAN_UNITS.has(value) ? value : null

/** Clamped the same way buildSets clamps it on the way out — the stepper showed a hand-edited
 *  plan file's "999" verbatim, because the clamp only happened when the rows were built. */
function cleanWarmupSets(v) {
  const n = Math.round(Number(v)) || 0
  return n > 0 ? Math.min(MAX_PLANNED_WARMUPS, n) : 0
}

/** A positive whole number of seconds or nothing — the same gate cleanEx applies on the way
 *  out, so a hand-edited plan file can't hand the rest timer a string or a negative. */
function cleanRestSec(v) {
  const n = Math.round(Number(v)) || 0
  return n > 0 ? n : 0
}

/** A superset name as setSupersetMeta writes it: a trimmed string of at most SG_NAME_MAX, or nothing. */
function cleanSgName(v) {
  return typeof v === 'string' ? v.trim().slice(0, SG_NAME_MAX) : ''
}

/** Keep the floors the config sheet and applyIntensifierPlan already enforce, and nothing else:
 *  a plan file is someone else's data, so anything unrecognised is dropped rather than trusted. */
export function cleanIntensifier(x) {
  const type = x && x.type
  if (type === 'dropset') {
    return { type, count: Math.max(1, Math.round(Number(x.count)) || 1), pct: Math.max(5, Math.round(Number(x.pct)) || 20) }
  }
  if (type === 'restpause') {
    return { type, totalReps: Math.max(1, Math.round(Number(x.totalReps)) || 1), restSec: Math.max(5, Math.round(Number(x.restSec)) || 15) }
  }
  return null
}

// The muscles the map can draw, plus the one label the form gives a cardio exercise.
const CUSTOM_MUSCLES = new Set([...MUSCLES, 'cardiovascular system'])
const muscleList = v => inMuscleOrder([...new Set((Array.isArray(v) ? v : []).filter(m => CUSTOM_MUSCLES.has(m)))])

/** A custom exercise with its own metadata — equipment, muscles, description — in the shape
 *  CustomExForm writes, minus the recipient-side `custom`/`sm` fields mergePlan adds. The bundle
 *  used to carry only {id, n, bp}, so the exercise arrived with an empty equipment tag, no muscle
 *  credit, and (stored without `custom: true`) no way to edit or delete it (QA C7). The same gate
 *  runs on the way in as on the way out, since a plan file is someone else's data: only muscles the
 *  map can draw, a secondary never repeating a primary, the way the form itself enforces. Fields
 *  that are empty stay absent, so a file written before this change reads the same as one after. */
function cleanCustom(c) {
  const o = { id: c.id, n: c.n, bp: c.bp }
  if (c.desc) o.desc = c.desc
  // The link to a video or guide travels with a shared plan (#246), cleaned both ways like any
  // other field of someone else's file; the exercise's own photo or video never does — it is a
  // file on the sender's device and server, and a plan file is plain JSON.
  const url = cleanUrl(c.url)
  if (url) o.url = url
  if (typeof c.eq === 'string' && c.eq) o.eq = c.eq
  const prim = muscleList(c.primaries)
  const sm = muscleList(c.secondaries).filter(m => !prim.includes(m))
  // `tg` is the legacy single primary; the form keeps it equal to the first primary.
  const tg = prim[0] || (CUSTOM_MUSCLES.has(c.tg) ? c.tg : '')
  if (tg) o.tg = tg
  if (prim.length) o.primaries = prim
  if (sm.length) o.secondaries = sm
  if (prim.length || sm.length) o.muscleGroups = [...prim, ...sm]
  return o
}

export function createPlanImport({ t, catalogue, newId, today }) {
  const modeOf = cfg => modeOfWith(cfg, catalogue.isCardio)
  const unitError = () => { throw new Error(t('this isn’t an openGym plan file')) }

  function declaredPlanUnit(data) {
    let declared = null
    for (const key of ['unit', 'weightUnit']) {
      if (data[key] == null) continue
      const unit = planUnit(data[key])
      if (!unit || (declared && declared !== unit)) unitError()
      declared = unit
    }
    return declared
  }

  function convertedExercise(e, sourceUnit, destinationUnit) {
    if (!sourceUnit || sourceUnit === destinationUnit) return e
    const out = { ...e }
    if (out.weight != null) out.weight = convertWeight(out.weight, sourceUnit, destinationUnit)
    // A timed increment is seconds, not a load. Rep-mode increments are load overrides.
    if (modeOf(out) === 'reps' && out.inc > 0) out.inc = convertWeight(out.inc, sourceUnit, destinationUnit)
    if (Array.isArray(out.pyramidWeight)) out.pyramidWeight = out.pyramidWeight.map(w => (w > 0 ? convertWeight(w, sourceUnit, destinationUnit) : w))
    return out
  }

  function convertedBundle(bundle, destinationUnit) {
    const sourceUnit = declaredPlanUnit(bundle)
    if (!sourceUnit || sourceUnit === destinationUnit) return bundle
    return {
      ...bundle,
      unit: destinationUnit,
      routines: (bundle.routines || []).map(r => ({
        ...r,
        ex: (r.ex || []).map(e => convertedExercise(e, sourceUnit, destinationUnit))
      }))
    }
  }

  // Keep only the meaningful config fields, so the file stays small and readable.
  function cleanEx(e) {
    const o = { id: e.id, sets: e.sets }
    const mode = modeOf(e)
    if (mode === 'cardio') {
      if (e.min != null) o.min = e.min
      if (e.speed != null) o.speed = e.speed
    } else if (mode === 'time') {
      // Written out even though 'reps' is the fallback for a non-cardio id: a plan file that
      // dropped the mode would turn a 45-second plank into a 45-rep one at the other end.
      o.mode = 'time'
      if (e.sec != null) o.sec = e.sec
      if (e.weight) o.weight = e.weight
    } else {
      if (e.reps != null) o.reps = e.reps
      if (e.weight) o.weight = e.weight
      // Pyramid sets are the prescription itself; without them a "12 · 8 · 6 · Max · 12" arrives as 5 × 12.
      if (isPyramid(e)) {
        o.pyramid = normalizePyramid(e.pyramid)
        const rest = normalizePyramidRest(e.pyramidRest, o.pyramid.length)
        if (rest.length) o.pyramidRest = rest
        const weight = normalizePyramidWeight(e.pyramidWeight, o.pyramid.length)
        if (weight.length) o.pyramidWeight = weight
      }
    }
    // How the exercise is logged travels too (issues #31/#32) — the bodyweight flag only when
    // it disagrees with the catalogue, since agreeing is what the other end already assumes.
    if (e.bodyweight != null && e.bodyweight !== catalogue.isBodyweightEq(e.id)) o.bodyweight = e.bodyweight
    // Reps work and timed holds (a per-side hold is an L and an R hold per set); never cardio.
    if (e.side && mode !== 'cardio') o.side = true
    // Progression settings travel with the plan — a shared Greyskull routine that arrives
    // without its rule is just a list of weights.
    if (e.prog) o.prog = e.prog
    if (e.inc > 0) o.inc = e.inc
    // Back-off sets step down by that same step; written only when on (lib/backoff.js).
    if (isBackoff(e)) o.backoff = true
    // "Last set to failure" is how the exercise is prescribed too; only when on, never on cardio.
    if (e.lastToFailure === true && mode !== 'cardio') o.lastToFailure = true
    // Epley deload factor is a per-occurrence progression setting. Omit the default so older
    // exports remain compact and importing them preserves the default 90% behaviour.
    if (e.deloadFactor != null && Number(e.deloadFactor) !== 0.9) o.deloadFactor = e.deloadFactor
    // What a dumbbell weight means in this slot (lib/dumbbells.js): without it "20 each" arrives
    // as a bare 20 and the other end counts half the volume.
    if (dbLoadOf(e.dbLoad)) o.dbLoad = dbLoadOf(e.dbLoad)
    if (e.repsMin != null) o.repsMin = e.repsMin
    // Triple progression's set ceiling (progression.js tripleSetsOf), rep work only.
    if (mode === 'reps' && e.setsMax > 0) o.setsMax = Math.min(MAX_TRIPLE_SETS, Math.round(e.setsMax))
    if (e.repsMax != null) o.repsMax = e.repsMax
    // The exercise's own rest (issue #10) is part of how it is prescribed, so it travels too —
    // only when set, so a plan that never asked for one leaves the recipient's own default
    // timer in charge. parsePlan and mergePlan carry it through by spread.
    if (e.restSec > 0) o.restSec = e.restSec
    if (e.warmupRestSec > 0) o.warmupRestSec = e.warmupRestSec   // the ramp's own rest travels with the work rest
    // The warm-ups' "no timer" and the break between sides travel the same way, only when set.
    // Planned substitutes (lib/routine-backups.js): the catalogue's only, since the other end may
    // not have someone's own exercises.
    const subs = cleanBackups(e.subs, e.id, catalogue.isBuiltIn)
    if (subs.length) o.subs = subs
    if (e.warmupRestOff === true) o.warmupRestOff = true
    if (e.side && e.sideRestSec > 0) o.sideRestSec = e.sideRestSec
    if (e.sg) {
      o.sg = e.sg
      // A superset's name and its rest between rounds (#292) ride on every member, so they travel
      // with the group; without them a shared "Arms · 90 s" arrives nameless, resting the default.
      const name = cleanSgName(e.sgName), rest = cleanRestSec(e.sgRest)
      if (name) o.sgName = name
      if (rest) o.sgRest = rest
    }
    if (e.note) o.note = e.note
    const warm = cleanWarmupSets(e.warmupSets)
    if (warm) o.warmupSets = warm
    // Drop-sets and rest-pause are part of how the exercise is prescribed, not a logging detail.
    // Without this a shared "3x5 with a double drop" arrived at the other end as a plain 3x5,
    // silently — parsePlan's `dropped` counter only tracks exercises it cannot resolve at all.
    const intens = cleanIntensifier(e.intensifier)
    if (intens) o.intensifier = intens
    return o
  }

  /** Build the shareable bundle: every routine, the week schedule, referenced customs. */
  function buildPlanBundle(S, name) {
    const unit = planUnit(S.unit == null ? 'kg' : S.unit)
    if (!unit) unitError()
    const routines = (S.routines || []).map(r => ({
      id: r.id, name: r.name, emoji: r.emoji,
      ...(r.prog ? { prog: r.prog } : {}),
      ...(r.excludeFromProgression === true ? { excludeFromProgression: true } : {}),
      ex: (r.ex || []).map(cleanEx)
    }))
    const usedIds = new Set(routines.flatMap(r => r.ex.map(e => e.id)))
    const customEx = (S.customEx || [])
      .filter(c => usedIds.has(c.id))
      .map(cleanCustom)
    // A weekday can hold several routines (merge order preserved). `[].concat` normalises a
    // legacy scalar id to a one-element list, so a bundle written before this change and one
    // written after are read the same way at the other end.
    const week = {}
    WEEK_DAYS.forEach(d => { if (S.week?.[d]?.length) week[d] = [].concat(S.week[d]) })
    return { opengym_plan: PLAN_FMT, exported: today(), name: name || '', unit, week, routines, customEx }
  }

  /**
   * Validate + normalise an imported file. Throws with a friendly message if it isn't one.
   *
   * Every exercise id has to resolve — either to the built-in library or to a custom
   * exercise carried in the same file. An id that resolves to neither (a hand-edited file,
   * an export from a build with a different exercise dataset) is dropped here: kept, it
   * would sit invisibly in the routine and only surface as a blank screen when the routine
   * is trained.
   */
  function parsePlan(raw, destinationUnit = 'kg') {
    const notPlan = () => Object.assign(new Error(t('this isn’t an openGym plan file')), { code: 'not-plan' })
    let data = raw
    if (typeof raw === 'string') { try { data = JSON.parse(raw) } catch { throw notPlan() } }
    const destination = planUnit(destinationUnit)
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.opengym_plan || !Array.isArray(data.routines) || !destination) {
      throw notPlan()
    }
    const sourceUnit = declaredPlanUnit(data)
    const customEx = (Array.isArray(data.customEx) ? data.customEx : []).filter(c => c && c.id)
    const known = new Set(customEx.map(c => c.id))
    let dropped = 0
    const routines = data.routines.filter(r => r && Array.isArray(r.ex)).map(r => ({
      ...r,
      ex: r.ex.filter(e => {
        const ok = !!e && (known.has(e.id) || catalogue.exists(e.id))
        if (!ok) dropped++
        return ok
      }).map(e => {
        // The exercises pass through as written, so the fields that carry numbers into the
        // planner get the same clamps on the way in that they get on the way out. A drawing's id
        // (the female figure of an exercise) becomes the exercise's own.
        const warm = cleanWarmupSets(e.warmupSets)
        const intens = cleanIntensifier(e.intensifier)
        const rest = cleanRestSec(e.restSec)
        const warmRest = cleanRestSec(e.warmupRestSec)
        const warmOff = e.warmupRestOff === true
        const sideRest = cleanRestSec(e.sideRestSec)
        // Planned substitutes: the catalogue's only, as they are exported.
        const subs = cleanBackups(Array.isArray(e.subs) ? e.subs.map(x => (typeof x === 'string' ? catalogue.canonical(x) : x)) : [], known.has(e.id) ? e.id : catalogue.canonical(e.id), x => !known.has(x) && catalogue.isBuiltIn(x))
        // Superset meta only means something on a member of a superset; on a lone exercise it is dropped.
        const sgName = e.sg ? cleanSgName(e.sgName) : ''
        const sgRest = e.sg ? cleanRestSec(e.sgRest) : 0
        const pyramid = normalizePyramid(e.pyramid)
        const pyramidRest = pyramid.length ? normalizePyramidRest(e.pyramidRest, pyramid.length) : []
        const pyramidWeight = pyramid.length ? normalizePyramidWeight(e.pyramidWeight, pyramid.length) : []
        const { warmupSets, intensifier, restSec, warmupRestSec, warmupRestOff: _warmOff, sideRestSec: _sideRest, subs: _subs, pyramid: _pyramid, pyramidRest: _pyramidRest, pyramidWeight: _pyramidWeight, sgName: _sgName, sgRest: _sgRest, ...passthrough } = e
        if (!known.has(passthrough.id)) passthrough.id = catalogue.canonical(passthrough.id)
        return convertedExercise({ ...passthrough, ...(pyramid.length ? { pyramid } : {}), ...(pyramidRest.length ? { pyramidRest } : {}), ...(pyramidWeight.length ? { pyramidWeight } : {}), ...(warm ? { warmupSets: warm } : {}), ...(intens ? { intensifier: intens } : {}), ...(rest ? { restSec: rest } : {}), ...(warmOff ? { warmupRestOff: true } : warmRest ? { warmupRestSec: warmRest } : {}), ...(sideRest ? { sideRestSec: sideRest } : {}), ...(subs.length ? { subs } : {}), ...(sgName ? { sgName } : {}), ...(sgRest ? { sgRest } : {}) }, sourceUnit || destination, destination)
      })
    }))
    return {
      name: (data.name || '').trim(),
      routines,
      week: data.week || {},
      customEx,
      dropped,
      routineCount: routines.length,
      exerciseCount: routines.reduce((n, r) => n + r.ex.length, 0),
      scheduledDays: WEEK_DAYS.filter(d => data.week?.[d]?.length).length,
      // `unit` is the unit of the returned prescriptions. `sourceUnit` is null for a legacy file;
      // that absence means its numbers were intentionally treated as already in `destination`.
      unit: destination,
      sourceUnit: sourceUnit || null,
      destinationUnit: destination
    }
  }

  /**
   * Merge a parsed bundle into a draft state `s` (call inside store.update).
   *  - customs: reuse one you already have with the same name + body part, else add it fresh
   *  - routines: always added as NEW routines (fresh ids) — never overwrites yours
   *  - schedule: optional; when on, the shared week REPLACES yours (days the shared plan
   *    leaves empty become rest days — a half-overwritten week would silently mix two plans)
   *  - ids: optional `(kind, sourceId) => id` for the new routines ('routine') and customs
   *    ('custom'); a trainer's proposal is accepted with stable ids so a retry makes the same ones.
   * Returns how many routines were added and which new id each source routine and custom got.
   */
  function mergePlan(s, bundle, { schedule, ids } = {}) {
    const destination = planUnit(s.unit == null ? 'kg' : s.unit)
    if (!destination) unitError()
    const source = convertedBundle(bundle, destination)
    const idFor = ids || (() => newId())
    s.customEx = s.customEx || []
    const exIdMap = {}
    ;(source.customEx || []).forEach(c => {
      const same = s.customEx.find(x => (x.n || '').toLowerCase() === (c.n || '').toLowerCase() && x.bp === c.bp)
      if (same) { exIdMap[c.id] = same.id; return }
      const nid = idFor('custom', c.id)
      exIdMap[c.id] = nid
      // Stored exactly as the form would have created it — `custom: true` is what lets the recipient
      // edit or delete it, and `sm` mirrors the secondaries the way the form writes them.
      const clean = cleanCustom(c)
      s.customEx.push({ ...clean, id: nid, ...(clean.secondaries ? { sm: clean.secondaries } : {}), custom: true })
    })
    const ridMap = {}
    s.routines = s.routines || []
    source.routines.forEach(r => {
      const nid = idFor('routine', r.id)
      ridMap[r.id] = nid
      s.routines.push({
        id: nid,
        name: r.name || t('Shared routine'),
        emoji: r.emoji,
        ...(r.prog ? { prog: r.prog } : {}),
        ...(r.excludeFromProgression === true ? { excludeFromProgression: true } : {}),
        ex: (r.ex || []).map(e => ({ ...e, id: exIdMap[e.id] || catalogue.canonical(e.id) }))
      })
    })
    if (schedule) {
      s.week = s.week || {}
      WEEK_DAYS.forEach(d => { delete s.week[d] })
      Object.entries(source.week || {}).forEach(([d, val]) => {
        // `[].concat` tolerates a pre-upgrade scalar bundle value. An element whose routine id
        // didn't survive parsing is dropped, not written as undefined; a day that ends up empty
        // is left absent rather than stored as `[]`.
        const nids = [].concat(val).map(oldId => ridMap[oldId]).filter(Boolean)
        if (nids.length) s.week[d] = nids
      })
    }
    return { routines: source.routines.length, routineMap: ridMap, customMap: exIdMap }
  }

  return { buildPlanBundle, parsePlan, mergePlan, cleanEx }
}
