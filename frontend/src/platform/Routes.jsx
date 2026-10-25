// The gym screens (product build only), mounted by App.jsx through gymRoutes(). Staff screens
// sit behind RequireRole: nothing of them renders until the server has confirmed the role for
// this account, and a missing role goes back to the gym page. Hiding a screen is not the security;
// the API refuses the data either way.
import React, { useEffect } from 'react'
import { Route, Navigate, useParams, Link } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useGym, rolesIn } from './useGym.js'
import { PRODUCT } from './config.js'
import { t } from '../lib/i18n.js'
import Owner from './Owner.jsx'
import Trainer from './Trainer.jsx'

// Loads the roles for the signed-in account when they are not this account's, or not loaded yet.
function useGymRoles() {
  const user = useStore(s => s.user)
  const gym = useGym()
  useEffect(() => {
    if (user && (gym.forUser !== user.id || gym.status === 'idle')) gym.load(user.id)
  }, [user?.id, gym.forUser, gym.status])
  const current = !!user && gym.forUser === user.id && gym.status === 'ready'
  return { user, gym, current }
}

export function RequireRole({ role, children }) {
  const { gymId } = useParams()
  const { gym, current } = useGymRoles()
  if (!current) return <p className="muted pad">{gym.status === 'error' ? t('Could not reach the gym service. Try again when you are online.') : t('Checking…')}</p>
  const ok = gymId ? rolesIn(gym.roles, gymId).includes(role) : gym.roles.some(r => r.role === role)
  return ok ? children : <Navigate to="/gym" replace />
}

export function GymHome() {
  const { gym, current } = useGymRoles()
  if (!current) return <p className="muted pad">{t('Checking…')}</p>
  const owner = gym.roles.filter(r => r.role === 'owner')
  const trainer = gym.roles.some(r => r.role === 'trainer')
  const member = gym.roles.find(r => r.role === 'member')
  return (
    <div className="pad">
      <h1>{t('Gym')}</h1>
      {!gym.roles.length && <p>{t('You are not part of a gym yet. Ask your gym for an invitation.')}</p>}
      {member && <p>{t('Member of {0}', member.gymName)}</p>}
      {owner.map(r => <p key={r.gymId}><Link to={`/gym/owner/${encodeURIComponent(r.gymId)}`}>{t('Manage {0}', r.gymName)}</Link></p>)}
      {trainer && <p><Link to="/gym/trainer">{t('My clients')}</Link></p>}
    </div>
  )
}

export function gymRoutes() {
  if (!PRODUCT) return null
  return (
    <>
      <Route path="/gym" element={<GymHome />} />
      <Route path="/gym/owner/:gymId" element={<RequireRole role="owner"><Owner /></RequireRole>} />
      <Route path="/gym/trainer" element={<RequireRole role="trainer"><Trainer /></RequireRole>} />
    </>
  )
}
