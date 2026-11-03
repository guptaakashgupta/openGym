// @vitest-environment happy-dom
// The owner's screen: the gym's people, invitations shown once, trainer assignment, and ending a
// membership only after a second, explicit step. A refusal or lost connection shows what happened
// and no gym data; nothing of it is stored on the device.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  gymMembers: vi.fn(), gymInvitations: vi.fn(), createInvitation: vi.fn(), revokeInvitation: vi.fn(),
  assignTrainer: vi.fn(), endMembership: vi.fn(), platformMe: vi.fn(),
}))
vi.mock('../lib/clipboard.js', () => ({ copyText: vi.fn(async () => true) }))
const api = await import('./api.js')
const clipboard = await import('../lib/clipboard.js')
const { default: Owner } = await import('./Owner.jsx')

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const MEMBERS = { members: [
  { membershipId: 'm-own', userId: 'own', name: 'Olga', role: 'owner', trainerMembershipId: null },
  { membershipId: 'm-tr', userId: 'tr', name: 'Tariq', role: 'trainer', trainerMembershipId: null },
  { membershipId: 'm-tr2', userId: 'tr2', name: 'Tess', role: 'trainer', trainerMembershipId: null },
  { membershipId: 'm-mem', userId: 'mem', name: 'Mira', role: 'member', trainerMembershipId: 'm-tr' },
] }
const fail = status => Object.assign(new Error('x'), { status })

let host, root
const flush = () => act(async () => {})
const render = async () => {
  act(() => root.render(<MemoryRouter initialEntries={['/gym/owner/g1']}><Routes><Route path="/gym/owner/:gymId" element={<Owner />} /></Routes></MemoryRouter>))
  await flush()
}
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text))
const click = async el => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset?.()
  clipboard.copyText.mockClear()
  api.gymMembers.mockResolvedValue(MEMBERS)
  api.gymInvitations.mockResolvedValue({ invitations: [{ id: 'i1', role: 'member', expiresAt: '2026-11-01T00:00:00Z', consumedAt: null, revokedAt: null }] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('the owner screen', () => {
  it('lists members with their trainer, trainers, and pending invitations', async () => {
    await render()
    expect(api.gymMembers).toHaveBeenCalledWith('g1')
    expect(host.textContent).toContain('Mira')
    expect(host.textContent).toContain('Tariq')
    expect(host.querySelector('select[aria-label="Trainer for Mira"]').value).toBe('m-tr')
    expect(host.textContent).toContain('member invitation')
  })

  it('an invitation is shown once, as a link to join', async () => {
    api.createInvitation.mockResolvedValue({ token: 'gi_secret_token', invitation: { id: 'i2', role: 'member' } })
    await render()
    await click(button('Invite a member'))
    expect(api.createInvitation).toHaveBeenCalledWith('g1', 'member')
    expect(host.textContent).toContain('gi_secret_token')
    expect(button('Copy link')?.classList.contains('primary')).toBe(true)
    await click(button('Copy link'))
    expect(clipboard.copyText).toHaveBeenCalledWith(expect.stringContaining('#/gym/join?token=gi_secret_token'))
    expect(JSON.stringify({ ...localStorage })).not.toContain('gi_secret_token')
  })

  it('revokes a pending invitation', async () => {
    api.revokeInvitation.mockResolvedValue({ ok: true })
    await render()
    await click(button('Revoke'))
    expect(api.revokeInvitation).toHaveBeenCalledWith('g1', 'i1')
  })

  it('reassigns a member to another trainer', async () => {
    api.assignTrainer.mockResolvedValue({ assignment: { id: 'a2' } })
    await render()
    const select = host.querySelector('select[aria-label="Trainer for Mira"]')
    await act(async () => { select.value = 'm-tr2'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(api.assignTrainer).toHaveBeenCalledWith('g1', 'm-mem', 'm-tr2')
  })

  it('ends a membership only after the confirmation step', async () => {
    api.endMembership.mockResolvedValue({ ok: true })
    await render()
    await click(button('End Mira'))
    expect(api.endMembership).not.toHaveBeenCalled()
    await click(button('Yes, end membership'))
    expect(api.endMembership).toHaveBeenCalledWith('g1', 'm-mem')
  })

  it('says so when the gym has nobody yet', async () => {
    api.gymMembers.mockResolvedValue({ members: [MEMBERS.members[0]] })
    api.gymInvitations.mockResolvedValue({ invitations: [] })
    await render()
    expect(host.textContent).toContain('No members yet')
  })

  for (const [status, words] of [[403, 'not allowed'], [404, 'not allowed'], [401, 'Sign in again'], [0, 'offline']]) {
    it(`a ${status} answer shows why and no gym data`, async () => {
      api.gymMembers.mockRejectedValue(fail(status || undefined))
      await render()
      expect(host.textContent).toContain(words)
      expect(host.textContent).not.toContain('Mira')
    })
  }
})
