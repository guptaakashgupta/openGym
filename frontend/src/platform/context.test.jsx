// @vitest-environment happy-dom
// The gym context: roles come from the server (GET /api/platform/me) into a store of their own,
// never from the personal document and never persisted; they belong to one signed-in account and
// are dropped the moment the account changes, signs out or is refused; a staff screen shows
// nothing while its role is being checked and leaves when the role is gone.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../lib/api.js', async importOriginal => ({ ...(await importOriginal()), api: vi.fn() }))
const { api } = await import('../lib/api.js')
const { useStore } = await import('../store/useStore.js')
const { useGym, startGymRoleRefresh } = await import('./useGym.js')
const { RequireRole } = await import('./Routes.jsx')
const { ctxOf, forgetAccount } = await import('./workout-context.js')
const { read } = await import('./workout-outbox.js')

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const roles = (...r) => ({ roles: r.map(([gymId, role]) => ({ gymId, gymName: gymId, role, membershipId: 'm-' + gymId + role })) })
const signIn = id => act(() => { useStore.setState({ user: id ? { id, name: id } : null }) })

beforeEach(() => { api.mockReset(); useGym.getState().reset(); useStore.setState({ user: null }) })

describe('the gym context', () => {
  it('loads member context on app start and sign-in without opening a gym screen, then refreshes it on return', async () => {
    useStore.setState({ ready: true })
    signIn('a')
    let current = roles(['g1', 'member'])
    api.mockImplementation(async path => path === '/api/platform/me' ? current : {})
    const stop = startGymRoleRefresh()
    try {
      await act(async () => {})
      expect(useGym.getState().roles[0].membershipId).toBe('m-g1member')
      signIn(null)
      current = roles(['g2', 'member'])
      signIn('a')
      await act(async () => {})
      expect(useGym.getState().roles[0].membershipId).toBe('m-g2member')
      current = roles(['g3', 'member'])
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      expect(useGym.getState().roles[0].membershipId).toBe('m-g3member')
      expect(read(ctxOf(useStore.getState())).membership).toBe('m-g3member')
    } finally { stop(); forgetAccount(ctxOf(useStore.getState())) }
  })
  it('loads roles for the signed-in account from the server and keeps them out of storage', async () => {
    signIn('a')
    api.mockResolvedValueOnce(roles(['g1', 'owner']))
    await act(() => useGym.getState().load('a'))
    expect(api).toHaveBeenCalledWith('/api/platform/me')
    expect(useGym.getState()).toMatchObject({ forUser: 'a', status: 'ready' })
    expect(useGym.getState().roles.map(r => r.role)).toEqual(['owner'])
    expect(JSON.stringify(useStore.getState().S || {})).not.toContain('owner')
    expect(JSON.stringify({ ...localStorage })).not.toContain('g1')
  })

  it('drops one account’s roles the moment another signs in on the same browser', async () => {
    signIn('a')
    api.mockResolvedValueOnce(roles(['g1', 'owner']))
    await act(() => useGym.getState().load('a'))
    signIn('b')
    expect(useGym.getState()).toMatchObject({ forUser: null, roles: [] })
    signIn(null)
    expect(useGym.getState().roles).toEqual([])
  })

  it('a refresh shows the roles as they are now, and a refused session clears them', async () => {
    signIn('a')
    api.mockResolvedValueOnce(roles(['g1', 'trainer']))
    await act(() => useGym.getState().load('a'))
    api.mockResolvedValueOnce(roles())
    await act(() => useGym.getState().load('a'))
    expect(useGym.getState().roles).toEqual([])
    api.mockRejectedValueOnce(Object.assign(new Error('not signed in'), { status: 401 }))
    await act(() => useGym.getState().load('a'))
    expect(useGym.getState()).toMatchObject({ status: 'signed-out', roles: [], forUser: null })
  })

  it('an answer that arrives after the account changed is thrown away', async () => {
    signIn('a')
    let resolve
    api.mockReturnValueOnce(new Promise(r => { resolve = r }))
    const pending = useGym.getState().load('a')
    signIn('b')
    resolve(roles(['g1', 'owner']))
    await act(() => pending)
    expect(useGym.getState().roles).toEqual([])
  })
})

describe('a staff route', () => {
  let host, root
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
  afterEach(() => { act(() => root.unmount()); host.remove() })
  const render = (path = '/gym/owner/g1') => act(() => root.render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/gym" element={<p>gym home</p>} />
        <Route path="/gym/owner/:gymId" element={<RequireRole role="owner"><p>staff data</p></RequireRole>} />
      </Routes>
    </MemoryRouter>))

  it('shows nothing while the role is checked, then the screen for the role', async () => {
    signIn('a')
    let resolve
    api.mockReturnValueOnce(new Promise(r => { resolve = r }))
    render()
    expect(host.textContent).not.toContain('staff data')
    await act(async () => { resolve(roles(['g1', 'owner'])) })
    expect(host.textContent).toContain('staff data')
  })

  it('sends a caller without the role back to the gym page', async () => {
    signIn('a')
    api.mockResolvedValue(roles(['g1', 'member']))
    render()
    await act(async () => {})
    expect(host.textContent).toContain('gym home')
    expect(host.textContent).not.toContain('staff data')
  })

  it('an owner of another gym is not an owner of this one', async () => {
    signIn('a')
    api.mockResolvedValue(roles(['g2', 'owner']))
    render('/gym/owner/g1')
    await act(async () => {})
    expect(host.textContent).not.toContain('staff data')
  })
})

describe('outside the product build', () => {
  it('adds nothing: one integration point, gated on the product flag', () => {
    // happy-dom gives import.meta.url a non-file scheme; vitest runs from frontend/.
    const app = readFileSync(join(process.cwd(), 'src', 'App.jsx'), 'utf8')
    expect(app.match(/gymRoutes\(/g)).toHaveLength(1)
    expect(app).toMatch(/\{PRODUCT && gymRoutes\(\)\}/)
  })
})
