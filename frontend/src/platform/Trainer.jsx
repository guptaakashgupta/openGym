// The trainer's screen: current clients (online only), one client's gym progress, and proposing a
// plan made from the trainer's own routines — built with the app's plan-file format
// (lib/plan-share.js buildPlanBundle), so the routine editor stays the one place plans are made.
// The draft lives in this component until it is sent; sent versions come from the server.
import React, { useEffect, useState } from 'react'
import { t } from '../lib/i18n.js'
import { useStore } from '../store/useStore.js'
import { buildPlanBundle } from '../lib/plan-share.js'
import { myClients, sendProposal, proposals } from './api.js'
import { describeError } from './ui-errors.js'
import ClientProgress from './ClientProgress.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import './trainer.css'

function ProposalDraft({ client }) {
  const S = useStore(s => s.S)
  const [picked, setPicked] = useState([])
  const [sent, setSent] = useState([])
  const [problem, setProblem] = useState(null)
  useEffect(() => {
    proposals().then(p => setSent((p.sent || []).filter(x => x.recipientMembershipId === client.membershipId))).catch(e => setProblem(describeError(e)))
  }, [client.membershipId])
  const routines = S.routines || []
  const toggle = id => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))
  const send = async () => {
    const chosen = routines.filter(r => picked.includes(r.id))
    const bundle = buildPlanBundle({ ...S, routines: chosen, week: {} }, t('Plan for {0}', client.name))
    try {
      const { proposal } = await sendProposal(client.membershipId, bundle)
      setSent(s => [proposal, ...s.map(x => (x.status === 'pending' ? { ...x, status: 'superseded' } : x))])
      setPicked([])
      setProblem(null)
    } catch (e) { setProblem(describeError(e)) }
  }
  return (
    <section className="trainer-section trainer-proposal">
      <h2 className="sect-t">{t('Propose a plan')}</h2>
      <div className="trainer-proposal-body">
        {!routines.length && <p className="muted">{t('Make a routine in Plan first; it is what you send.')}</p>}
        {!!routines.length && <div className="trainer-routines">{routines.map(r => (
          <label key={r.id} className="trainer-routine"><input type="checkbox" aria-label={r.name} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} /><span>{r.name}</span></label>
        ))}</div>}
        {picked.length > 0 && <p className="trainer-draft">{t('Not sent yet: {0}', routines.filter(r => picked.includes(r.id)).map(r => r.name).join(', '))}</p>}
        <Button variant="primary" disabled={!picked.length} onClick={send}>{t('Send to {0}', client.name)}</Button>
        {problem && <p role="alert">{problem.message}</p>}
        {!!sent.length && <div className="trainer-sent"><h3>{t('Sent')}</h3>{sent.map(p => <p key={p.id}><span>{p.name || t('Plan')}</span><span>{p.status}</span></p>)}</div>}
      </div>
    </section>
  )
}

export default function Trainer() {
  const [clients, setClients] = useState(null)
  const [problem, setProblem] = useState(null)
  const [open, setOpen] = useState(null)
  useEffect(() => { myClients().then(c => setClients(c.clients || [])).catch(e => { setClients(null); setProblem(describeError(e)) }) }, [])

  if (problem) return <p className="pad" role="alert">{problem.message}</p>
  if (!clients) return <p className="muted pad">{t('Loading…')}</p>
  const client = clients.find(c => c.membershipId === open) || clients[0]
  return (
    <div className="trainer-page">
      <header className="hdr"><h1>{t('My clients')}</h1></header>
      {!clients.length && <div className="trainer-empty card"><Icon name="dumbbell" aria-hidden="true" /><p>{t('No clients assigned to you yet.')}</p></div>}
      {!!clients.length && <>
        <nav className="trainer-client-list" aria-label={t('My clients')}>
          {clients.map(c => <button className={`trainer-client${client.membershipId === c.membershipId ? ' is-active' : ''}`} aria-current={client.membershipId === c.membershipId ? 'true' : undefined} key={c.membershipId} onClick={() => setOpen(c.membershipId)}><span className="trainer-avatar" aria-hidden="true">{c.name?.trim().charAt(0).toLocaleUpperCase() || '•'}</span><span className="trainer-client-name">{c.name}</span><Icon name="chevronRight" aria-hidden="true" /></button>)}
        </nav>
        <div className="trainer-detail" key={client.membershipId}>
          <ClientProgress client={client} />
          <ProposalDraft client={client} />
        </div>
      </>}
    </div>
  )
}
