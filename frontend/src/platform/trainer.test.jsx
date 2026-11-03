// @vitest-environment happy-dom
// The trainer's screen: current clients only, their gym workouts read live (never kept), and a
// plan proposal built from the trainer's own routine with the app's plan-file format. Work not
// yet sent is shown apart from what the member has received.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ myClients: vi.fn(), clientWorkouts: vi.fn(), sendProposal: vi.fn(), proposals: vi.fn(), platformMe: vi.fn() }))
const api = await import('./api.js')
const { useStore } = await import('../store/useStore.js')
const { default: Trainer } = await import('./Trainer.jsx')

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const CLIENTS = { clients: [{ membershipId: 'm-mem', gymId: 'g1', name: 'Mira' }] }
const WORKOUTS = { unit: 'kg', workouts: [{ id: 'w1', date: '2026-10-20', exercises: [{ exerciseId: '0025', custom: false, sets: [{ reps: 5, load: 100, done: true }] }] }],
  progress: [{ exerciseId: '0025', sessions: 1, bestLoad: 100, lastDate: '2026-10-20' }] }
const fail = status => Object.assign(new Error('x'), { status })

let host, root
const flush = () => act(async () => {})
const render = async () => { act(() => root.render(<MemoryRouter><Trainer /></MemoryRouter>)); await flush() }
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text))
const click = async el => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset?.()
  api.myClients.mockResolvedValue(CLIENTS)
  api.clientWorkouts.mockResolvedValue(WORKOUTS)
  api.proposals.mockResolvedValue({ received: [], sent: [] })
  useStore.setState({ user: { id: 'tr', name: 'Tariq' }, S: { ...useStore.getState().S, unit: 'kg', routines: [
    { id: 'r-a', name: 'Strength A', ex: [{ id: '0025', sets: 3, reps: 5, weight: 60 }] },
    { id: 'r-b', name: 'Cardio', ex: [{ id: '3220', sets: 1, min: 20, speed: 8 }] },
  ] } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('the trainer screen', () => {
  it('says so when no member is assigned', async () => {
    api.myClients.mockResolvedValue({ clients: [] })
    await render()
    expect(host.textContent).toContain('No clients assigned')
  })

  it('shows a client’s gym workouts and progress, read live and not kept', async () => {
    await render()
    expect(host.querySelector('.trainer-client.is-active')?.textContent).toContain('Mira')
    expect(api.clientWorkouts).toHaveBeenCalledWith('m-mem')
    expect(host.textContent).toContain('2026-10-20')
    expect(host.textContent).toContain('100')
    expect(JSON.stringify({ ...localStorage })).not.toContain('2026-10-20')
  })

  it('switches the visible client when there is more than one', async () => {
    api.myClients.mockResolvedValue({ clients: [...CLIENTS.clients, { membershipId: 'm-two', gymId: 'g1', name: 'Alex' }] })
    await render()
    await click(button('Alex'))
    expect(api.clientWorkouts).toHaveBeenCalledWith('m-two')
    expect(host.querySelector('.trainer-section-head h2')?.textContent).toBe('Alex')
    expect(host.querySelector('.trainer-client.is-active')?.textContent).toContain('Alex')
  })

  it('hides what it showed when access ends or the connection drops', async () => {
    await render()
    await click(button('Mira'))
    api.clientWorkouts.mockRejectedValueOnce(fail(404))
    await click(button('Refresh'))
    expect(host.textContent).not.toContain('2026-10-20')
    expect(host.textContent).toContain('not allowed')
    api.clientWorkouts.mockRejectedValueOnce(fail(undefined))
    await click(button('Refresh'))
    expect(host.textContent).toContain('offline')
    expect(host.textContent).not.toContain('2026-10-20')
  })

  it('proposes a plan built from the trainer’s own routine; unsent and sent are told apart', async () => {
    api.sendProposal.mockResolvedValue({ proposal: { id: 'pv1', status: 'pending', name: 'For Mira' } })
    await render()
    await click(button('Mira'))
    const box = host.querySelector('input[type="checkbox"][aria-label="Strength A"]')
    await act(async () => { box.click() })
    expect(host.textContent).toContain('Not sent yet')
    await click(button('Send to Mira'))
    const [membershipId, bundle] = api.sendProposal.mock.calls[0]
    expect(membershipId).toBe('m-mem')
    expect(bundle.opengym_plan).toBe(1)
    expect(bundle.routines.map(r => r.name)).toEqual(['Strength A'])
    expect(bundle.routines[0].ex[0]).toMatchObject({ id: '0025', sets: 3, reps: 5, weight: 60 })
    expect(host.textContent).toContain('Sent')
    expect(host.textContent).toContain('pending')
  })
})
