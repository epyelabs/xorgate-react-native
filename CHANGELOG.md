# Changelog

## 0.3.0

Tracks `@xorgate/react` 0.3.0 (live scope) and `@xorgate/sdk` 0.7.0 (device
transfer). No native change: the same `dist`, plus re-exports.

### Added

- **`useLiveScope()` and `useDeviceScope(deviceId)`**, re-exported unchanged
  from `@xorgate/react`. A device can be transferred to another workspace or
  organization while a viewer is open; the vended live credential is cached for
  up to ~50 minutes, and neither plane fails loudly when it goes stale —
  telemetry simply stops arriving and video keeps flowing until the next
  reconnect. `useDeviceScope` turns that into a typed `DEVICE_OUT_OF_SCOPE`,
  re-vending once first. `useLiveScope().invalidate()` makes every open live
  consumer re-resolve after you transfer a device yourself.

  **This matters more on a phone than on the web.** A backgrounded app resumes
  onto the same cached credential, and `appStateWake` nudges the live planes
  back up — straight onto the stale scope. The scope guard is what makes the
  resume honest.

- The transfer vocabulary from `@xorgate/sdk` (`TransferSummary`,
  `TransferPreview`, `TransferOffer`, `TransferOfferPreview`,
  `TransferAdoption`, `ScopeAttributeResult` and the rest), so a screen and a
  server route pass the same objects around.

### Unchanged, and checked

- **Replay carries no tenancy assumption.** Segment playback runs on presigned
  URLs minted per manifest and refreshed from `manifest.urlExpiresAt`; nothing
  in `replay-engine.ts` caches an organization or workspace id, so a transfer
  cannot strand a replay. (Replay does become unreadable to the OLD owner once
  the device moves — media is device-keyed and travels with it — but that shows
  up as a plain 404 from the manifest route, not as a stale URL.)

## 0.2.1

- **Fix: a replay lane froze for a whole segment at a time on Android.** The
  seam is an opacity flip between two overlapping views, and `expo-video` draws
  into a `SurfaceView` by default — a layer the system composites rather than
  one the view hierarchy draws, so `opacity: 0` does not hide it and `zIndex`
  does not order it against its sibling. The hidden PRELOAD therefore won: it
  parked on the first frame of the next segment, that still frame covered the
  player that was actually running, and the picture held for the whole segment
  while the clock, the map and the readouts carried on. It looked like the
  engine had stalled; the engine was never involved. `ReplayVideo` now renders
  into a `TextureView` on Android (`surfaceType`), which is an ordinary view,
  so alpha and z-order mean what they say. iOS is untouched — `AVPlayerLayer`
  is a real layer and the prop is Android's alone.

  Measured on an API 36 emulator against a six-segment recording, sampling the
  lane every ~1.5 s for three minutes: **11 distinct frames out of 80 before,
  79 out of 80 after**, over three segment boundaries either way. Each freeze
  began within ~1.5 s of the hidden player reporting ready, and the LAST
  segment of a replay always played correctly — by then there is nothing left
  to preload on top of it. The engine's own trace was clean throughout, every
  boundary a 0-131 ms seam.

## 0.2.0

Replay: the recorded-media player, over `expo-video`.

- **`@xorgate/react` `^0.2.1`**, up from `^0.2.0-next.1`. 0.2.1 is where
  `useReplayTelemetry` takes the player CORE rather than the browser wrapper —
  the change that lets a React Native player drive replay telemetry at all. The
  0.2.0 tarball shipped with the looser `^0.2.0-next.1`, which resolves to 0.2.1
  on any fresh install and is wrong only for a lockfile pinned at the
  pre-release; the range was tightened as soon as 0.2.1 existed to be named.
- **`expo-video` is a new required peer.** It is the native player; there is no
  way to play a recorded segment without it, and an optional peer whose absence
  fails deep inside a lane is worse than one line of install (the same call
  `expo-crypto` got in 0.1.0). Installing it moves the native fingerprint.
- `useReplayPlayer(manifest, options)` — `@xorgate/react`'s
  `useReplayPlayerCore` with native media bound to every lane. The transport,
  the clock, the lanes and `laneState` are the web package's; what is added is
  `lanePlayer(streamKey)` and `laneMedia(streamKey)`, and the pool of players
  behind them. `createVideoPlayer` is manual memory, so the hook creates a
  pair per lane lazily and releases it when the lane goes or the hook unmounts.
- `<ReplayVideo player streamKey />` — both of a lane's views, the hidden one
  at zero opacity, `nativeControls` off.
- `ExpoVideoReplayEngine` — one lane over two players, implementing
  `@xorgate/react`'s `ReplayEngine`. A phone has no Media Source Extensions:
  `AVPlayer` and `ExoPlayer` play a FILE, and a recorded segment is a
  self-contained fMP4 that cannot be concatenated at runtime. So a lane is two
  players and a boundary is an opacity flip. Four decisions the real segments
  forced, all measured before the code was written:
  - **The boundary is the manifest's** `effectiveDurationMs`, not the file's
    end — a segment's file runs past the next one's start and playing that tail
    would show the same wall clock twice. `playToEnd` is the fallback for the
    opposite case, a file shorter than the manifest claims.
  - **Readiness is the `statusChange` event, never the `replaceAsync`
    promise**, which resolves with `status` still `loading`; `bufferedPosition`
    can answer for the previous item until then.
  - **Prepare early, promote on time.** The next segment is loaded and parked
    on its first frame half a second out, and played only when the outgoing
    player actually reaches the boundary — swapping at the lead would silently
    drop it, once per segment.
  - **A cross-segment seek always loads onto the hidden player**, so the
    outgoing picture stays up for the 1.3-5.3 s the download takes instead of
    going black.
