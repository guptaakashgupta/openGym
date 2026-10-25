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
    <section>
      <h2>{t('Propose a plan')}</h2>
      {!routines.length && <p className="muted">{t('Make a routine in Plan first; it is what you send.')}</p>}
      {routines.map(r => (
        <label key={r.id}><input type="checkbox" aria-label={r.name} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} /> {r.name}</label>
      ))}
      {picked.length > 0 && <p className="muted">{t('Not sent yet: {0}', routines.filter(r => picked.includes(r.id)).map(r => r.name).join(', '))}</p>}
      <button disabled={!picked.length} onClick={send}>{t('Send to {0}', client.name)}</button>
      {problem && <p role="alert">{problem.message}</p>}
      <h3>{t('Sent')}</h3>
      {sent.map(p => <p key={p.id}>{p.name || t('Plan')} — {p.status}</p>)}
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
  const client = clients.find(c => c.membershipId === open)
  return (
    <div className="pad">
      <h1>{t('My clients')}</h1>
      {!clients.length && <p className="muted">{t('No clients assigned to you yet.')}</p>}
      {clients.map(c => <button key={c.membershipId} onClick={() => setOpen(c.membershipId)}>{c.name}</button>)}
      {client && <><ClientProgress key={client.membershipId} client={client} /><ProposalDraft client={client} /></>}
    </div>
  )
}
