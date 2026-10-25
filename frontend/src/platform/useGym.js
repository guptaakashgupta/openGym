// Who the signed-in account is in the gym world: its roles, as the server says now. A store of
// its own — never part of the personal document (S), never saved to localStorage or a file —
// tied to one account: it empties the moment the account changes or signs out, an answer for an
// account that is no longer signed in is thrown away, and a refused session empties it too. What
// it holds decides which screens show; it decides nothing on the server, which checks every request.
import { create } from 'zustand'
import { useStore } from '../store/useStore.js'
import { platformMe } from './api.js'

const EMPTY = { forUser: null, status: 'idle', roles: [], error: null }

export const useGym = create((set, get) => ({
  ...EMPTY,
  reset: () => set(EMPTY),
  async load(userId) {
    set({ forUser: userId, status: 'loading', error: null, ...(get().forUser === userId ? {} : { roles: [] }) })
    try {
      const me = await platformMe()
      if (useStore.getState().user?.id !== userId || get().forUser !== userId) return
      set({ status: 'ready', roles: Array.isArray(me?.roles) ? me.roles : [] })
    } catch (e) {
      if (get().forUser !== userId) return
      if (e?.status === 401) set({ ...EMPTY, status: 'signed-out' })
      else set({ status: 'error', error: e?.message || 'unavailable' })
    }
  },
}))

// The account changed (another one signed in on this browser, or none): nothing of the last one stays.
useStore.subscribe((s, prev) => { if (s.user?.id !== prev.user?.id) useGym.getState().reset() })

export const rolesIn = (roles, gymId) => roles.filter(r => r.gymId === gymId).map(r => r.role)
