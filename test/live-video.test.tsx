import { act, render, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveVideo } from "../src/live-video.js";
import { XorgateNativeProvider } from "../src/provider.js";
import { useLiveVideo } from "../src/use-live-video.js";
import { emitAppState } from "./doubles/react-native.js";
import {
  fireDimensions,
  mountedRtcViews,
  resetRtcViews,
  rtcViewProps,
} from "./doubles/react-native-webrtc.js";
import { fakeStream, fakeWebRtcPlatform, type Attempt } from "./doubles/webrtc-platform.js";

/**
 * The whole chain, not the wrapper alone: `XorgateNativeProvider` builds the
 * native platform, the real `KvsViewerSession` from `@xorgate/react` runs on
 * it, and only `createWebRtcPlatform` is replaced by a fake. So a break in the
 * merge order, in the wake wiring or in the stream handoff fails here, and the
 * session's own hardening is exercised rather than re-implemented.
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

const CHANNEL = {
  streamKey: "cam0",
  channelName: "c",
  channelRef: "arn:aws:kinesisvideo:us-east-1:1:channel/c/1",
  region: "us-east-1",
} as never;

function setup() {
  const { platform: webrtc, attempts } = fakeWebRtcPlatform();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(XorgateNativeProvider, {
      auth: { getLiveCredentials: async () => VEND },
      organizationId: null,
      config: {},
      randomId: () => "native-entropy",
      platform: { createWebRtcPlatform: () => webrtc },
      children,
    });
  return { wrapper, attempts };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => Promise.resolve());
}

/** Drive one attempt from "signaling open" to a delivered remote stream. */
async function deliverStream(attempt: Attempt, id: string): Promise<void> {
  await act(async () => {
    attempt.signaling.emit("open");
  });
  await flush();
  await act(async () => {
    attempt.pc.emit("track", { streams: [fakeStream(id)] });
  });
}

afterEach(() => {
  resetRtcViews();
  vi.useRealTimers();
});

describe("useLiveVideo", () => {
  it("hands the received stream out as an RTCView url", async () => {
    const { wrapper, attempts } = setup();
    const { result } = renderHook(() => useLiveVideo(CHANNEL), { wrapper });

    expect(result.current.status).toBe("connecting");
    expect(result.current.streamURL).toBeNull();
    await flush();

    await deliverStream(attempts[0]!, "remote-a");
    expect(result.current.status).toBe("connected");
    expect(result.current.stream).toMatchObject({ id: "remote-a" });
    expect(result.current.streamURL).toBe("url:remote-a");
  });

  it("replaces the stream on a reconnect: the old one is dead, not resumable", async () => {
    const { wrapper, attempts } = setup();
    const { result } = renderHook(() => useLiveVideo(CHANNEL), { wrapper });
    await flush();
    await deliverStream(attempts[0]!, "remote-a");

    // The socket drops; the foreground edge nudges a fresh attempt.
    await act(async () => {
      attempts[0]!.signaling.emit("close");
    });
    expect(result.current.status).toBe("closed");
    await act(async () => {
      emitAppState("active");
    });
    await flush();
    expect(attempts).toHaveLength(2);

    await deliverStream(attempts[1]!, "remote-b");
    expect(result.current.streamURL).toBe("url:remote-b");
  });

  it("takes its client id from the platform's entropy, not a crypto global", async () => {
    const { wrapper, attempts } = setup();
    renderHook(() => useLiveVideo(CHANNEL), { wrapper });
    await flush();
    // The fake platform's own randomId wins for the signaling client id; what
    // matters here is that no `crypto.randomUUID()` was reached for.
    expect(attempts[0]!.clientId).toBe("fake-0");
  });

  it("drops the stream when the session is disabled, and rebuilds it when re-enabled", async () => {
    const { wrapper, attempts } = setup();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useLiveVideo(CHANNEL, { enabled }),
      { wrapper, initialProps: { enabled: true } },
    );
    await flush();
    await deliverStream(attempts[0]!, "remote-a");
    expect(result.current.streamURL).toBe("url:remote-a");

    await act(async () => rerender({ enabled: false }));
    expect(result.current.streamURL).toBeNull();
    expect(result.current.stream).toBeNull();
    expect(attempts[0]!.pc.closed).toBe(true);

    await act(async () => rerender({ enabled: true }));
    await flush();
    expect(attempts).toHaveLength(2);
  });
});

