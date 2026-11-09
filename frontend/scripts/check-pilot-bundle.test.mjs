// The pilot product build's gates (check-pilot-bundle.mjs), checked on bundles as they are written:
// the product's own identity from explicit inputs, no upstream service address, no restricted
// exercise media unless a licensed manifest names every file, and the attribution and source
// offer for the exact version. Part of `npm test`; alone: npx vitest run scripts/check-pilot-bundle.test.mjs
import { onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateProduct, checkPilotBundle } from './check-pilot-bundle.mjs'

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXAMPLE = path.resolve(FRONTEND, '../deploy/pilot/product.example.json')
const product = () => {
  const p = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'))
  if (p.icon) p.icon = path.resolve(path.dirname(EXAMPLE), p.icon)
  return p
}
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const VERSION = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'package.json'), 'utf8')).version

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-bundle-'))
  onTestFinished(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
function write(dir, rel, data) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), data)
}
// A bundle shaped like build-pilot.mjs's output, for the rules one at a time.
function bundle(p = product(), edit = {}) {
  const dir = tmp()
  write(dir, 'index.html', `<!doctype html><title>${p.productName}</title><script type="module" src="./assets/app.js"></script>`)
  write(dir, 'assets/app.js', edit.js ?? `const server="${p.server}";`)
  write(dir, 'manifest.json', JSON.stringify({ name: edit.manifestName ?? p.productName, short_name: p.productName }))
  if (!edit.noStamp) write(dir, 'pilot-build.json', JSON.stringify({ productName: p.productName, appId: edit.stampAppId ?? p.appId, server: p.server, media: { mode: p.media.mode }, version: VERSION, builtAt: '2026-10-26T00:00:00.000Z' }))
  if (!edit.noNotice) write(dir, 'OPEN-SOURCE.txt', edit.notice ?? `AGPL-3.0-or-later\nBased on openGym: ${p.source.upstream}\nSource for this version (${VERSION}): ${p.source.offerUrl.replace('{version}', VERSION)}\n`)
  return dir
}

test('the example product is complete; missing or upstream identity is refused', () => {
  assert.deepEqual(validateProduct(product()), [])
  const bad = (edit, why) => assert.ok(validateProduct({ ...product(), ...edit }).some(e => why.test(e)), String(why))
  bad({ productName: '' }, /productName/)
  bad({ appId: undefined }, /appId/)
  bad({ appId: 'ch.duartesantos.opengym' }, /upstream/)
  bad({ appId: 'ch.opengym.app' }, /upstream/)
  bad({ appId: 'not an id' }, /appId/)
  bad({ server: 'http://gym.example.com' }, /https/)
  bad({ server: 'https://opengym.ch' }, /upstream/)
  bad({ media: { mode: 'images-off' } }, /media\.mode/)
  bad({ media: { mode: 'licensed' } }, /manifest/)
  bad({ source: { upstream: 'https://github.com/DuarteSantos8/openGym' } }, /offerUrl/)
  bad({ ios: { enabled: true } }, /iOS/)
})

test('a placeholder bundle with its identity, attribution and source offer passes', () => {
  assert.deepEqual(checkPilotBundle({ webDir: bundle(), product: product(), version: VERSION }), [])
})

test('identity, upstream addresses, branding and the source offer are each checked', () => {
  const p = product()
  const problems = edit => checkPilotBundle({ webDir: bundle(p, edit), product: p, version: VERSION })
  assert.ok(problems({ noStamp: true }).some(e => /pilot-build\.json/.test(e)))
  assert.ok(problems({ stampAppId: 'com.other.app' }).some(e => /identity/.test(e)))
  assert.ok(problems({ js: `const s="${p.server}";fetch("https://api.github.com/repos/DuarteSantos8/openGym/releases/latest")` }).some(e => /upstream/.test(e)))
  assert.ok(problems({ js: `const s="${p.server}";location.href="https://opengym.ch/#download"` }).some(e => /upstream/.test(e)))
  assert.ok(problems({ js: 'const s="https://somewhere.else";' }).some(e => /does not name the product server/.test(e)))
  assert.ok(problems({ manifestName: 'openGym' }).some(e => /manifest\.json/.test(e)))
  assert.ok(problems({ noNotice: true }).some(e => /OPEN-SOURCE\.txt/.test(e)))
  assert.ok(problems({ notice: 'AGPL-3.0-or-later\n' }).some(e => /source offer/.test(e)))
})

