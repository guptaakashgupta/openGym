// @vitest-environment happy-dom
// The product build's hooks for workout visibility (workout-context.js): the server's membership
// is remembered when the roles load, a live session captures it at start and stages its event on
// finish, the next personal-state PUT carries it beside the document and only a stored write
// settles it; deleting the account forgets it.
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./config.js', () => ({ PRODUCT: true }))
vi.mock('../lib/api.js', async importOriginal => ({ ...(await importOriginal()), api: vi.fn() }))
const { api } = await import('../lib/api.js')
const { DEF, useStore } = await import('../store/useStore.js')
const { useGym } = await import('./useGym.js')
const { beginWorkout, finishWorkoutNow } = await import('../sheets.jsx')
const { pendingRecordings, forgetAccount } = await import('./workout-context.js')

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = v => JSON.parse(JSON.stringify(v))
const ctx = () => ({ account: 'a', server: useStore.getState().sync.server })
const puts = () => api.mock.calls.filter(([p, o]) => p === '/api/data' && o?.method === 'PUT').map(([, o]) => JSON.parse(o.body))

async function memberRecords() {
  api.mockResolvedValueOnce({ roles: [{ gymId: 'g1', gymName: 'G', role: 'member', membershipId: 'mem1' }] })
  await act(() => useGym.getState().load('a'))
  act(() => beginWorkout(null, null))
  const id = useStore.getState().S.active.id
  act(() => finishWorkoutNow())
  return id
}

beforeEach(() => {
  api.mockReset()
  localStorage.clear()
  useGym.getState().reset()
  useStore.setState({ user: { id: 'a', name: 'a' }, S: clone(DEF) })
  forgetAccount(ctx())   // the outbox keeps its copy in memory too
})

describe('workout visibility in the product build', () => {
  it('a live session started as a member is staged on finish and sent with the next push', async () => {
    const id = await memberRecords()
    expect(pendingRecordings(ctx()).fields.platformRecordings).toEqual([expect.objectContaining({ workoutId: id, membershipId: 'mem1' })])
    api.mockImplementation(async (p, o) => {
      if (o?.method !== 'PUT') return {}
      const { platformRecordings } = JSON.parse(o.body)
      return { rev: 1, wid: 'w', platformRecordings: platformRecordings.map(e => ({ eventId: e.eventId, result: 'granted' })) }
    })
    await useStore.getState().pushState()
    const [body] = puts()
    expect(body.state.workouts.map(w => w.id)).toContain(id)
    expect(body.platformRecordings.map(e => e.workoutId)).toEqual([id])
    expect(pendingRecordings(ctx())).toBeNull()
  })

  it('a push that fails keeps the event for the next one', async () => {
    await memberRecords()
    api.mockRejectedValue(Object.assign(new TypeError('Failed to fetch'), { status: 0 }))
    await useStore.getState().pushState()
    expect(puts()[0].platformRecordings).toHaveLength(1)
    expect(pendingRecordings(ctx()).fields.platformRecordings).toHaveLength(1)
  })

  it('a session started with no membership sends nothing beside the document', async () => {
    api.mockResolvedValueOnce({ roles: [] })
    await act(() => useGym.getState().load('a'))
    act(() => beginWorkout(null, null))
    act(() => finishWorkoutNow())
    api.mockResolvedValue({ rev: 1 })
    await useStore.getState().pushState()
    expect(puts()[0]).not.toHaveProperty('platformRecordings')
  })

  it('deleting the account forgets its pending events', async () => {
    await memberRecords()
    api.mockResolvedValue({ ok: true })
    await useStore.getState().deleteAccount('a')
    expect(pendingRecordings(ctx())).toBeNull()
  })
})