describe("LiveVideo", () => {
  const urls = () => mountedRtcViews();

  it("renders nothing until a stream arrives, then one view with objectFit cover", async () => {
    const { wrapper, attempts } = setup();
    render(createElement(LiveVideo, { channel: CHANNEL }), { wrapper });
    await flush();
    expect(urls()).toEqual([]);

    await deliverStream(attempts[0]!, "remote-a");
    expect(urls()).toEqual([{ streamURL: "url:remote-a", opacity: 1 }]);
    expect(rtcViewProps("url:remote-a")?.objectFit).toBe("cover");
  });

  it("holds the outgoing picture across a reconnect until the new stream has a frame", async () => {
    const { wrapper, attempts } = setup();
    render(createElement(LiveVideo, { channel: CHANNEL }), { wrapper });
    await flush();
    await deliverStream(attempts[0]!, "remote-a");

    await act(async () => {
      attempts[0]!.signaling.emit("close");
      emitAppState("active");
    });
    await flush();
    await deliverStream(attempts[1]!, "remote-b");

    // Both mounted: the old one still visible, the new one decoding at zero
    // opacity. This is what stops a reconnect from flashing black.
    expect(urls()).toEqual([
      { streamURL: "url:remote-a", opacity: 1 },
      { streamURL: "url:remote-b", opacity: 0 },
    ]);

    await act(async () => fireDimensions("url:remote-b"));
    expect(urls()).toEqual([{ streamURL: "url:remote-b", opacity: 1 }]);
  });

  it("gives up the hold rather than pin a stale frame when the new stream never decodes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { wrapper, attempts } = setup();
    render(createElement(LiveVideo, { channel: CHANNEL }), { wrapper });
    await flush();
    await deliverStream(attempts[0]!, "remote-a");
    await act(async () => {
      attempts[0]!.signaling.emit("close");
      emitAppState("active");
    });
    await flush();
    await deliverStream(attempts[1]!, "remote-b");
    expect(urls()).toHaveLength(2);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(urls()).toEqual([{ streamURL: "url:remote-b", opacity: 1 }]);
  });

  it("reports the displayed stream, which lags the session's across a hold", async () => {
    const { wrapper, attempts } = setup();
    const displayed: Array<string | null> = [];
    render(
      createElement(LiveVideo, {
        channel: CHANNEL,
        onDisplayedStreamChange: (url) => displayed.push(url),
      }),
      { wrapper },
    );
    await flush();
    await deliverStream(attempts[0]!, "remote-a");
    await act(async () => {
      attempts[0]!.signaling.emit("close");
      emitAppState("active");
    });
    await flush();
    await deliverStream(attempts[1]!, "remote-b");

    // The session is already on B; the screen is still showing A.
    expect(displayed).toEqual([null, "url:remote-a"]);

    await act(async () => fireDimensions("url:remote-b"));
    expect(displayed).toEqual([null, "url:remote-a", "url:remote-b"]);
  });

  it("reports every status transition and the video's dimensions", async () => {
    const { wrapper, attempts } = setup();
    const statuses: string[] = [];
    const dimensions: Array<{ width: number; height: number }> = [];
    render(
      createElement(LiveVideo, {
        channel: CHANNEL,
        onStatusChange: (status) => statuses.push(status),
        onVideoDimensions: (d) => dimensions.push(d),
      }),
      { wrapper },
    );
    await flush();
    await deliverStream(attempts[0]!, "remote-a");
    await act(async () => fireDimensions("url:remote-a", 1280, 720));

    expect(statuses).toEqual(["connecting", "waiting", "connected"]);
    expect(dimensions).toEqual([{ width: 1280, height: 720 }]);
  });
});
