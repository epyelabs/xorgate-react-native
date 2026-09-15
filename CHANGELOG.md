# Changelog

## 0.1.0

First release: live telemetry and live video on React Native, over
`@xorgate/react` 0.2.0's platform slot.

- `nativePlatform()` — the four slots `@xorgate/react` reads: a `WebRtcPlatform`
  whose peer connection is `react-native-webrtc`'s (`iceTransportPolicy: "all"`,
  because a viewer on a carrier NAT often has no path but the TURN relay), the
  `AppState` foreground edge as the wake source, id entropy, and an optional
  MQTT transport override. The three AWS bodies — signaling endpoints, ICE
  servers, the lazy signaling facade — are `@xorgate/react`'s own, unchanged.
- `XorgateNativeProvider` — `XorgateProvider` with that platform already in it,
  plus `randomId` / `wake` / `mqttConnect` props and a `platform` escape hatch.
- `useLiveVideo(channel)` / `<LiveVideo channel …/>` over `RTCView`. The
  component holds the outgoing picture across a reconnect until the incoming
  stream reports its first frame, so a blip does not flash black the way a new
  `streamURL` on a bare `RTCView` would; it gives the hold up after 3 s rather
  than pin a stale frame.
- `appStateWake` / `composeWake` — the foreground edge, and a way to add "the
  network came back" without this package depending on a network library.
- `@xorgate/react-native/polyfills` — the one runtime shim: `getRandomValues`
  and `randomUUID` from `expo-crypto`, because Hermes has no `crypto` global.
  A separate entry point so the main entry never pulls `expo-crypto`.
- Live telemetry, the data hooks, the live-block policy, the replay timeline,
  lanes, clock and telemetry math are re-exported unchanged from
  `@xorgate/react`; its browser-only hooks deliberately are not.

Metro needs three resolver rules for the AWS / KVS tree; they are in the README
and nothing else (`buffer`, `process`, `events`, `url`, stream or URL
polyfills) was necessary on Expo SDK 57 / Hermes.

Replay over `expo-video` is 0.2.0.
