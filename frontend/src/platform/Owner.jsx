// The gym owner's screen: who is in the gym, which trainer coaches whom, invitations, and ending a
// membership. Everything is read from the server each time and held only in this component: no
// copy in localStorage, the personal document or a cache, and a refusal clears what was shown.
import React, { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { t } from '../lib/i18n.js'
import { gymMembers, gymInvitations, createInvitation, revokeInvitation, assignTrainer, endMembership } from './api.js'
import { describeError } from './ui-errors.js'
import { useGym } from './useGym.js'
import { Button } from '../components/ui.jsx'
import { copyText } from '../lib/clipboard.js'
import { useUI } from '../store/useUI.js'
import './owner.css'

export default function Owner() {
  const { gymId } = useParams()
  const [data, setData] = useState(null)       // { members, invitations } while allowed and online
  const [problem, setProblem] = useState(null)
  const [fresh, setFresh] = useState(null)     // the invitation just made: its token, shown once
  const [ending, setEnding] = useState(null)   // membership waiting for the second step
  const inviteLink = fresh ? `${location.origin}${location.pathname}#/gym/join?token=${fresh.token}` : ''

  const fail = e => {
    const p = describeError(e)
    setData(null)
    setProblem(p)
    if (p.kind === 'signed-out') useGym.getState().reset()
  }
  const load = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([gymMembers(gymId), gymInvitations(gymId)])
      setData({ members: m.members || [], invitations: i.invitations || [] })
      setProblem(null)
    } catch (e) { fail(e) }
  }, [gymId])
  useEffect(() => { load() }, [load])
  const act = fn => async () => { try { await fn(); await load() } catch (e) { fail(e) } }

  if (problem) return <div className="owner-page"><div className="card"><p role="alert">{problem.message}</p><Button onClick={load}>{t('Try again')}</Button></div></div>
  if (!data) return <p className="muted pad">{t('Loading…')}</p>

  const trainers = data.members.filter(m => m.role === 'trainer')
  const members = data.members.filter(m => m.role === 'member')
  const pending = data.invitations.filter(i => !i.consumedAt && !i.revokedAt)
  const invite = role => act(async () => setFresh(await createInvitation(gymId, role)))
  const copyInvite = async () => useUI.getState().toast(await copyText(inviteLink) ? t('Copied') : t('Could not copy'))

  return (
    <div className="owner-page">
      <header className="hdr"><h1>{t('Your gym')}</h1></header>

      <section className="owner-section">
        <h2 className="sect-t">{t('Members')}</h2>
        <div className="owner-group">
          {!members.length && <p className="owner-empty">{t('No members yet. Invite someone below.')}</p>}
          {members.map(m => (
            <div key={m.membershipId} className="owner-member">
              <strong>{m.name}</strong>
              <select aria-label={t('Trainer for {0}', m.name)} value={m.trainerMembershipId || ''}
                onChange={e => e.target.value && act(() => assignTrainer(gymId, m.membershipId, e.target.value))()}>
                <option value="">{t('No trainer')}</option>
                {trainers.map(tr => <option key={tr.membershipId} value={tr.membershipId}>{tr.name}</option>)}
              </select>
              <div className="owner-member-actions">
                {ending === m.membershipId
                  ? <>
                      <Button variant="danger" size="sm" onClick={act(async () => { await endMembership(gymId, m.membershipId); setEnding(null) })}>{t('Yes, end membership')}</Button>
                      <Button size="sm" onClick={() => setEnding(null)}>{t('Cancel')}</Button>
                    </>
                  : <Button variant="ghost" size="sm" onClick={() => setEnding(m.membershipId)}>{t('End {0}', m.name)}</Button>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="owner-section">
        <h2 className="sect-t">{t('Trainers')}</h2>
        <div className="owner-group">
          {!trainers.length && <p className="owner-empty">{t('No trainers yet.')}</p>}
          {trainers.map(tr => <div key={tr.membershipId} className="owner-trainer">{tr.name}</div>)}
        </div>
      </section>

      <section className="owner-section">
        <h2 className="sect-t">{t('Invitations')}</h2>
        <div className="owner-invite-actions">
          <Button variant="tinted" onClick={invite('member')}>{t('Invite a member')}</Button>
          <Button variant="tinted" onClick={invite('trainer')}>{t('Invite a trainer')}</Button>
        </div>
        {fresh && (
          <div className="owner-invite-link card">
            <p>{t('Send this to the person you invite. It is shown only now, works once, and can be revoked below.')}</p>
            <code>{inviteLink}</code>
            <Button variant="primary" icon="copy" onClick={copyInvite}>{t('Copy link')}</Button>
          </div>
        )}
        {!!pending.length && <div className="owner-group">
          {pending.map(i => (
            <div key={i.id} className="owner-pending">
              <span>{t('{0} invitation', i.role)}</span>
              <Button variant="danger" size="sm" onClick={act(() => revokeInvitation(gymId, i.id))}>{t('Revoke')}</Button>
            </div>
          ))}
        </div>}
      </section>
    </div>
  )
}
