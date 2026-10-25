// @vitest-environment happy-dom
// Which newly recorded workouts the device reports to the gym: the membership known when the
// recording started, kept per account and server beside the session (never in the personal
// document), staged on finish, sent with the next personal-state PUT and settled only from
// that PUT's answer. The phone's file mirror stands in for localStorage the WebView lost.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const files = new Map()
vi.mock('../lib/mobile.js', () => ({
  MOBILE: true,
  readJsonFile: async name => (files.has(name) ? JSON.parse(files.get(name)) : null),
  writeJsonFile: async (name, data) => { files.set(name, JSON.stringify(data)) },
}))

const A = { account: 'uA', server: 'https://gym.example' }
const B = { account: 'uB', server: 'https://gym.example' }
let last = null
const fresh = async () => { vi.resetModules(); last = await import('./workout-context.js'); await last.ready; return last }
const sent = (m, ctx) => m.pendingRecordings(ctx)?.fields.platformRecordings || []

// A previous test's file writes still queued would land in this one's "file".
beforeEach(async () => { await last?.flushed(); localStorage.clear(); files.clear() })

describe('membership context for new recordings', () => {
  it('a recording started offline under a known membership is staged with it on finish', async () => {
    const m = await fresh()
    m.rememberMembership(A, 'mem1')
    m.recordingStarted(A, 'w1')
    m.recordingFinished(A, 'w1')
    const [e] = sent(m, A)
    expect(e).toMatchObject({ workoutId: 'w1', membershipId: 'mem1' })
    expect(e.eventId).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/)
  })

  it('a recording started before joining stays private, even if the member joins mid-session', async () => {
    const m = await fresh()
    m.recordingStarted(A, 'w1')
    m.rememberMembership(A, 'mem1')
    m.recordingFinished(A, 'w1')
    expect(m.pendingRecordings(A)).toBeNull()
  })

  it('a recording finished after leaving keeps the membership it started under; the server decides', async () => {
    const m = await fresh()
    m.rememberMembership(A, 'mem1')
    m.recordingStarted(A, 'w1')
    m.rememberMembership(A, null)
    m.recordingFinished(A, 'w1')
    const out = m.pendingRecordings(A)
    expect(out.fields.platformRecordings[0].membershipId).toBe('mem1')
    out.settle({ platformRecordings: [{ eventId: out.fields.platformRecordings[0].eventId, result: 'denied' }] })
    expect(m.pendingRecordings(A)).toBeNull()
  })

  it('imported history, a restored backup and an edited workout never finish a recording', async () => {
    const m = await fresh()
    m.rememberMembership(A, 'mem1')
    // None of these paths start a recording: their workout ids arrive without a captured context.
    m.recordingFinished(A, 'imported-1')
    m.recordingFinished(A, 'restored-1')
    m.recordingFinished(A, 'edited-1')
    expect(m.pendingRecordings(A)).toBeNull()
  })

  it('a later recording replaces an abandoned one: only the session that started is recognised', async () => {
    const m = await fresh()
    m.rememberMembership(A, 'mem1')
    m.recordingStarted(A, 'discarded')
    m.recordingStarted(A, 'w2')
    m.recordingFinished(A, 'discarded')
    expect(m.pendingRecordings(A)).toBeNull()
    m.recordingFinished(A, 'w2')
    expect(sent(m, A).map(e => e.workoutId)).toEqual(['w2'])
  })

  it('survives a browser restart mid-session and after finishing', async () => {
    let m = await fresh()
    m.rememberMembership(A, 'mem1')
    m.recordingStarted(A, 'w1')
    m = await fresh()
    m.recordingFinished(A, 'w1')
    m = await fresh()
    expect(sent(m, A).map(e => e.workoutId)).toEqual(['w1'])
  })

  it('survives a native restart whose WebView storage was evicted', async () => {
    let m = await fresh()
    m.rememberMembership(A, 'mem1')
    m.recordingStarted(A, 'w1')
    m.recordingFinished(A, 'w1')
    await m.flushed()
    localStorage.clear()
    m = await fresh()
    expect(sent(m, A).map(e => e.workoutId)).toEqual(['w1'])
  })

  it('keeps events until the write that carried them is stored, and keeps deferred ones', async () => {
    const m = await fresh()
    m.rememberMembership(A, 'mem1')
    for (const id of ['w1', 'w2']) { m.recordingStarted(A, id); m.recordingFinished(A, id) }
    const out = m.pendingRecordings(A)
    expect(m.pendingRecordings(A).fields.platformRecordings).toHaveLength(2)   // a failed PUT settles nothing
    const [e1, e2] = out.fields.platformRecordings
    out.settle({ platformRecordings: [{ eventId: e1.eventId, result: 'granted' }, { eventId: e2.eventId, result: 'deferred' }] })
    expect(sent(m, A).map(e => e.eventId)).toEqual([e2.eventId])
    out.settle({})   // a server answering without results (file mode) settles nothing
    expect(sent(m, A)).toHaveLength(1)
  })

  it('sends at most 50 events per write and keeps a bounded backlog', async () => {
    const m = await fresh()
    m.rememberMembership(A, 'mem1')
    for (let i = 0; i < 260; i++) { m.recordingStarted(A, 'w' + i); m.recordingFinished(A, 'w' + i) }
    const out = sent(m, A)
    expect(out).toHaveLength(50)
    expect(out[0].workoutId).toBe('w60')   // the oldest beyond the backlog of 200 became private
  })

  it('account A signing out with pending work leaves it under A; account B sees and sends none of it', async () => {
    const m = await fresh()
    m.rememberMembership(A, 'mem1')
    m.recordingStarted(A, 'w1')
    m.recordingFinished(A, 'w1')
    // B signs in on the same device: no membership of A's, no event of A's.
    m.recordingStarted(B, 'w2')
    m.recordingFinished(B, 'w2')
    expect(m.pendingRecordings(B)).toBeNull()
    expect(m.pendingRecordings({ ...A, server: 'https://other.example' })).toBeNull()
    expect(sent(m, A).map(e => e.workoutId)).toEqual(['w1'])
  })

  it('deleting an account removes its context and outbox only', async () => {
    const m = await fresh()
    m.rememberMembership(A, 'mem1'); m.recordingStarted(A, 'w1'); m.recordingFinished(A, 'w1')
    m.rememberMembership(B, 'mem2'); m.recordingStarted(B, 'w2'); m.recordingFinished(B, 'w2')
    m.forgetAccount(A)
    await m.flushed()
    localStorage.clear()
    const n = await fresh()
    expect(n.pendingRecordings(A)).toBeNull()
    expect(sent(n, B).map(e => e.workoutId)).toEqual(['w2'])
  })
})
