// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { setNav } from '../lib/nav.js'

vi.mock('./config.js', () => ({ PRODUCT: true }))
const { codeFromHash, initialSignupCode, openConnect } = await import('./signup-code.js')

describe('product sign-up code', () => {
  it('reads the code from a trainer QR link only', () => {
    expect(codeFromHash('#/settings/trainer?code=tr-abcde-fghjk')).toBe('TR-ABCDE-FGHJK')
    expect(codeFromHash('#/settings/trainer?x=1&code=GY-ABCDE-FGHJK')).toBe('GY-ABCDE-FGHJK')
    expect(codeFromHash('#/settings/trainer')).toBe('')
    expect(codeFromHash('#/home?code=TR-ABCDE-FGHJK')).toBe('')
    expect(codeFromHash(undefined)).toBe('')
  })
  it('prefills from the address and waits for the signed-in configuration before opening consent', async () => {
    location.hash = '#/settings/trainer?code=TR-ABCDE-FGHJK'
    expect(initialSignupCode()).toBe('TR-ABCDE-FGHJK')
    const close = vi.fn()
    const navigate = vi.fn()
    setNav(navigate)
    let configurationLoaded
    const refreshConfig = vi.fn(() => new Promise(resolve => { configurationLoaded = resolve }))

    const connecting = openConnect(' GY-ABCDE-FGHJK ', { close, refreshConfig })
    expect(refreshConfig).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()

    configurationLoaded()
    await connecting
    expect(close).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/settings/trainer?code=GY-ABCDE-FGHJK')
  })

  it('closes ordinary signup without refreshing configuration or navigating', async () => {
    const close = vi.fn()
    const navigate = vi.fn()
    const refreshConfig = vi.fn()
    setNav(navigate)

    await openConnect('  ', { close, refreshConfig })

    expect(close).toHaveBeenCalledOnce()
    expect(refreshConfig).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})
