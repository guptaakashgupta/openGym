// A gym invitation link (#/gym/join?token=…) opened by someone not signed in yet: the token is
// kept for the sign-in or signup that follows — in this tab only (sessionStorage), for ten
// minutes — then used once and dropped. Never in localStorage or the personal document.
import { PRODUCT } from './config.js'

const KEY = 'gym_join_token'
const TTL_MS = 10 * 60 * 1000
const TOKEN_RE = /[#/]gym\/join\?(?:[^#]*&)?token=([A-Za-z0-9_-]{10,200})/

export function captureJoinToken(hash = typeof location !== 'undefined' ? location.hash : '') {
  const m = TOKEN_RE.exec(hash || '')
  if (!m) return
  try { sessionStorage.setItem(KEY, JSON.stringify({ token: m[1], exp: Date.now() + TTL_MS })) } catch { /* no storage: the link still works while open */ }
}

export function pendingJoinToken() {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || 'null')
    if (v && v.exp > Date.now() && typeof v.token === 'string') return v.token
    sessionStorage.removeItem(KEY)
  } catch { /* unreadable: nothing pending */ }
  return null
}

export function clearJoinToken() { try { sessionStorage.removeItem(KEY) } catch { /* nothing to clear */ } }

// Read once as the app loads, before the sign-in screen can replace the address.
if (PRODUCT) captureJoinToken()
