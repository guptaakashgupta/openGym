// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

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
  it('prefills from the address and opens the connect screen after sign-up, never without a code', () => {
    location.hash = '#/settings/trainer?code=TR-ABCDE-FGHJK'
    expect(initialSignupCode()).toBe('TR-ABCDE-FGHJK')
    location.hash = '#/home'
    openConnect('  ')
    expect(location.hash).toBe('#/home')
    openConnect(' GY-ABCDE-FGHJK ')
    expect(location.hash).toBe('#/settings/trainer?code=GY-ABCDE-FGHJK')
  })
})
