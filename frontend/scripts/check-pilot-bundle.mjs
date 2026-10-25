#!/usr/bin/env node
/* The pilot product build's gates (docs/ops/PILOT_MOBILE_RELEASE.md), run by build-pilot.mjs on
 * what it wrote and usable on its own:
 *
 *   node scripts/check-pilot-bundle.mjs <product.json> <web dir> [android project dir]
 *
 * - validateProduct: the product's identity comes from explicit inputs — a name, its own
 *   reverse-DNS application id (never upstream's), an https server that is not upstream's, a
 *   media mode, an attribution and a source offer per version. iOS is refused until its targets
 *   are configured (the runbook lists them).
 * - checkPilotBundle: the files themselves — the build stamp matches the product, no upstream
 *   service address is in any text asset, the product server is, the web manifest carries the
 *   product name, OPEN-SOURCE.txt names the licence, upstream and this version's source offer,
 *   and no exercise media are present unless a licensed manifest names each file with its hash.
 *   The Android project's pilot.properties and packaged web copy get the same checks.
 *
 * Passing these checks is not legal clearance of anything; it only shows the build is what the
 * inputs say. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UPSTREAM_IDS = ['ch.duartesantos.opengym', 'ch.opengym.app']
const UPSTREAM_HOSTS = ['opengym.ch', 'duartesantos.ch']
// Addresses of upstream services a bundle must not call or send people to.
const UPSTREAM_URLS = [/https?:\/\/(www\.)?opengym\.ch/i, /api\.github\.com\/repos\/DuarteSantos8/i]
const APP_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const TEXT_EXT = /\.(js|mjs|html|json|webmanifest|css|txt)$/i
const MEDIA_DIR = 'exercise-media'

export function validateProduct(p) {
  const errors = []
  if (!p || typeof p !== 'object') return ['the product file is not a JSON object']
  if (typeof p.productName !== 'string' || !p.productName.trim()) errors.push('productName is required')
  if (typeof p.appId !== 'string' || !APP_ID_RE.test(p.appId)) errors.push('appId must be a reverse-DNS id such as com.example.app')
  else if (UPSTREAM_IDS.some(id => p.appId === id || p.appId.startsWith(id + '.'))) errors.push(`appId ${p.appId} is upstream openGym's`)
  let url = null
  try { url = new URL(p.server) } catch { /* below */ }
  if (!url || url.protocol !== 'https:' || url.origin !== String(p.server).replace(/\/$/, '')) errors.push('server must be an https origin such as https://gym.example.com')
  else if (UPSTREAM_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) errors.push(`server ${url.hostname} is upstream openGym's`)
  const mode = p.media?.mode
  if (mode !== 'placeholder' && mode !== 'licensed') errors.push('media.mode must be "placeholder" (no exercise media) or "licensed"')
  if (mode === 'licensed' && (typeof p.media.manifest !== 'string' || !fs.existsSync(p.media.manifest))) errors.push('media.mode "licensed" needs media.manifest, the licensed asset manifest')
  if (typeof p.source?.upstream !== 'string' || !p.source.upstream.startsWith('https://')) errors.push('source.upstream must link the upstream project')
  if (typeof p.source?.offerUrl !== 'string' || !p.source.offerUrl.startsWith('https://') || !p.source.offerUrl.includes('{version}')) errors.push('source.offerUrl must be an https URL with {version}, where this exact version\'s source is offered')
  if (p.ios?.enabled) errors.push('iOS pilot targets are not configured yet (App, OpenGymWidgets, Watch, WatchWidgets, AnimationPacksDownloader): see docs/ops/PILOT_MOBILE_RELEASE.md')
  return errors
}

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const walk = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, f)).filter(f => fs.statSync(f).isFile()) : [])
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

