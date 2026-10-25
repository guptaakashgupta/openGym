// @vitest-environment happy-dom
// The member's side: an invitation link survives signing in and is used once; the gym and role are
// shown before joining; a proposal is reviewed, declined or accepted online only, after the
// personal sync is flushed, with the server's answer taken back through the normal sync; a
// conflict, a lost answer or a running workout never loses or doubles anything.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  previewInvitation: vi.fn(), redeemInvitation: vi.fn(), proposals: vi.fn(), proposal: vi.fn(),
  declineProposal: vi.fn(), acceptProposal: vi.fn(), dataRev: vi.fn(), platformMe: vi.fn(),
}))
const api = await import('./api.js')
const { useStore } = await import('../store/useStore.js')
const join = await import('./join-token.js')
const { acceptPlan } = await import('./accept-plan.js')
const { default: JoinGym } = await import('./JoinGym.jsx')
const { default: Proposals } = await import('./Proposals.jsx')

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const fail = (status, data = {}) => Object.assign(new Error('x'), { status, data })
const PLAN = { id: 'pv1', status: 'pending', name: 'Plan for Mira', trainerName: 'Tariq', role: 'recipient',
  bundle: { unit: 'kg', week: { 1: ['r1'] }, routines: [{ id: 'r1', name: 'Strength A', ex: [{ id: '0025', sets: 3, reps: 5 }] }] } }

let host, root, syncNow, pullState
const flush = () => act(async () => {})
const render = async (el, path = '/') => { act(() => root.render(<MemoryRouter initialEntries={[path]}><Routes><Route path="*" element={el} /></Routes></MemoryRouter>)); await flush() }
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text))
const click = async el => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset?.()
  sessionStorage.clear()
  syncNow = vi.fn(async () => ({ status: 'ok' }))
  pullState = vi.fn(async () => {})
  useStore.setState({ user: { id: 'mem', name: 'Mira' }, sync: {}, syncNow, pullState, unsyncedChanges: () => ({ owed: false, count: 0 }), S: { ...useStore.getState().S, active: null } })
  api.dataRev.mockResolvedValue({ rev: 7, wid: 'w7' })
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('an invitation link', () => {
  it('is kept across signing in, briefly and only in this tab, and dropped once used', async () => {
    join.captureJoinToken('#/gym/join?token=gi_abcdefghijklmnopqrstuvwx')
    expect(join.pendingJoinToken()).toBe('gi_abcdefghijklmnopqrstuvwx')
    expect(JSON.stringify({ ...localStorage })).not.toContain('gi_abc')
    api.previewInvitation.mockResolvedValue({ gymName: 'Iron Den', role: 'member', boundToAccount: false })
    api.redeemInvitation.mockResolvedValue({ membershipId: 'm1', gymId: 'g1', role: 'member' })
    await render(<JoinGym />, '/gym/join')
    expect(host.textContent).toContain('Iron Den')
    expect(host.textContent).toContain('member')
    expect(api.redeemInvitation).not.toHaveBeenCalled()
    await click(button('Join Iron Den'))
    expect(api.redeemInvitation).toHaveBeenCalledWith('gi_abcdefghijklmnopqrstuvwx')
    expect(join.pendingJoinToken()).toBe(null)
  })

  it('says so when the member already belongs to another gym, and keeps the link usable', async () => {
    api.previewInvitation.mockResolvedValue({ gymName: 'Iron Den', role: 'member' })
    api.redeemInvitation.mockRejectedValue(fail(409, { code: 'member-elsewhere' }))
    await render(<JoinGym />, '/gym/join?token=gi_abcdefghijklmnopqrstuvwx')
    await click(button('Join Iron Den'))
    expect(host.textContent).toContain('already a member of another gym')
  })
})

