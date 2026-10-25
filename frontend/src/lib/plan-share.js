// Share a weekly plan.
//
// Two jobs:
//  1. A small, self-contained file a friend can import into THEIR openGym — just the
//     routines + the week schedule + the custom exercises those routines use. It never
//     carries workouts, weigh-ins or settings, and importing MERGES (adds routines with
//     fresh ids) so nothing the friend already has is touched.
//  2. A clean, printable page (Save as PDF) where a single exercise never splits across
//     a page break — each exercise, and each routine that fits, stays in one place.

import { EXIDX, canonicalExId, isBodyweightEq, isCustomEx, isCardio } from './exercises.js'
import { modeOf, exLine } from './history.js'
import { deriveSessionName } from './session-merge.js'
import { uid, todayISO, DAYN, weekOrder, weekStartOf, exCount } from './format.js'
import { t, exerciseNameFor, exerciseNameClass, getLang, RTL_LANGS } from './i18n-core.js'
import { fmtSpeed, speedUnitOf } from './speed.js'
import { createPlanImport, cleanIntensifier } from '../../../api/shared/plan-import.js'

// Building, reading and merging a plan file is api/shared/plan-import.js, shared with the API
// (a trainer's proposal is accepted there with the same rules). This module gives it the app's
// catalogue, translation and ids, and keeps the printable page below.
const core = createPlanImport({
  t,
  catalogue: {
    exists: id => !!EXIDX[id],
    isBuiltIn: id => !!EXIDX[id] && !isCustomEx(EXIDX[id]),
    isCardio,
    isBodyweightEq: id => isBodyweightEq(id),
    canonical: canonicalExId,
  },
  newId: uid,
  today: todayISO,
})

/** Build the shareable bundle: every routine, the week schedule, referenced customs. */
export const buildPlanBundle = core.buildPlanBundle
/** Validate + normalise an imported file; throws with a friendly message if it isn't one. */
export const parsePlan = core.parsePlan
/** Merge a parsed bundle into a draft state (call inside store.update); see plan-import.js. */
export const mergePlan = core.mergePlan

/* ------------------------------- printable PDF ------------------------------- */

const esc = str => String(str == null ? '' : str)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// One exercise's scheme, e.g. "3 × 8–12 · 60 kg · drop-set 1× −20%", "3 × 0:45" or
// "2 × 20 min @ 8 km/h" — the speed in the profile's unit (lib/speed.js), like the weight. The
// reps half is exLine's, so a double-progression range prints as the range it is ("8–12", not
// the top alone) and a per-side split reads "8/side" exactly as the routine editor shows it.
function scheme(e, unit, speedUnit) {
  const sets = e.sets || 1
  const mode = modeOf(e)
  if (mode === 'cardio') {
    const body = `${e.min || 20} min @ ${fmtSpeed(e.speed || 8, speedUnit)}`
    return sets > 1 ? `${sets} × ${body}` : body
  }
  const line = exLine({ ...e, reps: e.reps ?? 10 }, unit, speedUnit)
  const extras = [intensifierLine(e.intensifier), e.lastToFailure === true ? t('Last set to failure') : ''].filter(Boolean)
  return [line, ...extras].join(' · ')
}

// A drop-set or rest-pause is how the exercise is prescribed, so the printout names it — the
// sheet at the rack otherwise reads as plain straight sets.
function intensifierLine(x) {
  const intens = cleanIntensifier(x)
  if (!intens) return ''
  return intens.type === 'dropset'
    ? `${t('Drop-set')} ${intens.count}× −${intens.pct}%`
    : `${t('Rest-pause')} ${intens.totalReps} ${t('reps')}`
}

// Group consecutive exercises sharing a superset id into rendered units.
function units(ex) {
  const out = []
  ex.forEach((e, i) => {
    const prev = ex[i - 1]
    if (i > 0 && e.sg && prev?.sg === e.sg) out[out.length - 1].push(e)
    else out.push([e])
  })
  return out
}

