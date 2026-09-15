import { createWebRtcPlatform } from "@xorgate/react";
import type { PeerConnectionLike, WebRtcPlatform } from "@xorgate/react";
import { RTCPeerConnection } from "react-native-webrtc";

/**
 * The KVS viewer's platform on React Native.
 *
 * Only two of the five members differ from the browser: the peer connection
 * (react-native-webrtc's, which is a real native PeerConnection with hardware
 * H.264 decode behind it) and the id entropy (Hermes has no `crypto` global).
 * The three AWS bodies — `getViewerEndpoints`, `getIceServers` and the lazy
 * `createSignaling` facade — are `@xorgate/react`'s own: the AWS SDK v3
 * clients and `amazon-kinesis-video-streams-webrtc` both run on Hermes once
 * Metro resolves them (see README "Metro setup"), so copying them here would
 * only mean two implementations of the hardened signaling path. The one
 * addition is the missing-`crypto` guard below, in front of the first of
 * them.
 *
 * `iceTransportPolicy: "all"` matters on a phone: a viewer on a carrier NAT
 * frequently has no working host or srflx path to the device and lands on the
 * TURN relay AWS hands out with the ICE server list.
 */
export function createNativeWebRtcPlatform(randomId: () => string): WebRtcPlatform {
  const platform = createWebRtcPlatform({
    randomId,
    createPeerConnection: (iceServers): PeerConnectionLike =>
      new RTCPeerConnection({
        iceServers: iceServers as never,
        iceTransportPolicy: "all",
      }) as unknown as PeerConnectionLike,
  });

  return {
    ...platform,
    async getViewerEndpoints(channelRef, region, credentials) {
      assertCryptoGlobal();
      return platform.getViewerEndpoints(channelRef, region, credentials);
    },
  };
}

/**
 * The AWS SDK needs a `crypto` global, and Hermes has none.
 *
 * `@smithy/core`'s React Native serde bundle ends its UUID v4 path in
 * `const _getRandomValues = (array) => crypto.getRandomValues(array)` — a BARE
 * `crypto` — and that is the fallback `bindV4` selects precisely when
 * `typeof crypto === "undefined"`, so the guard hands control to the one line
 * that cannot survive the case it guards against. Without the polyfill the
 * first signaling call throws `Property 'crypto' doesn't exist`, which the
 * viewer session reads as a network failure and retries forever.
 *
 * Checked here, at the first AWS call, rather than at platform construction:
 * throwing while the provider mounts would take the whole app down over a
 * feature the user may not have opened. This way the message lands in the
 * session's `error` and says what to do.
 */
function assertCryptoGlobal(): void {
  const c = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
  if (c && typeof c.getRandomValues === "function") return;
  throw new Error(
    "Live video needs a `crypto` global, which React Native does not have: the AWS SDK " +
      'calls crypto.getRandomValues(). Add `import "@xorgate/react-native/polyfills"` to the ' +
      "top of your entry file. (Live telemetry does not need it.)",
  );
}
