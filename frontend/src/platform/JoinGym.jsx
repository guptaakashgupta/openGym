// Joining a gym from an invitation: the gym and the role are shown first, and only the member's
// tap joins. The token comes from the link, or from the one kept while they signed in.
import React, { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { t } from '../lib/i18n.js'
import { previewInvitation, redeemInvitation } from './api.js'
import { pendingJoinToken, clearJoinToken } from './join-token.js'
import { describeError } from './ui-errors.js'
import { useGym } from './useGym.js'
import { useStore } from '../store/useStore.js'

const refusal = e => {
  const code = e?.data?.code
  if (code === 'member-elsewhere') return t('You are already a member of another gym. Leave it first to join this one.')
  if (e?.status === 410) return t('This invitation can no longer be used. Ask your gym for a new one.')
  if (code === 'invite-recipient') return t('This invitation is for another account.')
  return describeError(e).message
}

export default function JoinGym() {
  const { search } = useLocation()
  const navigate = useNavigate()
  const token = new URLSearchParams(search).get('token') || pendingJoinToken()
  const [preview, setPreview] = useState(null)
  const [problem, setProblem] = useState(null)
  const [joined, setJoined] = useState(false)

  useEffect(() => {
    if (!token) return
    previewInvitation(token).then(setPreview).catch(e => setProblem(refusal(e)))
  }, [token])

  const join = async () => {
    try {
      await redeemInvitation(token)
      clearJoinToken()
      setJoined(true)
      const user = useStore.getState().user
      if (user) await useGym.getState().load(user.id)
      navigate('/gym', { replace: true })
    } catch (e) { setProblem(refusal(e)) }
  }

  if (!token) return <p className="pad">{t('Open the invitation link your gym sent you.')}</p>
  if (problem) return <p className="pad" role="alert">{problem}</p>
  if (!preview) return <p className="muted pad">{t('Checking…')}</p>
  return (
    <div className="pad">
      <h1>{preview.gymName}</h1>
      <p>{t('You are invited to join as a {0}.', t(preview.role))}</p>
      <p className="muted">{t('Your trainer will see the workouts you log while you are a member, not your earlier history, body measurements or photos.')}</p>
      {!joined && <button onClick={join}>{t('Join {0}', preview.gymName)}</button>}
    </div>
  )
}
