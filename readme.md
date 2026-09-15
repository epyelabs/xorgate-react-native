# @xorgate/react-native

React Native adapters for [`@xorgate/react`](https://www.npmjs.com/package/@xorgate/react):
live telemetry over MQTT-over-WebSocket, live video over WebRTC rendered by
`react-native-webrtc`'s `RTCView`, and the recorded-media replay player over
`expo-video`. Everything pure (session hardening, telemetry feed, timeline,
clock, lanes) stays in `@xorgate/react`; this package supplies the platform
adapters and the RN-flavoured hooks and components.

**Status: scaffold.** No runtime code ships yet. The plan is
`alocate/plans/alocate-mobile-business-layer/XORGATE-REACT-NATIVE.md`; the
runtime facts the design rests on (Metro shims, which globals Hermes has,
`getStats()` field names on RN, the replay seam) are in that folder's
`SPIKES.md`.

**Full reference (once published): [docs.xorgate.io/docs/frontend-sdk](https://docs.xorgate.io/docs/frontend-sdk)**

## Install (target shape, from 0.1.0)

```bash
npx expo install @xorgate/react-native @xorgate/react react-native-webrtc @config-plugins/react-native-webrtc
```

Peers: `react`, `react-native`, `react-native-webrtc` (live video),
`expo-video` (replay, from 0.2.0). A development build is required
(`react-native-webrtc` is a native module; Expo Go cannot run it).

## Metro setup

`@xorgate/react` and its AWS / KVS / mqtt tree bundle under Metro with three
resolver rules in `metro.config.js`; the package will document (and, where it
can, ship) them:

1. `@aws-sdk/*` and `@smithy/*` packages that ship **no `exports` map** must
   resolve to their `dist-es` build (`module` entry). Their `react-native` /
   `browser` fields are sub-path maps, not entry points, so Metro otherwise
   falls through to `main` = `dist-cjs`, which requires `node:https` /
   `node:stream`. Packages **with** an `exports` map (`@smithy/core`,
   `@aws-sdk/core`, `@aws-sdk/nested-clients`) must be left alone.
2. `./runtimeConfig` requested from inside a `dist-es` directory resolves to
   the `runtimeConfig.native.js` sibling.
3. `ws` resolves to `ws/browser.js`: the KVS signaling client does
   `new (WebSocket || require("ws"))(url)`, and React Native has a global
   `WebSocket`, so the Node implementation only has to be *resolvable*.

4. `isomorphic-webcrypto` (a dependency of the KVS signaling client) aliases to
   a small WebCrypto subset — `subtle.digest` SHA-256, `importKey` raw/HMAC,
   `sign` HMAC — over `@aws-crypto/sha256-js`; its own React Native build
   evaluates to `undefined` on Hermes.
5. A `crypto` global: Hermes / Expo SDK 57 has none, and the SDK draws client
   ids from `crypto.randomUUID()`. One line from `expo-crypto`
   (`getRandomValues`, `randomUUID`), imported before the SDK.

Nothing else was needed on Expo SDK 57 / Hermes: no `buffer`, `process`,
`events`, `url`, stream or URL polyfill (spike 1, 2026-09-15).

A global `resolverMainFields: ["module", …]` is **not** a shortcut: it breaks
`react-native-safe-area-context`'s codegen spec.

## Scripts

`npm run ci` = `typecheck` → `test` → `build` → `verify:tarball` (pack, install
into an empty project, import as a consumer, scan for secret material).
Publishing is manual (`npm publish --tag next` for pre-releases, `npm publish`
for a final) by the maintainer; CI has no publish job on purpose.

## License

MIT © Epye Labs
