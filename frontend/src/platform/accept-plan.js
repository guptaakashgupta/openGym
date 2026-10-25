// Accepting a trainer's plan, from the member's device. Online only, and never while a workout is
// running (its prescription is already built). The personal sync goes first, so the server
// decides against a document that holds this device's work; the server's revision is what the
// acceptance is checked against; and the result comes back through the app's own sync (pullState),
// which adopts it, or merges it with anything changed on this device meanwhile. Nothing here sets
// revision or dirty flags by hand.
//
// Kinds: accepted, offline, workout-active, sync-pending, conflict, confirm-schedule (with days),
// preview-changed (with replaces), not-pending, denied, signed-out, unknown (the answer was lost:
// retrying is safe, the server answers an accepted version with its original result).
import { useStore } from '../store/useStore.js'
import { acceptProposal, dataRev } from './api.js'

export async function acceptPlan(versionId, choice = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { kind: 'offline' }
  const store = useStore.getState()
  if (store.S?.active) return { kind: 'workout-active' }
  await store.syncNow()
  const sync = useStore.getState().sync || {}
  if (sync.auth) return { kind: 'signed-out' }
  if (sync.offline) return { kind: 'offline' }
  if (useStore.getState().unsyncedChanges().owed) return { kind: 'sync-pending' }
  let base
  try { base = await dataRev() } catch (e) { return { kind: e?.status === 401 ? 'signed-out' : 'offline' } }
  try {
    const result = await acceptProposal(versionId, { baseRev: base.rev, ...(base.wid ? { baseWid: base.wid } : {}), ...choice })
    await useStore.getState().pullState()
    return { kind: 'accepted', result }
  } catch (e) {
    const code = e?.data?.code
    if (e?.status === 409 && code === 'conflict') { await useStore.getState().pullState(); return { kind: 'conflict' } }
    if (e?.status === 409 && code === 'confirm-schedule') return { kind: 'confirm-schedule', days: e.data.days || [] }
    if (e?.status === 409 && code === 'preview-changed') return { kind: 'preview-changed', replaces: e.data.replaces }
    if (e?.status === 409) return { kind: 'not-pending' }
    if (e?.status === 401) return { kind: 'signed-out' }
    if (e?.status === 403 || e?.status === 404) return { kind: 'denied' }
    return { kind: 'unknown' }
  }
}
