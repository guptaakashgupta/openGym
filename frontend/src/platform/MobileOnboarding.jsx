// Product phone app, first launch: pairing with the one service built in (config.js PILOT_SERVER).
// Passkeys cannot work inside the app's WebView and no password is typed here, so the member signs
// in — and joins their gym — in the browser, then enters the code from Settings → Account → “Pair
// the mobile app”. The upstream pairing does the rest (lib/remote.js connect, connectToServer).
import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { Button } from '../components/ui.jsx'
import { askAddDeviceData } from '../sheets.jsx'
import { PILOT_SERVER, PRODUCT_NAME } from './config.js'

export default function PilotOnboarding() {
  const { connectToServer } = useStore()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }
  const head = <>
    <div style={{ display: 'flex', justifyContent: 'center' }}><img src="icon-180.png" alt="" width="88" height="88" style={{ borderRadius: 20 }} /></div>
    <h1 style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-.028em', margin: '10px 0 4px' }}>{PRODUCT_NAME}</h1>
  </>
  if (!PILOT_SERVER) return (
    <div className="narrow" style={wrap}>
      {head}
      <div role="alert" className="muted">{t('This app was built without a valid service address. Install the app from the link your gym sent you.')}</div>
    </div>
  )
  const go = async () => {
    if (!code.trim()) { setError(t('Enter the code shown in your browser.')); return }
    setBusy(true)
    setError('')
    try { await connectToServer(PILOT_SERVER, code.trim(), askAddDeviceData) }
    catch (e) { setError(e.message || t('Could not connect')) }
    finally { setBusy(false) }
  }
  return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 20, lineHeight: 1.5 }}>
        {t('Sign in to {0} in your browser, open Settings → Account → “Pair the mobile app”, and enter the code shown there.', new URL(PILOT_SERVER).host)}
      </div>
      <Button icon="cloud" onClick={() => window.open(PILOT_SERVER + '/#/settings', '_blank', 'noopener')}>{t('Open the sign-in page')}</Button>
      <div style={{ height: 18 }} />
      <input className="input" placeholder={t('Pairing code')} maxLength={8} value={code} autoCapitalize="characters" autoCorrect="off"
        onChange={e => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
      {error && <div className="small" role="alert" style={{ color: 'var(--red)', marginTop: 10, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{error}</div>}
      <div style={{ height: 12 }} />
      <Button variant="primary" onClick={go} disabled={busy}>{busy ? t('Connecting…') : t('Connect')}</Button>
    </div>
  )
}
