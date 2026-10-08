# @xorgate/react-native

[![npm](https://img.shields.io/npm/v/@xorgate/react-native.svg)](https://www.npmjs.com/package/@xorgate/react-native)
[![CI](https://github.com/epyelabs/xorgate-react-native/actions/workflows/ci.yml/badge.svg)](https://github.com/epyelabs/xorgate-react-native/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@xorgate/react-native.svg)](./LICENSE)

React Native adapters for [`@xorgate/react`](https://www.npmjs.com/package/@xorgate/react).
Live telemetry over MQTT-over-WebSocket, live video over WebRTC rendered by
`react-native-webrtc`'s `RTCView`, and recorded-media replay over `expo-video`
— real native video views with hardware H.264 decode behind them, not a web
player in a shell.

Everything pure or platform-neutral — the KVS session hardening, the telemetry
feed, the timeline, lanes, the replay clock, the telemetry math, the data hooks
— lives in `@xorgate/react` and is **re-exported from here**, so your app
imports from one package. What this package adds is the runtime underneath
(`nativePlatform`, `XorgateNativeProvider`) and the things that cannot be
platform-neutral because they are pixels.

**Full reference: [docs.xorgate.io/docs/frontend-sdk](https://docs.xorgate.io/docs/frontend-sdk)**

## Install

```bash
npx expo install @xorgate/react-native react-native-webrtc @config-plugins/react-native-webrtc expo-crypto expo-video
```

Peers: `react`, `react-native`, `react-native-webrtc`, `expo-crypto`,
`expo-video`, and optionally `expo-file-system` (only for the iOS replay
segment cache, below).
`@xorgate/react` is a dependency, not a peer — one resolved copy is what makes
`instanceof XorgateError` hold across the boundary.

`expo-crypto` is required, not optional: Hermes ships **no `crypto` global at
all** — not `randomUUID`, not `getRandomValues`, not `subtle` — and every MQTT
and signaling client id needs entropy, so there is nothing else to default to.

Add the config plugin to `app.json` / `app.config.ts`:

```json
{ "plugins": ["@config-plugins/react-native-webrtc"] }
```

**A development build is required.** `react-native-webrtc` is a native module,
so Expo Go cannot run it. `expo-video` is a native module too, and adding
either moves the native fingerprint: a Metro reload will not pick it up.

The plugin writes both an `NSCameraUsageDescription` and an
`NSMicrophoneUsageDescription`, and on Android adds `CAMERA`, `RECORD_AUDIO`,
`MODIFY_AUDIO_SETTINGS` and Bluetooth permissions. A **viewer** app uses none
of them, but Apple's upload check (ITMS-90683) still wants a microphone string
from any binary that links the microphone APIs, which WebRTC does. Set an
honest one rather than shipping the plugin's placeholder, and strip the Android
permissions you do not use:

```ts
plugins: [["@config-plugins/react-native-webrtc", {
  cameraPermission: "…",
  microphonePermission: "This app views live video only and does not record audio.",
}]],
android: { blockedPermissions: ["android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"] },
```

## Metro setup

`@xorgate/react`'s AWS / KVS / mqtt tree bundles under Metro with four
resolver rules. They are mechanical and package-agnostic — they read each
package's own `package.json` — so paste this into `metro.config.js` once:

```js
const fs = require("node:fs")
const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")

const config = getDefaultConfig(__dirname)

const AWS_SCOPES = ["@aws-sdk/", "@smithy/"]
const esEntry = new Map()

/**
 * (1) `@aws-sdk/*` and `@smithy/*` packages that ship NO `exports` map fall
 * through to `main` = `dist-cjs`, which requires `node:https` / `node:stream`.
 * Their `react-native` and `browser` fields are sub-path maps, not entry
 * points, so Metro cannot use them: redirect the bare request to the `module`
 * entry (`dist-es`). Packages that DO have `exports` (`@smithy/core`,
 * `@aws-sdk/core`, `@aws-sdk/nested-clients`) resolve correctly and must be
 * left alone — `@smithy/core` actively refuses `./dist-es/index.js`.
 */
function awsEsEntry(name) {
  if (!AWS_SCOPES.some((s) => name.startsWith(s))) return null
  if (name.split("/").length !== 2) return null // sub-path imports are fine
  if (esEntry.has(name)) return esEntry.get(name)
  let result = null
  try {
    const dir = path.dirname(require.resolve(`${name}/package.json`, { paths: [__dirname] }))
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
    if (!pkg.exports && typeof pkg.module === "string") result = path.join(dir, pkg.module)
  } catch {
    result = null
  }
  esEntry.set(name, result)
  return result
}

const previous = config.resolver.resolveRequest

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const es = awsEsEntry(moduleName)
  if (es) return { type: "sourceFile", filePath: es }

  // (2) `./runtimeConfig` from inside a `dist-es` directory -> the
  // `runtimeConfig.native.js` sibling, which is what the package's
  // `react-native` sub-path map would have chosen. Without it the AWS clients
  // come up with the Node runtime config instead of `FetchHttpHandler`.
  if (moduleName === "./runtimeConfig" && context.originModulePath.includes(`${path.sep}dist-es${path.sep}`)) {
    const native = path.join(path.dirname(context.originModulePath), "runtimeConfig.native.js")
    if (fs.existsSync(native)) return { type: "sourceFile", filePath: native }
  }

  // (3) The KVS signaling client does `new (WebSocket || require("ws"))(url)`.
  // React Native has a global `WebSocket`, so the Node implementation only has
  // to RESOLVE; it never runs.
  if (moduleName === "ws") {
    return { type: "sourceFile", filePath: require.resolve("ws/browser.js", { paths: [__dirname] }) }
  }

  // (4) `isomorphic-webcrypto` -> this package's WebCrypto subset. The real
  // package's React Native build evaluates to `undefined` on Hermes (its
  // export is assembled behind an msrcrypto PRNG promise, and it wants
  // `expo-random`, gone from the Expo SDK after 51), so the KVS signaling
  // client dies with "Cannot read property 'subtle' of undefined" the first
  // time a viewer connects.
  if (moduleName === "isomorphic-webcrypto") {
    return {
      type: "sourceFile",
      filePath: require.resolve("@xorgate/react-native/webcrypto", { paths: [__dirname] }),
    }
  }

  return (previous ?? context.resolveRequest)(context, moduleName, platform)
}

module.exports = config
```

`@xorgate/react-native/webcrypto` covers exactly the three calls the SigV4
signer makes — `digest(SHA-256)`, `importKey("raw", HMAC)`, `sign(HMAC)` —
over `@aws-crypto/sha256-js`, which is already in the tree. All three are
deterministic hashing, so the entropy msrcrypto was adding is not used on this
path; anything outside those three throws by name rather than answering wrong.

Nothing else was needed on Expo SDK 57 / Hermes: no `buffer`, `process`,
`events`, `url`, stream or URL polyfill, measured rather than assumed.

A global `resolverMainFields: ["module", …]` is **not** a shortcut for rule 1:
it breaks `react-native-safe-area-context`'s codegen spec.

## Polyfill

Add one line at the very top of your entry file, before anything that reaches
the SDK:

```ts
import "@xorgate/react-native/polyfills"
```

It installs `getRandomValues` and `randomUUID` from `expo-crypto` onto
`globalThis.crypto`, additively (an existing `crypto` keeps everything it
already has).

**Live video does not work without it.** Not because of this package —
`nativePlatform()` covers the SDK's own entropy through the `randomId` slot,
and live telemetry runs with no polyfill at all — but because of the AWS SDK
underneath the KVS viewer. `@smithy/core`'s React Native serde bundle ends its
UUID v4 path in

```js
const _getRandomValues = (array) => crypto.getRandomValues(array)
```

with a **bare** `crypto`, and that is the fallback `bindV4` selects precisely
when `typeof crypto === "undefined"` — so the guard hands control to the one
line that cannot survive the case it guards against. On Hermes the first
`GetSignalingChannelEndpoint` call then throws `Property 'crypto' doesn't
exist`, the session treats it as a network error, and the viewer retries
forever on a backoff. (Measured on Expo SDK 57 / Hermes, `@smithy/core` 3.34.1,
2026-09-15. The same bug was fixed for the Node build in
smithy-typescript#2022; the browser and React Native builds were not changed —
smithy-typescript#2276.)

## Use

```tsx
import { XorgateNativeProvider } from "@xorgate/react-native"

<XorgateNativeProvider
  key={organizationId ?? "none"}          // remounting is how you switch tenants
  auth={{ getLiveCredentials }}
  organizationId={organizationId}
>
  {children}
</XorgateNativeProvider>
```

Same props as `@xorgate/react`'s `XorgateProvider`, plus the native slots
(`randomId`, `wake`, `mqttConnect`, and a `platform` escape hatch).

### Live telemetry

Unchanged from the web package — `mqtt.js` 5 runs on React Native's global
`WebSocket` as it is:

```tsx
const { latest, history, status, receivedAt } = useLiveTelemetry(deviceId)
```

### Live scope

A device can be transferred to another workspace or organization while a screen
is open. The vended live credential encodes the old tenancy and is cached for up
to ~50 minutes, and **nothing fails**: telemetry simply stops arriving and video
keeps flowing until the next reconnect. On a phone that window is effectively
longer, because a backgrounded app resumes onto the same cached credential and
`appStateWake` nudges the live planes straight back onto the stale scope.

```tsx
const scope = useDeviceScope(deviceId)
const live = useLiveTelemetry(scope.outOfScope ? null : deviceId)

if (scope.error) return <Text>{scope.error.message}</Text>   // DEVICE_OUT_OF_SCOPE
```

`useDeviceScope` re-vends once before complaining, since the ordinary cause is
just a stale cached credential. If your app moves devices itself, call
`useLiveScope().invalidate()` afterwards and every open live consumer
re-resolves immediately.

Read freshness off `receivedAt`, not `status`. A phone that loses signal keeps
a socket that reads `connected` until the OS surfaces the close, which can take
20 s or more; the age of the last frame is the honest signal, and the web app
treats it the same way.

### Live video

```tsx
import { LiveVideo, useVideoChannels } from "@xorgate/react-native"

const { data } = useVideoChannels(deviceId)
const cam0 = data?.find((c) => c.streamKey === "cam0") ?? null

<LiveVideo channel={cam0} style={{ aspectRatio: 16 / 9 }} />
```

`useVideoChannels` is a REST read, so it needs an auth mode that HAS a REST
credential. An app on `auth={{ getLiveCredentials }}` — the vended-direct mode,
where your own backend mints the credential and your users have no xorgate
identity — gets `INVALID_CONFIG` from it by design, and should fetch the
channel list from its own API and hand the `VideoChannel` to `LiveVideo`
directly. The live and replay planes are the parts that mode reaches.

`LiveVideo` is the view and nothing else: no card, no spinner, no status text,
no aspect ratio of its own. Take `onStatusChange`, `onStats`,
`onVideoDimensions` and `onDisplayedStreamChange` for chrome of your own, or
drop to the hook:

```tsx
const { streamURL, status, stats, error } = useLiveVideo(cam0)
```

One behaviour `LiveVideo` adds over a bare `RTCView`: **the reconnect hold**.
Every reconnect produces a new `MediaStream` with a new `streamURL`, and an
`RTCView` pointed at a stream that has not decoded a frame is black — so a
short blip would blank the picture, where a browser's `<video>` simply keeps
its last frame. `LiveVideo` mounts the new stream underneath at zero opacity
and promotes it only once the renderer reports its dimensions, falling back to
the swap after 3 s so a dead stream cannot pin a stale frame. Render `RTCView`
yourself and you own that.

### Replay

```tsx
import { ReplayVideo, useReplayPlayer } from "@xorgate/react-native"

const player = useReplayPlayer(manifest, { startTs })

<ReplayVideo player={player} streamKey="cam0" style={{ aspectRatio: 16 / 9 }} />
<Text>{new Date(player.playheadTs).toISOString()}</Text>
<Button title={player.playing ? "Pause" : "Play"} onPress={player.toggle} />
```

The transport (`play`, `pause`, `toggle`, `seek`, `setRate`, `setSkipGaps`,
`stepBoundary`), the clock, the lanes and the per-lane `laneState` are the same
ones the web package exposes — `useReplayPlayer` here is `useReplayPlayerCore`
with native media bound to it. Everything is driven by wall-clock epoch ms, so
`useReplayTelemetry(deviceId, player)` tracks the video without either side
knowing about the other: it takes the player CORE, reads a timeline and a
playhead, and has no idea what is playing the video.

The manifest comes from `useReplayManifest(deviceId, …)`, or from your own API
on the vended-direct auth mode — same rule as `useVideoChannels` above.

**A lane is two players, not one.** A phone has no Media Source Extensions:
`AVPlayer` and `ExoPlayer` play a FILE, and every recorded segment is a
self-contained fMP4 that cannot be concatenated at runtime. So each lane gets a
pair — one showing the current segment while the other already holds the next —
and `ReplayVideo` mounts both views, the hidden one at zero opacity. A segment
boundary is then an opacity flip between two live views. The incoming player is
prepared half a second early but **not played until the outgoing one actually
reaches the manifest boundary**, which is what keeps the playhead continuous
across a seam instead of skipping the lead once per segment.

Render the views yourself with `player.laneMedia(streamKey)` (both players and
which is in front) or `player.lanePlayer(streamKey)` (just the front one, if
you can live with a reload at every boundary). `nativeControls` stays off: the
clock owns the transport, and a native scrubber would drive one segment's file
rather than the replay.

A **seek across segments is download-bound** — a whole 6-13 MB segment, 1.3-5.3
s on a good connection — because that is what `replaceAsync` fetches. The
outgoing picture is held throughout rather than going black, and
`player.laneState(streamKey)` plus `player.clock` are what a scrubber should
read. If you build a scrub thumb, seek as the thumb MOVES, not only on release:
the intermediate seeks warm the player the release will land on.

#### On iOS, pass a segment cache

```ts
import { createSegmentCache } from "@xorgate/react-native/segment-cache"

// ONE per app: the folder is emptied when it is created.
const segmentCache = Platform.OS === "ios" ? createSegmentCache() : undefined

const player = useReplayPlayer(manifest, { segmentCache })
// and on sign-out: segmentCache?.clear()
```

`AVPlayer` does not play a recorded segment progressively. The fMP4 has no
`sidx`, so AVFoundation reads the whole file before its first frame, and it
pulls it from S3 through several sequential range requests, abandoning two
of them. With a cache, each finished segment arrives as one plain download
and the player opens the local file instead. Measured on the same 7.3 MB
segment, first frame: a median of ~10 s streamed against ~1.25 s through the
cache in the app, and 1.7-32 s (median ~13 s) against 1.0-1.75 s in isolation.
Android's ExoPlayer starts after a few seconds of buffer and does not need it.

- **Opt-in, on its own entry point.** `@xorgate/react-native/segment-cache` is
  the only module that imports `expo-file-system` (an optional peer: `npx expo
  install expo-file-system`); without a `segmentCache`, every segment streams
  exactly as before.
- **The app's own cache folder** (`Library/Caches`): no permission, no usage
  string, no entitlement. iOS leaves it out of iCloud backup and may purge it
  under storage pressure, which is what Apple's data storage guidelines ask of
  re-downloadable content.
- **Whole files only.** A download lands in a `.part` file and is renamed once
  it is complete and, when the manifest knows the size, only if it matches.
- **A segment still being recorded streams**: its file is still growing.
- **Failures degrade, never strand.** A 403 refreshes the manifest and a
  404/410 is a media error, as when streaming; anything else (the network,
  the disk) falls back to streaming that segment.
- **Bounded and short-lived.** At most four finished segments are kept
  (about 30 MB at 720p; `maxEntries` to change it), least recently used
  evicted first. A file a player is reading is never evicted, so the folder
  can briefly hold more. It is emptied when the cache is created (once per
  launch) and by `clear()`.

### Waking the live plane

The foreground edge (`AppState` → `active`) is wired for you, and on a phone it
matters more than anything else in this package: iOS suspends the app's sockets
within seconds of it leaving the screen, so both the MQTT connection and the
peer connection are usually dead when the user comes back. Without the nudge
the live plane sits out a backoff of up to 30 s in front of them.

Add "the network came back" — four lines, and it stays in your app so this
package depends on neither network library:

```ts
import * as Network from "expo-network"

const networkWake = (onWake: () => void) => {
  const sub = Network.addNetworkStateListener((s) => {
    if (s.isInternetReachable ?? s.isConnected) onWake()
  })
  return () => sub.remove()
}

<XorgateNativeProvider wake={[networkWake]} …>
```

With `@react-native-community/netinfo`:

```ts
const networkWake = (onWake: () => void) =>
  NetInfo.addEventListener((s) => { if (s.isConnected) onWake() })
```

A wake is a hint, never a command: a feed that is connected or mid-connect
ignores one, so firing twice costs nothing.

## What is not here

`@xorgate/react`'s browser-only exports — its `useLiveVideo`, `LiveVideo`,
`useReplayPlayer`, `ReplayVideo` and the `browser*` platform helpers — are
deliberately not re-exported: they need `HTMLVideoElement`, `window` or Media
Source Extensions. The four names are SHADOWED here by the native
implementations, so importing from this package always gets the one that works
on a phone. `useReplayPlayerCore`, the timeline, the lanes, the clock and the
replay telemetry math **are** re-exported unchanged.

## Scripts

`npm run ci` = `typecheck` → `test` → `build` → `verify:tarball` (pack, install
into an empty project, import it as a consumer with stub peers, check the
export surface, scan for secret material).

The suite runs under jsdom against doubles for `react-native`,
`react-native-webrtc` and `expo-video`, because none of them has a Node build. It proves the wiring —
which listener is attached, which prop the view gets, what happens across a
reconnect — and nothing about pixels or hardware decode, which are measured by
hand on a simulator and a phone.

Publishing is manual (`npm publish --tag next` for pre-releases, `npm publish`
for a final); CI has no publish job on purpose.

## License

MIT © Epye Labs
