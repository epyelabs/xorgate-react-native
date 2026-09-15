# Changelog

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
