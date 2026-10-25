# Pilot product build and release

How the gym pilot's product (web image and Android app) is built from explicit inputs, what the
build gates check, and what is still missing before anything is distributed. Upstream builds
(`npm run build`, `npm run build:mobile`, the default `web/Dockerfile`) are unchanged.

Passing the gates shows that a build matches its inputs. It is not legal clearance of the name,
branding, media or licences; those need review by whoever is responsible for them before any
distribution.

## Inputs: the product file

A JSON file, `deploy/pilot/product.example.json` shows every field:

| Field | Meaning |
| --- | --- |
| `productName` | The app's name: launcher label, web app manifest, page title |
| `appId` | Reverse-DNS application id; never upstream's (`ch.duartesantos.opengym`, `ch.opengym.app`) |
| `server` | The service's https origin, built in (the phone pairs only with it) |
| `media.mode` | `placeholder`: no exercise media anywhere. `licensed`: only the files of `media.manifest` |
| `media.manifest` | Licensed media: `{ licence, source, files: [{ path, sha256 }] }`, paths relative to `source` |
| `source.upstream` | Link to upstream openGym, for attribution |
| `source.offerUrl` | Where this exact version's source is offered; `{version}` is replaced |
| `ios.enabled` | Must be `false` until the iOS targets below are configured |

## Commands

```sh
cd frontend
PILOT_PRODUCT=../deploy/pilot/product.json npm run build:pilot          # web, into dist-pilot/
PILOT_PRODUCT=../deploy/pilot/product.json npm run build:mobile:pilot   # dist/ + cap sync android
node scripts/check-pilot-bundle.mjs ../deploy/pilot/product.json dist-pilot   # the gates alone
npx vitest run scripts/check-pilot-bundle.test.mjs                     # the gates' own tests
```

Web image: `docker build -f web/Dockerfile --build-arg PILOT_PRODUCT=deploy/pilot/product.json .`
builds the product. The exercise media are copied only into the image's build stage, and only
the upstream build moves them into what is served.

`build:mobile:pilot` writes `frontend/android/pilot.properties` (not committed): the application
id and launcher label that `android/app/build.gradle` reads. `npm run build:mobile` removes it
first, so an upstream build never inherits the product's identity.

## What the gates check (`frontend/scripts/check-pilot-bundle.mjs`)

- The product file is complete, with no upstream identity, an https server and a source offer.
- `pilot-build.json` in the output matches the product and the version.
- No text asset holds an upstream service address (`https://opengym.ch`, the upstream GitHub
  release API). The product build leaves out the upstream self-updater and download link.
- The bundle names the product server, and `manifest.json` carries the product name.
- `OPEN-SOURCE.txt` names AGPL-3.0-or-later, upstream, and the source offer for this version.
- No file under `exercise-media/` unless the licensed manifest lists it with a matching hash.
- Android: `pilot.properties` holds the product's application id, and the packaged web copy
  (`app/src/main/assets/public`) passes the same checks.

## Inventory of native identity and restricted assets

| Target | Upstream identity | Pilot status |
| --- | --- | --- |
| Android `app` | namespace and `applicationId` `ch.duartesantos.opengym`; flavours `sideload`, `play` | `applicationId` and label from `pilot.properties`; Java namespace unchanged (code identity only) |
| Android Play asset packs | `asset-packs.*.gradle`, generated on the release machine (restricted animations) | Never applied when `pilot.properties` exists |
| Android in-app updater | `sideload` flavour; checks upstream GitHub releases | Not offered in the product build; the native plugin stays but is never called |
| iOS `App` | bundle `ch.opengym.app`, app group `group.ch.opengym.app` | Excluded |
| iOS `OpenGymWidgets`, `Watch`, `WatchWidgets`, `AnimationPacksDownloader` | upstream bundle ids and the same app group | Excluded |
| Web image | `catalogue/media/` copied into the served files | Only for the upstream build |

Capacitor copies `capacitor.config.json` (upstream `appId`) into the Android assets. That value
is build-tool metadata; the installed app's identity is Gradle's `applicationId`.

## Not done yet (needs real accounts, identifiers and tools)

- **Android build and signing.** No Android SDK on the machine that prepared this; the variant
  to build is `sideloadRelease` (`./gradlew assembleSideloadRelease` in `frontend/android`)
  after `build:mobile:pilot`, signed with the product's own key. Not run yet; record the output
  APK's `applicationId` and label (`aapt dump badging`) here when it is.
- **iOS.** Not configured: every target above needs the product's bundle ids, team, signing and
  its own app group, or must be excluded from the product scheme. No Xcode was available to run
  `xcodebuild -list -workspace frontend/ios/App/App.xcworkspace`; record the scheme when it is.
- **Licensed media.** Until a licence route is approved, build with `media.mode: placeholder`.
- **Store listings, names and icons** are the product's own and need the same review as above.
- **Physical-device checks** (pairing, offline logging, notifications) are the plan's Task 27.