// `bare` leaves out the routine's own heading, for a page that is this one routine and already
// names it at the top.
function routineHTML(r, unit, { bare = false, speedUnit } = {}) {
  const rows = units(r.ex).map(u => {
    const items = u.map(e => {
      const ex = EXIDX[e.id]
      const name = ex ? exerciseNameFor(ex) : t('Unknown exercise')
      // Translated, and set apart by a real space: glued to the name, "capitalize" read the two as
      // one word and printed "Curlupper Legs".
      const part = ex && ex.bp && ex.bp !== 'cardio' ? ` <span class="part">${esc(t(ex.bp))}</span>` : ''
      const note = e.note ? `<div class="ex-note">${esc(e.note)}</div>` : ''
      return `<div class="ex"><div class="ex-row"><div class="ex-n ${ex ? exerciseNameClass(ex) : ''}">${esc(name)}${part}</div><div class="ex-s">${esc(scheme(e, unit, speedUnit))}</div></div>${note}</div>`
    }).join('')
    return u.length > 1
      ? `<div class="ss"><div class="ss-tag">${esc(t('Superset'))}</div><div class="ss-items">${items}</div></div>`
      : items
  }).join('')
  const count = exCount(r.ex.length)
  return `<section class="routine">
    ${bare ? '' : `<div class="r-head"><h2>${esc(r.name)}</h2><span class="r-count">${esc(count)}</span></div>`}
    <div class="ex-list">${rows || `<div class="ex empty">${esc(t('No exercises yet.'))}</div>`}</div>
  </section>`
}

function weekHTML(S) {
  // The printout is read by whoever exported it, so the week runs in their order.
  const rows = weekOrder(weekStartOf(S)).map(d => {
    const names = [].concat(S.week?.[d] || [])
      .map(id => S.routines.find(x => x.id === id)?.name)
      .filter(Boolean)
    const val = names.length ? esc(deriveSessionName(names)) : `<span class="rest">${esc(t('Rest'))}</span>`
    return `<div class="w-row"><div class="w-day">${esc(t(DAYN[d]))}</div><div class="w-r">${val}</div></div>`
  }).join('')
  return `<div class="week">${rows}</div>`
}

/**
 * Full self-contained HTML for the print/PDF view. With `routineId` it is that one routine on
 * its own page (#282) — the session you take to the gym, not the week around it — so the week
 * schedule is left out and the routine's name is the page title.
 */
