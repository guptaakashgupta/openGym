// Who the signed-in account is in the gym world: its roles, as the server says now. A store of
// its own — never part of the personal document (S), never saved to localStorage or a file —
// tied to one account: it empties the moment the account changes or signs out, an answer for an
// account that is no longer signed in is thrown away, and a refused session empties it too. What
// it holds decides which screens show; it decides nothing on the server, which checks every request.
import { create } from 'zustand'
import { useStore } from '../store/useStore.js'
import { onAppActive } from '../lib/mobile.js'
import { platformMe } from './api.js'
import { ctxOf, rememberMembership } from './workout-context.js'

const EMPTY = { forUser: null, status: 'idle', roles: [], error: null }
let requestId = 0

export const useGym = create((set, get) => ({
  ...EMPTY,
  reset: () => { requestId++; set(EMPTY) },
  async load(userId) {
    const currentRequest = ++requestId
    set({ forUser: userId, status: 'loading', error: null, ...(get().forUser === userId ? {} : { roles: [] }) })
    try {
      const me = await platformMe()
      if (currentRequest !== requestId || useStore.getState().user?.id !== userId || get().forUser !== userId) return
      const roles = Array.isArray(me?.roles) ? me.roles : []
      set({ status: 'ready', roles })
      // What a workout started offline is recorded under: the member role the server confirmed now.
      rememberMembership(ctxOf(useStore.getState()), roles.find(r => r.role === 'member')?.membershipId)
    } catch (e) {
      if (currentRequest !== requestId || get().forUser !== userId) return
      if (e?.status === 401) set({ ...EMPTY, status: 'signed-out' })
      else set({ status: 'error', error: e?.message || 'unavailable' })
    }
  },
}))

// The account changed (another one signed in on this browser, or none): nothing of the last one stays.
useStore.subscribe((s, prev) => { if (s.user?.id !== prev.user?.id) useGym.getState().reset() })

// Installed once by App in the product build. Roles also supply the membership captured when a
// workout starts, so refresh them even when the member never visits a gym screen.
export function startGymRoleRefresh() {
  const refresh = () => {
    const { user, ready } = useStore.getState()
    if (ready && user?.id) useGym.getState().load(user.id)
  }
  const unsubscribe = useStore.subscribe((s, prev) => {
    if ((s.user?.id !== prev.user?.id || s.ready !== prev.ready) && s.ready && s.user?.id) refresh()
  })
  const visible = () => { if (document.visibilityState === 'visible') refresh() }
  document.addEventListener('visibilitychange', visible)
  onAppActive(refresh)
  refresh()
  return () => { unsubscribe(); document.removeEventListener('visibilitychange', visible) }
}

export const rolesIn = (roles, gymId) => roles.filter(r => r.gymId === gymId).map(r => r.role)
