// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ sheets: [], setUser: vi.fn(), pullState: vi.fn(async () => {}), loadConfig: vi.fn(async () => {}) }))
vi.mock('../platform/config.js', () => ({ PRODUCT: true }))
vi.mock('../platform/api.js', () => ({ previewInvitation: vi.fn(), redeemInvitation: vi.fn() }))
vi.mock('../store/useStore.js', () => {
  const snapshot = () => ({ config: { invite_only: false, allow_guest: true }, S: {}, setUser: state.setUser,
    pullState: state.pullState, pushState: vi.fn(), loadConfig: state.loadConfig, adoptProfile: vi.fn(), setGuest: vi.fn() })
  const useStore = select => select ? select(snapshot()) : snapshot()
  useStore.getState = snapshot
  return { useStore, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snapshot = () => ({ toast: vi.fn(), openSheet: render => { state.sheets.push(render) } })
  const useUI = select => select ? select(snapshot()) : snapshot()
  useUI.getState = snapshot
  return { useUI }
})
vi.mock('../lib/api.js', () => ({ webauthnOK: () => true, passkeyRegister: vi.fn(), passkeyLogin: vi.fn(),
  passkeyError: e => e.message, bio: () => 'your fingerprint' }))
vi.mock('../components/PasswordAuth.jsx', () => ({ passwordOn: () => false, PasswordRegisterForm: () => null, openPasswordSignIn: vi.fn() }))
vi.mock('../components/Passkeys.jsx', () => ({ openDeviceLinkRedeem: vi.fn() }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn() }))
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.invalid' }))

const api = await import('../platform/api.js')
const auth = await import('../lib/api.js')
const join = await import('../platform/join-token.js')
const { default: Login } = await import('./Login.jsx')

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const token = 'gi_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
let host, root
const settle = () => act(async () => {})
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent === text)

beforeEach(() => {
  sessionStorage.clear()
  window.location.hash = ''
  state.sheets.length = 0
  state.setUser.mockClear()
  state.pullState.mockClear()
  api.previewInvitation.mockReset().mockResolvedValue({ gymName: 'Iron Den', role: 'member' })
  api.redeemInvitation.mockReset().mockResolvedValue({ alreadyRedeemed: true, gymId: 'g1', role: 'member' })
  auth.passkeyRegister.mockReset().mockResolvedValue({ id: 'new-member', name: 'Mira' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  join.captureJoinToken(`#/gym/join?token=${token}`)
})
afterEach(() => { act(() => root.unmount()); host.remove(); sessionStorage.clear(); window.location.hash = '' })

it('shows the gym invitation before signup and keeps its token visible in the form', async () => {
  act(() => root.render(<Login />))
  await settle()
  expect(host.textContent).toContain('Iron Den')
  expect(host.textContent).toContain('invited to join as a member')
  expect(button('Create new profile').classList.contains('primary')).toBe(true)
  expect(button('Continue without account')).toBeUndefined()
  act(() => button('Create new profile').click())
  const sheet = document.createElement('div')
  const sheetRoot = createRoot(sheet)
  act(() => sheetRoot.render(state.sheets[0](() => {})))
  expect(sheet.querySelector('input[placeholder="Invite code"]').value).toBe(token)
  expect(sheet.textContent).not.toContain('This app is invite-only')
  act(() => sheetRoot.unmount())
})

it('a recipient-bound invitation asks its existing account to sign in', async () => {
  api.previewInvitation.mockResolvedValue({ gymName: 'Iron Den', role: 'trainer', boundToAccount: true })
  act(() => root.render(<Login />))
  await settle()
  expect(host.textContent).toContain('Iron Den')
  expect(button('Create new profile')).toBeUndefined()
  expect(button('Sign in with passkey').classList.contains('primary')).toBe(true)
})

it('finishes an invited signup on the gym page after confirming redemption', async () => {
  act(() => root.render(<Login />))
  await settle()
  act(() => button('Create new profile').click())
  const sheet = document.createElement('div')
  const sheetRoot = createRoot(sheet)
  act(() => sheetRoot.render(state.sheets[0](() => {})))
  const name = sheet.querySelector('input[placeholder="Your name"]')
  act(() => {
    Object.getOwnPropertyDescriptor(name.constructor.prototype, 'value').set.call(name, 'Mira')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { sheet.querySelector('button').click() })
  expect(auth.passkeyRegister).toHaveBeenCalledWith('Mira', token)
  expect(api.redeemInvitation).toHaveBeenCalledWith(token)
  expect(join.pendingJoinToken()).toBeNull()
  expect(window.location.hash).toBe('#/gym')
  act(() => sheetRoot.unmount())
})