export function planPrintHTML(S, owner, { routineId } = {}) {
  const unit = S.unit || 'kg'
  const single = routineId ? (S.routines || []).find(r => r.id === routineId) || null : null
  const routines = routineId ? [single].filter(Boolean) : (S.routines || []).filter(r => r.ex && r.ex.length)
  const body = routines.length
    ? routines.map(r => routineHTML(r, unit, { bare: !!single, speedUnit: speedUnitOf(S) })).join('')
    : `<p class="none">${esc(t('No routines yet.'))}</p>`
  const title = single ? single.name : t('Weekly Training Plan')
  const sub = [single ? exCount(single.ex.length) : null, owner, todayISO()].filter(Boolean).map(esc).join(' · ')
  const week = routineId ? '' : `<h3 class="block">${esc(t('Week schedule'))}</h3>
  ${weekHTML(S)}
  <h3 class="block">${esc(t('Routines'))}</h3>`
  return `<!doctype html><html lang="${getLang()}" dir="${RTL_LANGS.has(getLang()) ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { margin: 16mm 15mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0; color: #16181d; background: #fff;
    font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-variant-numeric: tabular-nums;
  }
  .doc { max-width: 720px; margin: 0 auto; }
  header { border-bottom: 2px solid #16181d; padding-bottom: 12px; margin-bottom: 20px; }
  header .kicker { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #6a7a3a; font-weight: 700; }
  header h1 { font-size: 27px; letter-spacing: -.02em; margin: 3px 0 0; }
  header .sub { color: #6b7180; font-size: 13px; margin-top: 4px; }

  h3.block { font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: #8a90a0; margin: 0 0 8px; font-weight: 700; }

  .week { border: 1px solid #e4e6ec; border-radius: 10px; overflow: hidden; margin-bottom: 26px; break-inside: avoid; page-break-inside: avoid; }
  .w-row { display: flex; align-items: baseline; padding: 8px 14px; border-top: 1px solid #eef0f4; }
  .w-row:first-child { border-top: 0; }
  .w-day { width: 116px; font-weight: 600; color: #16181d; flex: none; }
  .w-r { text-transform: capitalize; }
  .rest, .w-r .rest { color: #a2a8b6; text-transform: none; }

  .routine { break-inside: avoid; page-break-inside: avoid; margin-bottom: 20px; padding: 14px 16px; border: 1px solid #e4e6ec; border-radius: 12px; }
  .r-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; border-bottom: 1px solid #eef0f4; padding-bottom: 8px; margin-bottom: 8px; break-after: avoid; page-break-after: avoid; }
  .r-head h2 { font-size: 18px; letter-spacing: -.01em; margin: 0; text-transform: capitalize; }
  .r-count { font-size: 12px; color: #8a90a0; white-space: nowrap; }

  .ex-list { display: flex; flex-direction: column; }
  .ex { display: flex; flex-direction: column; padding: 6px 0; break-inside: avoid; page-break-inside: avoid; }
  .ex + .ex, .ss + .ex, .ex + .ss { border-top: 1px solid #f2f3f6; }
  .ex-row { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; }
  .ex-n { font-weight: 500; }
  .ex-n.capitalize { text-transform: capitalize; }
  .ex-n .part { display: inline-block; text-transform: none; color: #9aa0ae; font-weight: 400; font-size: 12px; margin-inline-start: 4px; }
  .ex-n .part::first-letter { text-transform: uppercase; }
  .ex-s { color: #3d424e; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .ex-note { color: #6a7080; font-size: 12px; margin-top: 2px; }
  .ex.empty, .none { color: #a2a8b6; }

  .ss { break-inside: avoid; page-break-inside: avoid; border-inline-start: 3px solid #cfe08a; padding-inline-start: 12px; margin: 4px 0; }
  .ss-tag { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #6a7a3a; font-weight: 700; padding-top: 4px; }
  .ss .ex:first-of-type { padding-top: 2px; }

  footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #eef0f4; color: #a2a8b6; font-size: 11px; text-align: center; }
</style></head>
<body><div class="doc">
  <header>
    <div class="kicker">openGym</div>
    <h1>${esc(title)}</h1>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </header>
  ${week}
  ${body}
  <footer>${esc(t('Made with openGym'))} · opengym.ch</footer>
</div></body></html>`
}

/**
 * Render the plan and open the browser's print dialog (→ Save as PDF).
 * Uses a hidden iframe so we never navigate away or trip a popup blocker.
 * `opts` is planPrintHTML's: `{ routineId }` prints a single routine.
 */
export function printPlan(S, owner, opts) {
  const ifr = document.createElement('iframe')
  ifr.setAttribute('aria-hidden', 'true')
  ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;'
  document.body.appendChild(ifr)
  const cleanup = () => { try { ifr.remove() } catch (e) { /* */ } }
  const run = () => {
    const w = ifr.contentWindow
    if (!w) { cleanup(); return }
    w.onafterprint = cleanup
    setTimeout(cleanup, 60000)   // safety net if afterprint never fires
    w.focus()
    try { w.print() } catch (e) { cleanup() }
  }
  const doc = ifr.contentWindow.document
  doc.open(); doc.write(planPrintHTML(S, owner, opts)); doc.close()
  // Give the iframe a tick to lay out before printing.
  if (doc.readyState === 'complete') setTimeout(run, 120)
  else ifr.onload = () => setTimeout(run, 120)
}
