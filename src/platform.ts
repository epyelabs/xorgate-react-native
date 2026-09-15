import type { XorgatePlatform } from "@xorgate/react";
import { createNativeWebRtcPlatform } from "./webrtc-platform.js";
import { appStateWake, composeWake, type WakeSource } from "./wake.js";

export interface NativePlatformOptions {
  /**
   * Client-id entropy for MQTT and KVS signaling. Default: the `crypto`
   * global, which Hermes does NOT ship — import `@xorgate/react-native/polyfills`
   * once at the top of your entry file (Expo, one line, from expo-crypto), or
   * pass your own here.
   */
  randomId?: () => string;
  /**
   * Extra wake sources, merged with the foreground edge. "The network came
   * back" belongs here; the README has the expo-network and NetInfo recipes.
   */
  wake?: WakeSource[];
  /**
   * Replace the MQTT transport. Leave unset: mqtt.js 5 runs unmodified on
   * React Native's global WebSocket (its `react-native` export condition
   * resolves to a self-contained ESM build), which is what the telemetry
   * plane was measured on.
   */
  mqttConnect?: XorgatePlatform["mqttConnect"];
}

/**
 * The React Native half of `@xorgate/react`: pass it to the provider once and
 * every neutral hook in that package — telemetry, live video, the data hooks'
 * refetch-on-focus — runs on this runtime instead of a browser's.
 *
 * `XorgateNativeProvider` calls this for you; call it yourself only when you
 * are composing the platform with slots of your own.
 */
export function nativePlatform(options: NativePlatformOptions = {}): XorgatePlatform {
  const randomId = options.randomId ?? globalRandomId;
  return {
    createWebRtcPlatform: () => createNativeWebRtcPlatform(randomId),
    subscribeWake: options.wake?.length
      ? composeWake(appStateWake, ...options.wake)
      : appStateWake,
    randomId,
    ...(options.mqttConnect ? { mqttConnect: options.mqttConnect } : {}),
  };
}

/**
 * `crypto.randomUUID()` if the runtime has one, with an error that names both
 * fixes if it does not. Hermes on Expo SDK 57 has no `crypto` global at all —
 * not `randomUUID`, not `getRandomValues`, not `subtle`.
 */
function globalRandomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c || typeof c.randomUUID !== "function") {
    throw new Error(
      "This runtime has no crypto.randomUUID(). Add `import \"@xorgate/react-native/polyfills\"` " +
        "to the top of your entry file, or pass `randomId` to nativePlatform().",
    );
  }
  return c.randomUUID();
}
