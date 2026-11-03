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
import Icon from '../components/Icon.jsx'
import Owner from './Owner.jsx'
import Trainer from './Trainer.jsx'
import JoinGym from './JoinGym.jsx'
import Proposals from './Proposals.jsx'
import './join-token.js'   // keeps an invitation link across sign-in (read at load)
import './gym-home.css'

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
    <div className="gym-home">
      <header className="hdr"><h1>{t('Gym')}</h1></header>
      {!gym.roles.length && <div className="gym-home-empty card">
        <span className="gym-home-emblem" aria-hidden="true"><Icon name="dumbbell" /></span>
        <p>{t('You are not part of a gym yet. Ask your gym for an invitation.')}</p>
      </div>}
      {member && <>
        <section className="gym-home-membership" aria-label={t('Member of {0}', member.gymName)}>
          <span className="gym-home-emblem" aria-hidden="true"><Icon name="dumbbell" /></span>
          <div className="gym-home-membership-copy">
            <span>{t('Gym')}</span>
            <h2>{member.gymName}</h2>
          </div>
          <Icon name="checkCircle" className="gym-home-check" aria-hidden="true" />
        </section>
        <nav className="gym-home-actions" aria-label={t('Gym')}>
          <Link className="gym-home-action gym-home-action-main" to="/gym/proposals">
            <span className="gym-home-action-icon" aria-hidden="true"><Icon name="note" /></span>
            <span>{t('Plans from your trainer')}</span>
            <Icon name="chevronRight" className="gym-home-chevron" aria-hidden="true" />
          </Link>
          <div className="gym-home-action-pair">
            <Link className="gym-home-action" to="/plan"><Icon name="calendar" aria-hidden="true" /><span>{t('Your plan')}</span><Icon name="chevronRight" className="gym-home-chevron" aria-hidden="true" /></Link>
            <Link className="gym-home-action" to="/workout"><Icon name="play" aria-hidden="true" /><span>{t('Start workout')}</span><Icon name="chevronRight" className="gym-home-chevron" aria-hidden="true" /></Link>
          </div>
        </nav>
      </>}
      {(owner.length > 0 || trainer) && <nav className="gym-home-staff" aria-label={t('Gym')}>
        {owner.map(r => <Link className="gym-home-action" key={r.gymId} to={`/gym/owner/${encodeURIComponent(r.gymId)}`}><Icon name="dumbbell" aria-hidden="true" /><span>{t('Manage {0}', r.gymName)}</span><Icon name="chevronRight" className="gym-home-chevron" aria-hidden="true" /></Link>)}
        {trainer && <Link className="gym-home-action" to="/gym/trainer"><Icon name="list" aria-hidden="true" /><span>{t('My clients')}</span><Icon name="chevronRight" className="gym-home-chevron" aria-hidden="true" /></Link>}
      </nav>}
    </div>
  )
}

export function gymRoutes() {
  if (!PRODUCT) return null
  return (
    <>
      <Route path="/gym" element={<GymHome />} />
      <Route path="/gym/join" element={<JoinGym />} />
      <Route path="/gym/proposals" element={<Proposals />} />
      <Route path="/gym/owner/:gymId" element={<RequireRole role="owner"><Owner /></RequireRole>} />
      <Route path="/gym/trainer" element={<RequireRole role="trainer"><Trainer /></RequireRole>} />
    </>
  )
}
