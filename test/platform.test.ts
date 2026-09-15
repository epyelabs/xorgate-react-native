import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativePlatform } from "../src/platform.js";
import { resetExpoCrypto } from "./doubles/expo-crypto.js";
import { appStateListenerCount, emitAppState } from "./doubles/react-native.js";
import { RTCPeerConnection } from "./doubles/react-native-webrtc.js";

beforeEach(() => {
  resetExpoCrypto();
});

describe("nativePlatform", () => {
  it("fills exactly the slots React Native has to replace", () => {
    const platform = nativePlatform({ randomId: () => "id" });
    expect(Object.keys(platform).sort()).toEqual([
      "createWebRtcPlatform",
      "randomId",
      "subscribeWake",
    ]);
  });

  it("leaves mqttConnect unset so the SDK's own mqtt.js path is used", () => {
    expect(nativePlatform({ randomId: () => "id" }).mqttConnect).toBeUndefined();
  });

  it("passes an mqttConnect override through when one is given", () => {
    const mqttConnect = vi.fn();
    const platform = nativePlatform({ randomId: () => "id", mqttConnect });
    expect(platform.mqttConnect).toBe(mqttConnect);
  });

  it("builds peer connections from react-native-webrtc, relay included", () => {
    const webrtc = nativePlatform({ randomId: () => "id" }).createWebRtcPlatform!();
    const pc = webrtc.createPeerConnection([{ urls: "turn:example" }]) as unknown as RTCPeerConnection;
    expect(pc).toBeInstanceOf(RTCPeerConnection);
    // A viewer on a carrier NAT often has no path but the relay AWS hands out.
    expect(pc.config).toEqual({
      iceServers: [{ urls: "turn:example" }],
      iceTransportPolicy: "all",
    });
  });

  it("uses one entropy source for the platform and the WebRTC client ids", () => {
    let n = 0;
    const platform = nativePlatform({ randomId: () => `id-${n++}` });
    expect(platform.randomId!()).toBe("id-0");
    expect(platform.createWebRtcPlatform!().randomId()).toBe("id-1");
  });

  it("draws entropy from expo-crypto by default, not from a crypto global", () => {
    // Hermes has no `crypto` global at all, so there is nothing else to
    // default to — and the failure would be at the first MQTT connect, deep
    // inside the credential resolver, not at the provider.
    vi.stubGlobal("crypto", undefined);
    const platform = nativePlatform();
    expect(platform.randomId!()).toBe("expo-crypto-uuid-1");
    expect(platform.createWebRtcPlatform!().randomId()).toBe("expo-crypto-uuid-2");
    vi.unstubAllGlobals();
  });

  it("tells you to add the polyfill when the runtime has no crypto global", async () => {
    // What actually happens without it: @smithy/core's React Native bundle
    // dereferences a bare `crypto` and the viewer retries a ReferenceError
    // forever. The guard turns that into an instruction.
    vi.stubGlobal("crypto", undefined);
    const webrtc = nativePlatform().createWebRtcPlatform!();
    await expect(
      webrtc.getViewerEndpoints("arn:x", "us-east-1", {} as never),
    ).rejects.toThrow(/@xorgate\/react-native\/polyfills/);
    vi.unstubAllGlobals();
  });

  it("guards only the first AWS call, leaving the rest of the platform alone", () => {
    // The guard must not become a second implementation of the platform: the
    // peer connection and the entropy are still the ones built above.
    vi.stubGlobal("crypto", undefined);
    const webrtc = nativePlatform({ randomId: () => "id" }).createWebRtcPlatform!();
    expect(webrtc.randomId()).toBe("id");
    expect(webrtc.createPeerConnection([])).toBeInstanceOf(RTCPeerConnection);
    vi.unstubAllGlobals();
  });

  it("wakes on the foreground edge", () => {
    const onWake = vi.fn();
    const unsubscribe = nativePlatform({ randomId: () => "id" }).subscribeWake!(onWake);
    emitAppState("active");
    expect(onWake).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("merges extra wake sources with the foreground edge and unsubscribes both", () => {
    let fireNetwork: (() => void) | null = null;
    let networkUnsubscribed = false;
    const network = (onWake: () => void) => {
      fireNetwork = onWake;
      return () => {
        networkUnsubscribed = true;
      };
    };

    const onWake = vi.fn();
    const before = appStateListenerCount();
    const unsubscribe = nativePlatform({ randomId: () => "id", wake: [network] }).subscribeWake!(
      onWake,
    );

    emitAppState("active");
    expect(onWake).toHaveBeenCalledTimes(1);
    fireNetwork!();
    expect(onWake).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(networkUnsubscribed).toBe(true);
    expect(appStateListenerCount()).toBe(before);
  });
});
