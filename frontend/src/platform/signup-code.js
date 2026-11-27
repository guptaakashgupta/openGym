// Product sign-up with a trainer's or gym's code (docs/plans/2026-11-26-adopt-upstream-trainers.md
// section 3). The code gets the account made; consent stays on the connect screen, which opens next
// with the code filled in. Nothing here connects or joins.
import { PRODUCT } from './config.js'
import { closeThenNav } from '../lib/nav.js'

const CONNECT = '#/settings/trainer'

/** The code in a trainer's QR link (#/settings/trainer?code=…), for the sign-up form. */
export function codeFromHash(hash) {
  if (!String(hash || '').startsWith(CONNECT + '?')) return ''
  return (new URLSearchParams(hash.slice(CONNECT.length + 1)).get('code') || '').trim().toUpperCase().slice(0, 40)
}

export const initialSignupCode = () => (PRODUCT ? codeFromHash(location.hash) : '')

/** After the account is made: the connect screen, where the member confirms what to share. */
export async function openConnect(code, { close, refreshConfig }) {
  const c = String(code || '').trim()
  if (!PRODUCT || !c) return close()
  // Trainer settings are hidden until the signed-in configuration arrives.
  await refreshConfig()
  closeThenNav(close, `${CONNECT.slice(1)}?code=${encodeURIComponent(c)}`)
}
