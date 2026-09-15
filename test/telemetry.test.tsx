import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { MqttLikeClient } from "@xorgate/react";
import { useLiveTelemetry } from "../src/index.js";
import { XorgateNativeProvider } from "../src/provider.js";
import { emitAppState } from "./doubles/react-native.js";

/**
 * Telemetry needs no adapter of its own — mqtt.js 5 runs unmodified on React
 * Native's global WebSocket. What it DOES need from this package is the wake
 * source, and it needs it more than a browser does: iOS suspends the socket
 * within seconds of the app leaving the screen, and without a foreground
 * nudge the feed sits out a backoff of up to 30 s in front of a user who is
 * looking straight at it.
 */

const VEND = {
  accessKeyId: "AK",
  secretAccessKey: "SK",
  sessionToken: "ST",
  expiration: new Date(Date.now() + 3600_000).toISOString(),
  organizationId: "org-1",
  workspaceId: "ws-1",
  live: { region: "us-east-1", realtimeEndpoint: "iot-ats.example.com" },
};

class FakeMqttClient implements MqttLikeClient {
  private readonly handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  readonly subscribed: string[] = [];
  ended = false;
  on(event: string, cb: (...args: unknown[]) => void): unknown {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  subscribe(topic: string): unknown {
    this.subscribed.push(topic);
    return this;
  }
  end(): unknown {
    this.ended = true;
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
}

function setup() {
  const clients: FakeMqttClient[] = [];
  const urls: string[] = [];
  const specs: Array<{ clientId: string; topics: string[] }> = [];
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(XorgateNativeProvider, {
      auth: { getLiveCredentials: async () => VEND },
      organizationId: null,
      config: {},
      randomId: () => "native-entropy",
      mqttConnect: async (url: string, spec: { clientId: string; topics: string[] }) => {
        urls.push(url);
        specs.push(spec);
        const client = new FakeMqttClient();
        clients.push(client);
        return client;
      },
      children,
    });
  return { wrapper, clients, urls, specs };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => Promise.resolve());
}

describe("live telemetry on the native platform", () => {
  it("connects with a presigned URL and the platform's client id", async () => {
    const { wrapper, clients, urls, specs } = setup();
    const { result } = renderHook(() => useLiveTelemetry("device-connect"), { wrapper });
    await flush();

    expect(clients).toHaveLength(1);
    expect(urls[0]).toMatch(/^wss:\/\/iot-ats\.example\.com\/mqtt\?/);
    expect(urls[0]).toContain("X-Amz-Signature=");
    // The credential resolver's entropy comes from the platform slot, not from
    // a `crypto` global — Hermes has none. The client id is a connect option,
    // not part of the signed URL.
    expect(specs[0]!.clientId).toBe("xgl-native-entropy");

    await act(async () => clients[0]!.emit("connect"));
    expect(result.current.status).toBe("connected");
    expect(clients[0]!.subscribed).toEqual([
      "xorgate/orgs/org-1/ws/ws-1/devices/device-connect/telemetry",
    ]);
  });

  it("reconnects on the foreground edge instead of waiting out the backoff", async () => {
    const { wrapper, clients } = setup();
    const { result } = renderHook(() => useLiveTelemetry("device-wake"), { wrapper });
    await flush();
    await act(async () => clients[0]!.emit("connect"));
    expect(result.current.status).toBe("connected");

    // The socket the OS killed while the app was away.
    await act(async () => clients[0]!.emit("close"));
    expect(result.current.status).toBe("closed");
    expect(clients).toHaveLength(1);

    await act(async () => emitAppState("active"));
    await flush();
    expect(clients).toHaveLength(2);
  });

  it("leaves a healthy feed alone when the app is foregrounded", async () => {
    const { wrapper, clients } = setup();
    renderHook(() => useLiveTelemetry("device-noop"), { wrapper });
    await flush();
    await act(async () => clients[0]!.emit("connect"));

    await act(async () => emitAppState("active"));
    await flush();
    expect(clients).toHaveLength(1);
    expect(clients[0]!.ended).toBe(false);
  });

  it("parses a device frame into the interop shape", async () => {
    const { wrapper, clients } = setup();
    const { result } = renderHook(() => useLiveTelemetry("device-frame"), { wrapper });
    await flush();
    await act(async () => clients[0]!.emit("connect"));

    const ts = Date.now();
    await act(async () => {
      clients[0]!.emit(
        "message",
        "xorgate/orgs/org-1/ws/ws-1/devices/device-frame/telemetry",
        new TextEncoder().encode(
          JSON.stringify({
            v: 1,
            ts,
            metrics: { gps: { lat: { value: 43.66346 }, lon: { value: -79.51867 } } },
          }),
        ),
      );
    });
    // The feed coalesces a 1 Hz x N-metric device into at most four renders a
    // second, so the snapshot lands on the next flush tick, not synchronously.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(result.current.latest["gps.lat"]?.value).toBe(43.66346);
    expect(result.current.receivedAt).not.toBeNull();
  });
});
