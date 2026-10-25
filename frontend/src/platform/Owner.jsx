// The gym owner's screen: who is in the gym, which trainer coaches whom, invitations, and ending a
// membership. Everything is read from the server each time and held only in this component: no
// copy in localStorage, the personal document or a cache, and a refusal clears what was shown.
import React, { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { t } from '../lib/i18n.js'
import { gymMembers, gymInvitations, createInvitation, revokeInvitation, assignTrainer, endMembership } from './api.js'
import { describeError } from './ui-errors.js'
import { useGym } from './useGym.js'

export default function Owner() {
  const { gymId } = useParams()
  const [data, setData] = useState(null)       // { members, invitations } while allowed and online
  const [problem, setProblem] = useState(null)
  const [fresh, setFresh] = useState(null)     // the invitation just made: its token, shown once
  const [ending, setEnding] = useState(null)   // membership waiting for the second step

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

  if (problem) return <div className="pad"><p role="alert">{problem.message}</p><button onClick={load}>{t('Try again')}</button></div>
  if (!data) return <p className="muted pad">{t('Loading…')}</p>

  const trainers = data.members.filter(m => m.role === 'trainer')
  const members = data.members.filter(m => m.role === 'member')
  const pending = data.invitations.filter(i => !i.consumedAt && !i.revokedAt)
  const invite = role => act(async () => setFresh(await createInvitation(gymId, role)))

  return (
    <div className="pad">
      <h1>{t('Your gym')}</h1>

      <h2>{t('Members')}</h2>
      {!members.length && <p className="muted">{t('No members yet. Invite someone below.')}</p>}
      {members.map(m => (
        <div key={m.membershipId} className="row">
          <span>{m.name}</span>
          <select aria-label={t('Trainer for {0}', m.name)} value={m.trainerMembershipId || ''}
            onChange={e => e.target.value && act(() => assignTrainer(gymId, m.membershipId, e.target.value))()}>
            <option value="">{t('No trainer')}</option>
            {trainers.map(tr => <option key={tr.membershipId} value={tr.membershipId}>{tr.name}</option>)}
          </select>
          {ending === m.membershipId
            ? <>
                <button onClick={act(async () => { await endMembership(gymId, m.membershipId); setEnding(null) })}>{t('Yes, end membership')}</button>
                <button onClick={() => setEnding(null)}>{t('Cancel')}</button>
              </>
            : <button onClick={() => setEnding(m.membershipId)}>{t('End {0}', m.name)}</button>}
        </div>
      ))}

      <h2>{t('Trainers')}</h2>
      {!trainers.length && <p className="muted">{t('No trainers yet.')}</p>}
      {trainers.map(tr => <p key={tr.membershipId}>{tr.name}</p>)}

      <h2>{t('Invitations')}</h2>
      <button onClick={invite('member')}>{t('Invite a member')}</button>
      <button onClick={invite('trainer')}>{t('Invite a trainer')}</button>
      {fresh && (
        <div className="card">
          <p>{t('Send this to the person you invite. It is shown only now, works once, and can be revoked below.')}</p>
          <code>{`${location.origin}${location.pathname}#/gym/join?token=${fresh.token}`}</code>
        </div>
      )}
      {pending.map(i => (
        <div key={i.id} className="row">
          <span>{t('{0} invitation', i.role)}</span>
          <button onClick={act(() => revokeInvitation(gymId, i.id))}>{t('Revoke')}</button>
        </div>
      ))}
    </div>
  )
}