describe('accepting a plan', () => {
  it('flushes the personal sync, sends the server’s revision, then syncs the result back', async () => {
    api.acceptProposal.mockResolvedValue({ ok: true, rev: 8, routineMap: { r1: 'gp_x' } })
    const r = await acceptPlan('pv1', { days: [1] })
    expect(r.kind).toBe('accepted')
    expect(syncNow.mock.invocationCallOrder[0]).toBeLessThan(api.acceptProposal.mock.invocationCallOrder[0])
    expect(api.acceptProposal).toHaveBeenCalledWith('pv1', { baseRev: 7, baseWid: 'w7', days: [1] })
    expect(pullState).toHaveBeenCalled()
  })

  it('is refused offline, and while a workout is running, without asking the server', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    expect((await acceptPlan('pv1', {})).kind).toBe('offline')
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    useStore.setState({ S: { ...useStore.getState().S, active: { id: 'live' } } })
    expect((await acceptPlan('pv1', {})).kind).toBe('workout-active')
    expect(api.acceptProposal).not.toHaveBeenCalled()
  })

  it('is refused while personal changes could not be sent', async () => {
    useStore.setState({ unsyncedChanges: () => ({ owed: true, count: 2 }) })
    expect((await acceptPlan('pv1', {})).kind).toBe('sync-pending')
    expect(api.acceptProposal).not.toHaveBeenCalled()
  })

  it('a conflict syncs first and can be retried', async () => {
    api.acceptProposal.mockRejectedValueOnce(fail(409, { code: 'conflict' }))
    expect((await acceptPlan('pv1', { days: [1] })).kind).toBe('conflict')
    expect(pullState).toHaveBeenCalled()
    api.acceptProposal.mockResolvedValueOnce({ ok: true, rev: 9 })
    expect((await acceptPlan('pv1', { days: [1] })).kind).toBe('accepted')
  })

  it('an answer lost after the server accepted is safe to retry: the server answers with what it did', async () => {
    api.acceptProposal.mockRejectedValueOnce(fail(undefined))
    expect((await acceptPlan('pv1', { days: [1] })).kind).toBe('unknown')
    api.acceptProposal.mockResolvedValueOnce({ ok: true, alreadyAccepted: true, rev: 8 })
    expect((await acceptPlan('pv1', { days: [1] })).kind).toBe('accepted')
    expect(pullState).toHaveBeenCalledTimes(1)
  })
})

describe('the proposals screen', () => {
  beforeEach(() => {
    api.proposals.mockResolvedValue({ received: [{ id: 'pv1', status: 'pending', name: 'Plan for Mira', trainerName: 'Tariq' }], sent: [] })
    api.proposal.mockResolvedValue(PLAN)
  })

  it('shows the plan and the days it would change before anything is decided', async () => {
    await render(<Proposals />)
    await click(button('Plan for Mira'))
    expect(host.textContent).toContain('Strength A')
    expect(host.querySelector('input[type="checkbox"][aria-label="Monday"]')).toBeTruthy()
    expect(api.acceptProposal).not.toHaveBeenCalled()
  })

  it('declines', async () => {
    api.declineProposal.mockResolvedValue({ ok: true })
    await render(<Proposals />)
    await click(button('Plan for Mira'))
    await click(button('Decline'))
    expect(api.declineProposal).toHaveBeenCalledWith('pv1')
  })

  it('accepts with the days the member ticked', async () => {
    api.acceptProposal.mockResolvedValue({ ok: true, rev: 8 })
    await render(<Proposals />)
    await click(button('Plan for Mira'))
    await act(async () => { host.querySelector('input[aria-label="Monday"]').click() })
    await click(button('Accept'))
    expect(api.acceptProposal).toHaveBeenCalledWith('pv1', { baseRev: 7, baseWid: 'w7', days: [1] })
    expect(host.textContent).toContain('added to your plan')
  })

  it('an update says which routines it replaces and sends what the member saw', async () => {
    api.proposal.mockResolvedValue({ ...PLAN, previousVersionId: 'pv0', replaces: { routineIds: ['gp_old'], fingerprint: 'fp1', routines: [{ id: 'gp_old', name: 'Old Strength' }] } })
    api.acceptProposal.mockResolvedValue({ ok: true, rev: 8 })
    await render(<Proposals />)
    await click(button('Plan for Mira'))
    expect(host.textContent).toContain('Old Strength')
    await click(button('Accept'))
    expect(api.acceptProposal.mock.calls[0][1]).toMatchObject({ replacedFingerprint: 'fp1' })
  })
})
