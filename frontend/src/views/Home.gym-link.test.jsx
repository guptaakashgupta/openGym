// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import Home from './Home.jsx'

const nav = vi.fn()
vi.mock('react-router-dom', () => ({ useNavigate: () => nav }))
vi.mock('../platform/config.js', () => ({ PRODUCT: true }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), bwSheet: vi.fn(), goalSheet: vi.fn(), dayOverrideSheet: vi.fn(),
  calendarSheet: vi.fn(), startFlow: vi.fn(), bwDeltaColor: () => '', weighInsSheet: vi.fn(),
}))

let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
  nav.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useStore.setState(s => ({
    S: { ...s.S, routines: [], workouts: [], bodyweight: [], dayPlan: {}, week: {}, active: null, checkIn: true },
    user: null,
  }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const mount = () => act(() => root.render(<Home />))
const gymButton = () => [...host.querySelectorAll('button')].find(button => button.textContent.trim() === 'Gym')

describe('pilot Home gym entry', () => {
  it('opens the gym page while keeping QR check-in separate', () => {
    useStore.setState({ user: { id: 'u1', name: 'Dana' } })
    mount()

    expect(gymButton()).toBeTruthy()
    expect(host.textContent).toContain('Check in')
    act(() => gymButton().click())
    expect(nav).toHaveBeenCalledWith('/gym')
  })

  it('does not offer the gym page to a guest', () => {
    mount()
    expect(gymButton()).toBeFalsy()
  })
})
