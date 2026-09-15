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
 * `createSignaling` facade — are `@xorgate/react`'s own, unchanged: the AWS
 * SDK v3 clients and `amazon-kinesis-video-streams-webrtc` both run on Hermes
 * once Metro resolves them (see README "Metro setup"), so copying them here
 * would only mean two implementations of the hardened signaling path.
 *
 * `iceTransportPolicy: "all"` matters on a phone: a viewer on a carrier NAT
 * frequently has no working host or srflx path to the device and lands on the
 * TURN relay AWS hands out with the ICE server list.
 */
export function createNativeWebRtcPlatform(randomId: () => string): WebRtcPlatform {
  return createWebRtcPlatform({
    randomId,
    createPeerConnection: (iceServers): PeerConnectionLike =>
      new RTCPeerConnection({
        iceServers: iceServers as never,
        iceTransportPolicy: "all",
      }) as unknown as PeerConnectionLike,
  });
}