test('restricted media: none without a licence; with one, only the files it names, byte for byte', () => {
  const p = product()
  const dir = bundle()
  write(dir, 'exercise-media/still/0001.webp', 'restricted')
  assert.ok(checkPilotBundle({ webDir: dir, product: p, version: VERSION }).some(e => /restricted media/.test(e)))

  const licDir = tmp()
  const manifest = path.join(licDir, 'licensed.json')
  fs.writeFileSync(manifest, JSON.stringify({ licence: 'Example licence 2026-10', files: [{ path: 'still/0001.webp', sha256: sha('licensed bytes') }] }))
  const licensed = { ...p, media: { mode: 'licensed', manifest } }
  const ok = bundle(licensed)
  write(ok, 'exercise-media/still/0001.webp', 'licensed bytes')
  assert.deepEqual(checkPilotBundle({ webDir: ok, product: licensed, version: VERSION }), [])
  write(ok, 'exercise-media/still/0002.webp', 'unlisted')
  assert.ok(checkPilotBundle({ webDir: ok, product: licensed, version: VERSION }).some(e => /not in the licensed manifest/.test(e)))
  write(ok, 'exercise-media/still/0001.webp', 'changed bytes')
  assert.ok(checkPilotBundle({ webDir: ok, product: licensed, version: VERSION }).some(e => /does not match/.test(e)))
})

test('the Android project: its application id and its packaged web copy are checked too', () => {
  const p = product()
  const android = tmp()
  write(android, 'pilot.properties', `applicationId=${p.appId}\nappLabel=${p.productName}\n`)
  fs.cpSync(bundle(), path.join(android, 'app/src/main/assets/public'), { recursive: true })
  assert.deepEqual(checkPilotBundle({ webDir: bundle(), product: p, version: VERSION, androidDir: android }), [])
  write(android, 'pilot.properties', 'applicationId=ch.duartesantos.opengym\n')
  assert.ok(checkPilotBundle({ webDir: bundle(), product: p, version: VERSION, androidDir: android }).some(e => /pilot\.properties/.test(e)))
  write(android, 'pilot.properties', `applicationId=${p.appId}\nappLabel=${p.productName}\n`)
  write(android, 'app/src/main/assets/public/exercise-media/clip/0001.mp4', 'restricted')
  assert.ok(checkPilotBundle({ webDir: bundle(), product: p, version: VERSION, androidDir: android }).some(e => /restricted media/.test(e)))
})

test('a real pilot build of the example product passes its own gates', { timeout: 300000 }, () => {
  const out = tmp()
  const r = spawnSync(process.execPath, ['scripts/build-pilot.mjs', '--out', out], {
    cwd: FRONTEND, env: { ...process.env, PILOT_PRODUCT: EXAMPLE }, encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(!fs.existsSync(path.join(out, 'exercise-media')))
  assert.deepEqual(checkPilotBundle({ webDir: out, product: product(), version: VERSION }), [])
  const stamp = JSON.parse(fs.readFileSync(path.join(out, 'pilot-build.json'), 'utf8'))
  assert.equal(stamp.appId, product().appId)
})

test('licensed staging copies exactly the manifest’s files, verified, and refuses a mismatch', () => {
  const src = tmp()
  write(src, 'still/0001.webp', 'licensed bytes')
  write(src, 'still/0002.webp', 'not licensed')
  const manifest = path.join(src, 'licensed.json')
  fs.writeFileSync(manifest, JSON.stringify({ licence: 'Example licence 2026-10', source: '.', files: [{ path: 'still/0001.webp', sha256: sha('licensed bytes') }] }))
  const stage = out => spawnSync(process.execPath, ['../scripts/catalogue/stage-media.mjs', out, '--manifest', manifest], { cwd: FRONTEND, encoding: 'utf8' })
  const out = tmp()
  const r = stage(out)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(fs.readdirSync(path.join(out, 'exercise-media/still')), ['0001.webp'])
  assert.match(fs.readFileSync(path.join(out, 'exercise-media/NOTICE.md'), 'utf8'), /Example licence 2026-10/)
  fs.writeFileSync(manifest, JSON.stringify({ licence: 'x', source: '.', files: [{ path: 'still/0002.webp', sha256: sha('licensed bytes') }] }))
  const bad = tmp()
  assert.notEqual(stage(bad).status, 0)
  assert.ok(!fs.existsSync(path.join(bad, 'exercise-media/still/0002.webp')))
})
