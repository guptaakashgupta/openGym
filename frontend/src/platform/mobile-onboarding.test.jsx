// @vitest-environment happy-dom
// The product phone app's first screen: one fixed HTTPS service built in (VITE_PILOT_SERVER), no
// server address or Cloudflare fields, no password field in the WebView. The member signs in (and
// joins their gym) in the browser, then enters the pairing code shown there; the existing pairing
// (connect: token in the private pairing file, renewal, the account switch that asks about this
// phone's own unsynced work) does the rest.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cfg = vi.hoisted(() => ({ PRODUCT: true, PILOT_SERVER: 'https://gym.example.com' }))
vi.mock('./config.js', async importOriginal => {
  const real = await importOriginal()
  return { get PRODUCT() { return cfg.PRODUCT }, get PILOT_SERVER() { return cfg.PILOT_SERVER }, PRODUCT_NAME: 'Pilot Gym', pilotServer: real.pilotServer }
})
const files = vi.hoisted(() => new Map())
vi.mock('../lib/mobile.js', async importOriginal => ({
  ...(await importOriginal()),
  loadRemoteFile: async () => files.get('remote') || null,
  saveRemoteFile: async data => { files.set('remote', data) },
}))
vi.mock('../lib/api.js', async importOriginal => ({ ...(await importOriginal()), api: vi.fn(() => Promise.resolve({})), pairRedeem: vi.fn() }))

const { pairRedeem } = await import('../lib/api.js')
const { pilotServer } = await import('./config.js')
const { connect, renewToken } = await import('../lib/remote.js')
const { useStore } = await import('../store/useStore.js')
const { askAddDeviceData } = await import('../sheets.jsx')
const { default: PilotOnboarding } = await import('./MobileOnboarding.jsx')
const { default: App } = await import('../App.jsx')

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host, root, original
const render = async el => { await act(async () => root.render(el)) }
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const type = (input, value) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

beforeEach(() => {
  original = useStore.getState()
  cfg.PILOT_SERVER = 'https://gym.example.com'
  files.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useStore.setState(original)
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('the built-in service address', () => {
  it('accepts only an HTTPS origin', () => {
    expect(pilotServer('https://gym.example.com')).toBe('https://gym.example.com')
    expect(pilotServer('https://gym.example.com/')).toBe('https://gym.example.com')
    expect(pilotServer('http://gym.example.com')).toBeNull()
    expect(pilotServer('gym.example.com')).toBeNull()
    expect(pilotServer('https://')).toBeNull()
    expect(pilotServer('')).toBeNull()
    expect(pilotServer(undefined)).toBeNull()
  })
})

describe('the product onboarding screen', () => {
  it('names the service and offers browser sign-in and a pairing code, nothing else', async () => {
    await render(<PilotOnboarding />)
    expect(host.textContent).toContain('gym.example.com')
    expect(host.querySelector('input[type="password"]')).toBeNull()
    expect([...host.querySelectorAll('input')]).toHaveLength(1)
    expect(button('Cloudflare Access')).toBeUndefined()
    expect(button('Use on this device')).toBeUndefined()
  })

  it('opens the sign-in page in the external browser', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    await render(<PilotOnboarding />)
    act(() => button('Open the sign-in page').click())
    expect(open).toHaveBeenCalledWith('https://gym.example.com/#/settings', '_blank', 'noopener')
  })

  it('pairs with the code against the built-in service, asking about this phone’s own data', async () => {
    const connectToServer = vi.fn(() => Promise.resolve())
    useStore.setState({ connectToServer })
    await render(<PilotOnboarding />)
    type(host.querySelector('input'), 'ab12cd34')
    await act(async () => button('Connect').click())
    expect(connectToServer).toHaveBeenCalledWith('https://gym.example.com', 'AB12CD34', askAddDeviceData)
  })

  it('says why an expired or already used code was refused, and stays on the screen', async () => {
    useStore.setState({ connectToServer: vi.fn(() => Promise.reject(new Error('That code didn’t work. Codes last 5 minutes and work once, so grab a fresh one.'))) })
    await render(<PilotOnboarding />)
    type(host.querySelector('input'), 'AB12CD34')
    await act(async () => button('Connect').click())
    expect(host.querySelector('[role="alert"]').textContent).toContain('work once')
    expect(button('Connect').disabled).toBe(false)
  })

  it('refuses to pair when the build carries no valid HTTPS address', async () => {
    cfg.PILOT_SERVER = null
    const connectToServer = vi.fn()
    useStore.setState({ connectToServer })
    await render(<PilotOnboarding />)
    expect(host.querySelector('[role="alert"]')).toBeTruthy()
    expect(button('Connect')).toBeUndefined()
    expect(host.querySelector('input')).toBeNull()
  })

  it('is the screen the app’s onboarding gate shows in the product build', async () => {
    localStorage.setItem('gym_guest', '1')
    window.location.hash = '#/home'
    useStore.setState({ ready: true, boot: vi.fn(), needsMobileOnboarding: true, user: null })
    await render(<App />)
    expect(button('Open the sign-in page')).toBeTruthy()
    expect(button('Connect to my server')).toBeUndefined()
  })
})

describe('the pairing it reuses', () => {
  it('keeps the token in the private pairing file and renews it there', async () => {
    pairRedeem.mockResolvedValueOnce({ token: 'tok', user: { id: 'u1' } })
    await connect('https://gym.example.com', 'AB12CD34')
    expect(pairRedeem).toHaveBeenCalledWith('https://gym.example.com', 'AB12CD34')
    expect(files.get('remote')).toEqual({ mode: 'remote', base: 'https://gym.example.com', token: 'tok', user: { id: 'u1' } })
    await renewToken(files.get('remote'), 'tok2')
    expect(files.get('remote').token).toBe('tok2')
  })
})
