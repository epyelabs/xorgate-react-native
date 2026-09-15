import { afterEach, describe, expect, it, vi } from "vitest";
import { nativePlatform } from "../src/platform.js";
import { appStateListenerCount, emitAppState } from "./doubles/react-native.js";
import { RTCPeerConnection } from "./doubles/react-native-webrtc.js";

// jsdom defines `crypto` as a getter-only property, so a plain assignment
// throws; `stubGlobal` redefines it and `unstubAllGlobals` puts it back.
afterEach(() => {
  vi.unstubAllGlobals();
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

  it("falls back to the crypto global when no randomId is given", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "from-global" });
    expect(nativePlatform().randomId!()).toBe("from-global");
  });

  it("names both fixes when the runtime has no crypto global (Hermes)", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => nativePlatform().randomId!()).toThrow(
      /@xorgate\/react-native\/polyfills.*randomId/s,
    );
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
