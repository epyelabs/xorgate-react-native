import { randomUUID } from "expo-crypto";
import type { XorgatePlatform } from "@xorgate/react";
import { createNativeWebRtcPlatform } from "./webrtc-platform.js";
import { appStateWake, composeWake, type WakeSource } from "./wake.js";

export interface NativePlatformOptions {
  /**
   * Client-id entropy for MQTT and KVS signaling. Default: `expo-crypto`'s
   * `randomUUID()`. Hermes has no `crypto` global, so there is nothing else
   * to default to; pass your own only to use a different source.
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
  const randomId = options.randomId ?? randomUUID;
  return {
    createWebRtcPlatform: () => createNativeWebRtcPlatform(randomId),
    subscribeWake: options.wake?.length
      ? composeWake(appStateWake, ...options.wake)
      : appStateWake,
    randomId,
    ...(options.mqttConnect ? { mqttConnect: options.mqttConnect } : {}),
  };
}