- A failed segment load is probed with a one-byte ranged GET on the same
  presigned URL, because a native player never reports the HTTP status: 403
  becomes `onAuthError` (the manifest refresh, as in the browser engine) and
  404/410 becomes a media error. Anything else retries.
- `useReplayPlayer(manifest, { debug })` — every decision a lane makes, as one
  line, off by default. A seam is tens of milliseconds wide and the native
  player is the half you cannot step through, so a boundary that did NOT
  happen has to be able to leave evidence. It is what found the four defects
  below, none of which any test had caught.

**Four things the device corrected, all at the same place: a segment boundary.**
On the first real 3-segment session a whole 60 s segment vanished — 57.7 s of a
145.6 s replay, silently — and it took all four lining up:

1. **A preloaded player is not parked at 0.** One was caught at 15.68 s, and
   promoting it would have started that segment a quarter of the way in. On
   iOS a playback RATE is the transport, so setting the rate on a paused
   preload starts it playing. The rate now goes only on the player that is
   about to play, and the incoming player is seeked unconditionally rather
   than only for a non-zero offset.
2. **Promoting does not move the playhead.** The clock is paced BY the lane
   and only learns the new position on its next tick, so the very next
   `ensureAt` arrives with a timestamp a few milliseconds BEFORE the boundary
   — which dragged the lane back into the segment it had just left, which the
   next tick undid, and so on. A move back into a just-crossed segment is now
   ignored for a second.
3. **The boundary must be released whether or not the player says so.** The
   last `timeUpdate` of a segment lands 60-80 ms short of the file's end, and
   `playToEnd` / `playingChange` follow a beat later. A timer armed when the
   lead-in is prepared — for the expected end plus 120 ms — closes that, and
   deliberately fires LATE: early skips real video, late only holds a frame.
   A segment's end is `min(manifest, file)`, because a file can fall short of
   what the manifest claims (60.000 s claimed, 59.987 s of media).
4. **A lane waiting on a prepared lead-in must not report itself stalled.**
   It did, so the player core's stall recovery ran — and with the playhead
   already inside the NEXT segment, that recovery seeks to the END of it.
   That is the line that actually ate the 57.7 s.

Two more it showed, away from the boundary:

- **A seek holds the outgoing picture STILL**, not merely on screen. The
  outgoing player used to keep playing for the seconds a cross-segment
  download takes — six of them, on one measured seek — while the transport bar
  already read the seek target, so the picture and the clock were describing
  different moments. A boundary lead-in is deliberately exempt: there the
  outgoing segment is still the right one, right up to its last frame.
- **A torn-down lane dies quietly.** The players belong to the hook, and one
  that has been released throws `NotFoundException` on every access; the hook
  now destroys engines before releasing players rather than trusting React's
  cleanup order, and an engine handed a dead pair goes inert instead of
  throwing into the tree.

## 0.1.0

First release: live telemetry and live video on React Native, over
`@xorgate/react` 0.2.0's platform slot.

- `nativePlatform()` — three of `@xorgate/react`'s four platform slots: a
  `WebRtcPlatform` whose peer connection is `react-native-webrtc`'s
  (`iceTransportPolicy: "all"`, because a viewer on a carrier NAT often has no
  path but the TURN relay), the `AppState` foreground edge as the wake source,
  and id entropy from `expo-crypto`. `mqttConnect` is deliberately left unset:
  mqtt.js 5 runs on React Native's global WebSocket unmodified. The three AWS
  bodies — signaling endpoints, ICE servers, the lazy signaling facade — are
  `@xorgate/react`'s own.
- `XorgateNativeProvider` — `XorgateProvider` with that platform already in it,
  plus `randomId` / `wake` / `mqttConnect` props and a `platform` escape hatch.
- `useLiveVideo(channel)` / `<LiveVideo channel …/>` over `RTCView`. The
  component holds the outgoing picture across a reconnect until the incoming
  stream reports its first frame, so a blip does not flash black the way a new
  `streamURL` on a bare `RTCView` would; it gives the hold up after 3 s rather
  than pin a stale frame.
- `appStateWake` / `composeWake` — the foreground edge, and a way to add "the
  network came back" without this package depending on a network library.
- `@xorgate/react-native/polyfills` — `getRandomValues` and `randomUUID` from
  `expo-crypto` onto `globalThis.crypto`. **Required for live video**, though
  not by this package: `nativePlatform()` covers the SDK's own entropy and
  telemetry needs no polyfill, but `@smithy/core`'s React Native serde bundle
  dereferences a BARE `crypto` in the very fallback it takes when `crypto` is
  undefined, so the first KVS call throws `Property 'crypto' doesn't exist` on
  Hermes (smithy-typescript#2276). A separate entry point so the polyfill is a deliberate line in the
  consumer's entry file rather than an import side effect — and the WebRTC
  platform checks for the global at its first AWS call and says so by name,
  because the raw symptom is a `ReferenceError` the session retries forever.
- Live telemetry, the data hooks, the live-block policy, the replay timeline,
  lanes, clock and telemetry math are re-exported unchanged from
  `@xorgate/react`; its browser-only hooks deliberately are not.
- `@xorgate/react-native/webcrypto` — the WebCrypto subset the KVS signaling
  client's SigV4 signer needs (`digest`, `importKey`, `sign`, all SHA-256),
  for Metro to alias `isomorphic-webcrypto` at; that package's own React
  Native build evaluates to `undefined` on Hermes.

Metro needs four resolver rules for the AWS / KVS tree; they are in the README
and nothing else (`buffer`, `process`, `events`, `url`, stream or URL
polyfills) was necessary on Expo SDK 57 / Hermes.

Replay over `expo-video` is 0.2.0.
