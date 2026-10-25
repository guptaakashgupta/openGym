#!/usr/bin/env node
// Copies the exercise stills and animations next to a built app, as exercise-media/still and /clip:
//
//   node scripts/catalogue/stage-media.mjs frontend/dist                 web demo, 180 px from catalogue/media
//   APP_MEDIA_DIR=/private/app node scripts/catalogue/stage-media.mjs frontend/dist
//                                                                        Android package: larger animations
//   VITE_CLIP_EXT=webp APP_MEDIA_DIR=/private/app-webp ...              ... as animated WebP (the release)
//
// The media are licensed from Gym visual for openGym only (catalogue/media/NOTICE.md). 180 px is
// what may sit in the repository, a website or a self-hosted server; anything larger may only
// ever end up inside a compiled app package, so APP_MEDIA_DIR is set by the release build alone
// and points at the maintainer's private copy, never at anything in this repository.
//
//   node scripts/catalogue/stage-media.mjs <out> --manifest licensed.json
//                                                                        a product build (frontend/scripts/build-pilot.mjs):
//                                                                        exactly the files a licensed manifest names
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.resolve(process.argv[2] || 'frontend/dist')

// A licensed manifest: { licence, source (dir, relative to the manifest), files: [{ path, sha256 }] }.
// Every file is checked against its hash before anything is copied; one mismatch stages nothing.
const at = process.argv.indexOf('--manifest')
if (at >= 0) {
  const file = path.resolve(process.argv[at + 1] || '')
  let m
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { console.error(`cannot read the licensed manifest ${file}`); process.exit(1) }
  const from = path.resolve(path.dirname(file), m.source || '.')
  const files = Array.isArray(m.files) ? m.files : []
  for (const f of files) {
    const src = path.resolve(from, String(f.path))
    if (!src.startsWith(from + path.sep) || !fs.existsSync(src)) { console.error(`licensed manifest: ${f.path} is missing`); process.exit(1) }
    if (crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex') !== f.sha256) { console.error(`licensed manifest: ${f.path} does not match its hash`); process.exit(1) }
  }
  const dest = path.join(out, 'exercise-media')
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dest, f.path)), { recursive: true })
    fs.copyFileSync(path.resolve(from, f.path), path.join(dest, f.path))
  }
  fs.writeFileSync(path.join(dest, 'NOTICE.md'), `Licensed media: ${m.licence || 'see the licensed manifest'}\n`)
  console.log(`media: ${files.length} licensed file(s) -> ${path.relative(ROOT, out) || out}`)
  process.exit(0)
}
const media = path.join(ROOT, 'catalogue/media')
const appDir = process.env.APP_MEDIA_DIR
const clipExt = process.env.VITE_CLIP_EXT === 'webp' ? '.webp' : '.mp4'
if (clipExt === '.webp' && !appDir) {
  console.error('VITE_CLIP_EXT=webp needs APP_MEDIA_DIR: the repository only has the MP4 animations')
  process.exit(1)
}

const copyDir = (from, to, ext) => {
  fs.mkdirSync(to, { recursive: true })
  let n = 0
  for (const f of fs.readdirSync(from)) {
    if (!f.endsWith(ext)) continue
    fs.copyFileSync(path.join(from, f), path.join(to, f))
    n++
  }
  return n
}
const dest = path.join(out, 'exercise-media')
const stills = copyDir(path.join(media, 'still'), path.join(dest, 'still'), '.webp')
const clips = copyDir(appDir || path.join(media, 'clip'), path.join(dest, 'clip'), clipExt)
fs.copyFileSync(path.join(media, 'NOTICE.md'), path.join(dest, 'NOTICE.md'))
console.log(`media: ${stills} stills, ${clips} animations${appDir ? ' (app size)' : ''} -> ${path.relative(ROOT, out) || out}`)