function checkMedia(dir, product, label) {
  const files = walk(path.join(dir, MEDIA_DIR)).filter(f => path.basename(f) !== 'NOTICE.md')
  if (!files.length) return []
  if (product.media?.mode !== 'licensed') return [`${label}: restricted media present (${files.length} file(s) under ${MEDIA_DIR}/) in a "${product.media?.mode}" build`]
  const manifest = readJson(product.media.manifest)
  const listed = new Map((manifest?.files || []).map(f => [f.path, f.sha256]))
  const problems = []
  for (const f of files) {
    const rel = path.relative(path.join(dir, MEDIA_DIR), f).split(path.sep).join('/')
    if (!listed.has(rel)) problems.push(`${label}: ${MEDIA_DIR}/${rel} is not in the licensed manifest`)
    else if (listed.get(rel) !== sha(f)) problems.push(`${label}: ${MEDIA_DIR}/${rel} does not match the licensed manifest's hash`)
  }
  return problems
}

function checkWeb(dir, product, version, label) {
  const problems = []
  const stamp = readJson(path.join(dir, 'pilot-build.json'))
  if (!stamp) problems.push(`${label}: no pilot-build.json (not a pilot product build)`)
  else if (stamp.appId !== product.appId || stamp.server !== product.server || stamp.productName !== product.productName || stamp.version !== version) {
    problems.push(`${label}: pilot-build.json identity does not match the product`)
  }
  const texts = walk(dir).filter(f => TEXT_EXT.test(f) && !f.includes(`${path.sep}${MEDIA_DIR}${path.sep}`))
  let namesServer = false
  for (const f of texts) {
    const text = fs.readFileSync(f, 'utf8')
    const hit = UPSTREAM_URLS.find(re => re.test(text))
    if (hit) problems.push(`${label}: ${path.relative(dir, f)} holds an upstream service address (${hit.source})`)
    if (f.endsWith('.js') && text.includes(product.server)) namesServer = true
  }
  if (!namesServer) problems.push(`${label}: the bundle does not name the product server ${product.server}`)
  const manifest = readJson(path.join(dir, 'manifest.json'))
  if (manifest && manifest.name !== product.productName) problems.push(`${label}: manifest.json is named "${manifest.name}", not the product`)
  const notice = fs.existsSync(path.join(dir, 'OPEN-SOURCE.txt')) ? fs.readFileSync(path.join(dir, 'OPEN-SOURCE.txt'), 'utf8') : null
  if (notice === null) problems.push(`${label}: no OPEN-SOURCE.txt (licence, upstream attribution, source offer)`)
  else {
    const offer = String(product.source?.offerUrl || '').replace('{version}', version)
    if (!notice.includes('AGPL-3.0-or-later') || !notice.includes(product.source?.upstream) || !notice.includes(offer)) {
      problems.push(`${label}: OPEN-SOURCE.txt lacks the licence, the upstream link or the source offer for ${version}`)
    }
  }
  return problems.concat(checkMedia(dir, product, label))
}

export function checkPilotBundle({ webDir, product, version, androidDir }) {
  const problems = checkWeb(webDir, product, version, 'web')
  if (androidDir) {
    const props = fs.existsSync(path.join(androidDir, 'pilot.properties')) ? fs.readFileSync(path.join(androidDir, 'pilot.properties'), 'utf8') : ''
    const appId = /^applicationId=(.*)$/m.exec(props)?.[1]?.trim()
    if (appId !== product.appId) problems.push(`android: pilot.properties applicationId is ${appId || 'missing'}, not ${product.appId}`)
    const packaged = path.join(androidDir, 'app/src/main/assets/public')
    if (fs.existsSync(packaged)) problems.push(...checkWeb(packaged, product, version, 'android'))
  }
  return problems
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [productFile, webDir, androidDir] = process.argv.slice(2)
  const product = readJson(productFile)
  const version = readJson(path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json')).version
  const problems = [...validateProduct(product), ...(webDir ? checkPilotBundle({ webDir, product, version, androidDir }) : [])]
  for (const p of problems) console.error('✗ ' + p)
  if (problems.length) process.exit(1)
  console.log('pilot bundle: ok')
}
