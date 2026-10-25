// Which newly recorded workouts this device reports to the gym (api/platform/workout-visibility.js).
// `ctx` is { account, server }: everything is kept per account and server (workout-outbox.js), so
// another account signing in on this device neither sees nor sends any of it, and a sign-out
// keeps it for when the account comes back.
//
// - The membership last confirmed by the server is remembered, so a session started offline
//   still knows it. A recording captures it when it starts (live sessions only: beginWorkout,
//   repeatWorkout — never a backfill, an import, a restore or an edit of a saved workout).
// - Finishing that same session stages one event, before the sync that carries the workout is
//   scheduled. No membership at the start, or a context that does not match, means private.
// - The events ride on the next personal-state PUT as `platformRecordings` and are dropped only
//   from that PUT's answer; `deferred` ones (the server did not have the workout yet) stay.
import { uid } from '../lib/format.js'
import { ready, flushed, read, write } from './workout-outbox.js'

export { ready, flushed }

// The signed-in account of the app's store, and the server it syncs with; null when signed out.
export const ctxOf = st => (st?.user?.id ? { account: st.user.id, server: st.sync?.server ?? null } : null)

const SEND = 200   // the server's limit per write; the full retained backlog fits one PUT
const KEEP = 200   // beyond it the oldest events are dropped: those workouts stay private

const recOf = ctx => read(ctx) || { membership: null, recording: null, events: [] }
const newEventId = () => (globalThis.crypto?.randomUUID?.() || uid() + uid())

export function rememberMembership(ctx, membershipId) {
  write(ctx, { ...recOf(ctx), membership: membershipId || null })
}

export function recordingStarted(ctx, sessionId) {
  const r = recOf(ctx)
  write(ctx, { ...r, recording: { sessionId, membershipId: r.membership } })
}

export function recordingFinished(ctx, sessionId) {
  const r = read(ctx)
  if (!r?.recording || r.recording.sessionId !== sessionId) return null
  const event = r.recording.membershipId ? { eventId: newEventId(), workoutId: sessionId, membershipId: r.recording.membershipId } : null
  write(ctx, { ...r, recording: null, events: event ? [...r.events, event].slice(-KEEP) : r.events })
  return event
}

// What the next PUT carries, and how to settle it from the answer of a write that was stored.
export function pendingRecordings(ctx) {
  const events = (read(ctx)?.events || []).slice(0, SEND)
  if (!events.length) return null
  return {
    fields: { platformRecordings: events },
    settle(answer) {
      const done = new Set((answer?.platformRecordings || []).filter(x => x && x.result !== 'deferred').map(x => x.eventId))
      if (!done.size) return
      const r = read(ctx)
      if (r) write(ctx, { ...r, events: r.events.filter(e => !done.has(e.eventId)) })
    },
  }
}

// Explicit account deletion only; a sign-out keeps everything for the account's return.
export function forgetAccount(ctx) { write(ctx, null) }
