// What a refused or failed gym request means to the person looking at the screen. Each kind is a
// different situation with a different next step, so they are never folded into one message.
import { t } from '../lib/i18n.js'

export function describeError(e) {
  const status = e?.status
  if (status === 401) return { kind: 'signed-out', message: t('Sign in again to continue.') }
  if (status === 403 || status === 404) return { kind: 'denied', message: t('You are not allowed to see this, or it no longer exists.') }
  if (status === 409) return { kind: 'conflict', message: t('Something changed in the meantime. Refresh and try again.') }
  if (!status) return { kind: 'offline', message: t('You are offline. Gym data shows only while connected.') }
  return { kind: 'error', message: t('The gym service is unavailable. Try again later.') }
}
