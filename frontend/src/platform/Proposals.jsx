// Plans a trainer has sent: what each would add (and, for an update, replace), which weekdays it
// would change — each one ticked by the member, or none — then Accept or Decline. Accepting goes
// through accept-plan.js; this screen only says what happened.
import React, { useEffect, useState } from 'react'
import { t } from '../lib/i18n.js'
import { DAYN } from '../lib/format.js'
import { proposals, proposal, declineProposal } from './api.js'
import { acceptPlan } from './accept-plan.js'
import { describeError } from './ui-errors.js'

const ORDER = [1, 2, 3, 4, 5, 6, 0]
const MESSAGES = {
  accepted: () => t('The plan was added to your plan.'),
  offline: () => t('You are offline. Accept the plan when you are connected.'),
  'workout-active': () => t('Finish your workout first; the plan is waiting.'),
  'sync-pending': () => t('Your own changes have not reached the server yet. Sync, then try again.'),
  conflict: () => t('Your data changed on another device. It has been synced; try again.'),
  'confirm-schedule': () => t('Tick the days you want this plan on, or leave them all empty.'),
  'preview-changed': () => t('Your routines changed since you looked. Check what will be replaced and accept again.'),
  'not-pending': () => t('This plan can no longer be accepted.'),
  denied: () => t('You are not allowed to see this, or it no longer exists.'),
  'signed-out': () => t('Sign in again to continue.'),
  unknown: () => t('The answer did not arrive. Accepting again is safe.'),
}

function Review({ id, onDone }) {
  const [p, setP] = useState(null)
  const [days, setDays] = useState([])
  const [outcome, setOutcome] = useState(null)
  const [problem, setProblem] = useState(null)
  useEffect(() => { proposal(id).then(setP).catch(e => setProblem(describeError(e))) }, [id])
  if (problem) return <p role="alert">{problem.message}</p>
  if (!p) return <p className="muted">{t('Loading…')}</p>
  const planDays = ORDER.filter(d => (p.bundle?.week?.[d] || []).length)
  const toggle = d => setDays(x => (x.includes(d) ? x.filter(y => y !== d) : [...x, d]))
  const accept = async () => {
    const r = await acceptPlan(id, { days, ...(p.replaces ? { replacedFingerprint: p.replaces.fingerprint } : {}) })
    if (r.kind === 'preview-changed') setP({ ...p, replaces: r.replaces })
    setOutcome(r.kind)
    if (r.kind === 'accepted') onDone()
  }
  const decline = async () => {
    try { await declineProposal(id); setOutcome('declined'); onDone() } catch (e) { setProblem(describeError(e)) }
  }
  return (
    <section>
      <h2>{p.name || t('Plan')}</h2>
      {p.trainerName && <p className="muted">{t('From {0}', p.trainerName)}</p>}
      {(p.bundle?.routines || []).map(r => <p key={r.id}>{r.name} · {t('{0} exercises', (r.ex || []).length)}</p>)}
      {p.replaces && <div className="card">
        <p>{t('This update replaces:')}</p>
        {p.replaces.routines.map(r => <p key={r.id}>{r.name}</p>)}
      </div>}
      {planDays.length > 0 && <>
        <p>{t('Days this plan would add to:')}</p>
        {planDays.map(d => (
          <label key={d}><input type="checkbox" aria-label={t(DAYN[d])} checked={days.includes(d)} onChange={() => toggle(d)} /> {t(DAYN[d])}</label>
        ))}
      </>}
      {p.status === 'pending' && outcome !== 'accepted' && outcome !== 'declined' && <>
        <button onClick={accept}>{t('Accept')}</button>
        <button onClick={decline}>{t('Decline')}</button>
      </>}
      {outcome && <p role="status">{outcome === 'declined' ? t('Declined.') : MESSAGES[outcome]()}</p>}
    </section>
  )
}

export default function Proposals() {
  const [list, setList] = useState(null)
  const [problem, setProblem] = useState(null)
  const [open, setOpen] = useState(null)
  const load = () => proposals().then(p => setList(p.received || [])).catch(e => { setList(null); setProblem(describeError(e)) })
  useEffect(() => { load() }, [])
  if (problem) return <p className="pad" role="alert">{problem.message}</p>
  if (!list) return <p className="muted pad">{t('Loading…')}</p>
  return (
    <div className="pad">
      <h1>{t('Plans from your trainer')}</h1>
      {!list.length && <p className="muted">{t('No plans yet.')}</p>}
      {list.map(p => <button key={p.id} onClick={() => setOpen(p.id)}>{p.name || t('Plan')} · {p.status}</button>)}
      {open && <Review key={open} id={open} onDone={load} />}
    </div>
  )
}
