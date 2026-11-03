// Plans a trainer has sent: what each would add (and, for an update, replace), which weekdays it
// would change — each one ticked by the member, or none — then Accept or Decline. Accepting goes
// through accept-plan.js; this screen only says what happened.
import React, { useEffect, useState } from 'react'
import { t } from '../lib/i18n.js'
import { DAYN } from '../lib/format.js'
import { proposals, proposal, declineProposal } from './api.js'
import { acceptPlan } from './accept-plan.js'
import { describeError } from './ui-errors.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import './proposals.css'

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
  const [busy, setBusy] = useState(false)
  useEffect(() => { proposal(id).then(setP).catch(e => setProblem(describeError(e))) }, [id])
  if (problem) return <p role="alert">{problem.message}</p>
  if (!p) return <p className="muted">{t('Loading…')}</p>
  const planDays = ORDER.filter(d => (p.bundle?.week?.[d] || []).length)
  const toggle = d => setDays(x => (x.includes(d) ? x.filter(y => y !== d) : [...x, d]))
  const accept = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await acceptPlan(id, { days, ...(p.replaces ? { replacedFingerprint: p.replaces.fingerprint } : {}) })
      if (r.kind === 'preview-changed') setP({ ...p, replaces: r.replaces })
      setOutcome(r.kind)
      if (r.kind === 'accepted') onDone()
    } catch (e) { setProblem(describeError(e)) }
    finally { setBusy(false) }
  }
  const decline = async () => {
    if (busy) return
    setBusy(true)
    try { await declineProposal(id); setOutcome('declined'); onDone() } catch (e) { setProblem(describeError(e)) }
    finally { setBusy(false) }
  }
  return (
    <section className="proposal-review">
      <div className="proposal-review-head"><div><h2>{p.name || t('Plan')}</h2>{p.trainerName && <p>{t('From {0}', p.trainerName)}</p>}</div></div>
      <div className="proposal-routines">
        {(p.bundle?.routines || []).map(r => <div className="proposal-routine" key={r.id}><span className="proposal-routine-icon" aria-hidden="true"><Icon name="dumbbell" /></span><strong>{r.name}</strong><span>{t('{0} exercises', (r.ex || []).length)}</span></div>)}
      </div>
      {p.replaces && <div className="proposal-replaces">
        <h3>{t('This update replaces:')}</h3>
        {p.replaces.routines.map(r => <p key={r.id}>{r.name}</p>)}
      </div>}
      {planDays.length > 0 && <>
        <h3 className="sect-t proposal-days-title">{t('Days this plan would add to:')}</h3>
        <div className="proposal-days">{planDays.map(d => (
          <label key={d} className="proposal-day"><input type="checkbox" aria-label={t(DAYN[d])} checked={days.includes(d)} onChange={() => toggle(d)} /><span>{t(DAYN[d])}</span></label>
        ))}</div>
      </>}
      {p.status === 'pending' && outcome !== 'accepted' && outcome !== 'declined' && <div className="proposal-actions">
        <Button variant="primary" disabled={busy} onClick={accept}>{t('Accept')}</Button>
        <Button variant="tinted" disabled={busy} onClick={decline}>{t('Decline')}</Button>
      </div>}
      {outcome && <p className="proposal-outcome" role="status">{outcome === 'declined' ? t('Declined.') : MESSAGES[outcome]()}</p>}
    </section>
  )
}

export default function Proposals() {
  const [list, setList] = useState(null)
  const [problem, setProblem] = useState(null)
  const [open, setOpen] = useState(null)
  const load = () => proposals().then(p => { setList(p.received || []); setProblem(null) }).catch(e => { setList(null); setProblem(describeError(e)) })
  useEffect(() => { load() }, [])
  if (problem) return <p className="pad" role="alert">{problem.message}</p>
  if (!list) return <p className="muted pad">{t('Loading…')}</p>
  const selected = list.find(p => p.id === open) || list[0]
  return (
    <div className="proposals-page">
      <header className="hdr"><h1>{t('Plans from your trainer')}</h1></header>
      {!list.length && <div className="proposals-empty card"><Icon name="note" aria-hidden="true" /><p>{t('No plans yet.')}</p></div>}
      {!!list.length && <>
        <nav className="proposals-list" aria-label={t('Plans from your trainer')}>
          {list.map(p => <button className={`proposals-list-item${selected.id === p.id ? ' is-active' : ''}`} aria-current={selected.id === p.id ? 'true' : undefined} key={p.id} onClick={() => setOpen(p.id)}><span className="proposals-list-icon" aria-hidden="true"><Icon name="note" /></span><span className="proposals-list-name">{p.name || t('Plan')}</span><span className="proposals-status">{p.status}</span><Icon name="chevronRight" aria-hidden="true" /></button>)}
        </nav>
        <Review key={selected.id} id={selected.id} onDone={load} />
      </>}
    </div>
  )
}
