// The shared gym pilot's product build (VITE_PILOT=1, scripts/build-pilot.mjs). Off in every
// upstream build, where nothing under platform/ is reachable.
export const PRODUCT = import.meta.env.VITE_PILOT === '1'
