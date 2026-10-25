// The shared gym pilot's product build (VITE_PILOT=1, scripts/build-pilot.mjs). Off in every
// upstream build, where nothing under platform/ is reachable.
export const PRODUCT = import.meta.env.VITE_PILOT === '1'

// The one service the product phone app pairs with, fixed at build time (VITE_PILOT_SERVER): an
// HTTPS origin, or null when the build carries none or something else — then nothing pairs.
export function pilotServer(raw) {
  try {
    const u = new URL(String(raw || ''))
    return u.protocol === 'https:' && u.hostname ? u.origin : null
  } catch { return null }
}
export const PILOT_SERVER = pilotServer(import.meta.env.VITE_PILOT_SERVER)
