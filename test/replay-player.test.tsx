/**
 * The hook and the component, over the real `useReplayPlayerCore` from
 * `@xorgate/react`: only the native players are doubles. So the lane wiring
 * that this package exists to add — a pair of players per lane, attached
 * through `attachLane`, both views mounted, the front one following the
 * engine — is what is asserted, and the core's clock is exercised rather than
 * re-implemented.
 */
import { act, render } from "@testing-library/react";
import { setPlatformOS } from "./doubles/react-native.js";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReplayManifest } from "@xorgate/react";
import { ReplayVideo } from "../src/replay-video.js";
import { useReplayPlayer, type UseReplayPlayer } from "../src/use-replay-player.js";
import {
  asNative,
  createVideoPlayer,
  createdPlayers,
  mountedVideoViews,
  resetVideoPlayers,
  type FakeVideoPlayer,
} from "./doubles/expo-video.js";

const FROM = 1_760_000_000_000;

function manifest(streamKeys: string[] = ["cam0"]): ReplayManifest {
  return {
    deviceId: "dev-1",
    from: FROM,
    to: FROM + 120_000,
    urlExpiresAt: Date.now() + 3600_000,
    sessions: streamKeys.map((streamKey, index) => ({
      id: `session-${index}`,
      streamKey,
      status: "closed",
      timeSource: "ntp",
      codec: "avc1.42C028",
      width: 1280,
      height: 720,
      fps: 15,
      gaps: [],
      segments: [0, 1].map((seq) => ({
        seq,
        startTs: FROM + seq * 60_000,
        effectiveDurationMs: 60_000,
        finalized: true,
        anchor: "boundary" as const,
        sizeBytes: null,
        url: `https://s3.example/${streamKey}-${seq}.mp4`,
      })),
    })) as never,
  };
}

let captured: UseReplayPlayer | null = null;

function Screen({ replay }: { replay: ReplayManifest | null }) {
  const player = useReplayPlayer(replay, { createPlayer: () => asNative(createVideoPlayer(null)) });
  captured = player;
  return createElement(ReplayVideo, { player, streamKey: "cam0" });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => Promise.resolve());
}

afterEach(() => {
  resetVideoPlayers();
  captured = null;
  // The platform is module state on the double, so a test that moved it would
  // otherwise leak into every test after it.
  setPlatformOS("ios");
});

describe("useReplayPlayer / ReplayVideo", () => {
  it("makes one pair of players per lane and mounts both views", async () => {
    const view = render(createElement(Screen, { replay: manifest() }));
    await flush();

    expect(createdPlayers).toHaveLength(2);
    const views = mountedVideoViews();
    expect(views).toHaveLength(2);
    // One in front, one behind — the hidden one is the preload slot, and
    // mounting it is what makes a boundary an opacity flip.
    expect(views.map((v) => v.opacity).sort()).toEqual([0, 1]);
    // The clock owns the transport; a native scrubber would drive one file.
    expect(views.every((v) => v.nativeControls === false)).toBe(true);
    expect(views.every((v) => v.contentFit === "contain")).toBe(true);

    view.unmount();
  });

  /**
   * A native player does not stop downloading when its load is cancelled, so
   * a lane started and torn down inside one mount costs a whole segment: on
   * a 12 Mbps link that was 13.6 MB on the wire for a 7.3 MB segment, and the
   * first frame 9.7 s out instead of 6.1 s. Needs `@xorgate/react` >= 0.4.2,
   * whose core stopped replacing a lane's registration under its detach.
   */
  it("loads the first segment once on mount, and nothing is torn down to do it", async () => {
    const view = render(createElement(Screen, { replay: manifest() }));
    await flush();

    const loads = createdPlayers.flatMap((p: FakeVideoPlayer) => p.loads);
    expect(loads.map((source) => (source === null ? null : (source as { uri: string }).uri))).toEqual([
      "https://s3.example/cam0-0.mp4",
    ]);

    view.unmount();
  });

  /**
   * The seam is an opacity flip between two OVERLAPPING views, and on Android
   * `expo-video` draws into a `SurfaceView` by default — a layer the system
   * composites rather than one the view hierarchy draws, so `opacity: 0` does
   * not hide it and `zIndex` does not order it against its sibling. The hidden
   * preload then parks on the next segment's first frame ON TOP of the player
   * that is running, and the lane freezes for a whole segment while the clock
   * carries on. A `TextureView` is an ordinary view, so alpha means what it
   * says. iOS has no such split and must not be handed the prop.
   */
  it("draws into a TextureView on Android, and passes nothing on iOS", async () => {
    setPlatformOS("android");
    const android = render(createElement(Screen, { replay: manifest() }));
    await flush();
    expect(mountedVideoViews().every((v) => v.surfaceType === "textureView")).toBe(true);
    android.unmount();

    resetVideoPlayers();
    setPlatformOS("ios");
    const ios = render(createElement(Screen, { replay: manifest() }));
    await flush();
    expect(mountedVideoViews().every((v) => v.surfaceType === undefined)).toBe(true);
    ios.unmount();
  });

  it("moves the front view to the player the engine promoted", async () => {
    const view = render(createElement(Screen, { replay: manifest() }));
    await flush();

    const loaded = createdPlayers.find(
      (p: FakeVideoPlayer) => p.loadedUri === "https://s3.example/cam0-0.mp4",
    );
    expect(loaded).toBeDefined();
    expect(mountedVideoViews().find((v) => v.player === loaded)?.opacity).toBe(0);

    await act(async () => {
      loaded?.becomeReady(60);
    });
    await flush();

    expect(captured?.lanePlayer("cam0")).toBe(loaded);
    expect(mountedVideoViews().find((v) => v.player === loaded)?.opacity).toBe(1);
    expect(captured?.laneState("cam0").status).toBe("ready");

    view.unmount();
  });

  it("returns null media for a stream the replay has no lane for", async () => {
    const view = render(createElement(Screen, { replay: manifest() }));
    await flush();

    expect(captured?.laneMedia("cam1")).toBeNull();
    expect(captured?.lanePlayer("cam1")).toBeNull();

    view.unmount();
  });

  it("gives each lane its own pair", async () => {
    const view = render(createElement(Screen, { replay: manifest(["cam0", "cam1"]) }));
    await flush();

    expect(createdPlayers).toHaveLength(4);
    const cam0 = captured?.laneMedia("cam0");
    const cam1 = captured?.laneMedia("cam1");
    expect(cam0).not.toBeNull();
    expect(cam1).not.toBeNull();
    expect(cam0?.players[0]).not.toBe(cam1?.players[0]);
    // Only cam0 is rendered by this screen; cam1's lane exists and loads all
    // the same, which is what lets a second tile mount later with no reload.
    expect(mountedVideoViews()).toHaveLength(2);

    view.unmount();
  });

  it("releases every player it made on unmount", async () => {
    const view = render(createElement(Screen, { replay: manifest(["cam0", "cam1"]) }));
    await flush();
    expect(createdPlayers.every((p: FakeVideoPlayer) => p.released)).toBe(false);

    view.unmount();
    // `createVideoPlayer` is manual memory, unlike `useVideoPlayer`: nothing
    // else in the tree would free these.
    expect(createdPlayers).toHaveLength(4);
    expect(createdPlayers.every((p: FakeVideoPlayer) => p.released)).toBe(true);
  });

  it("keeps the same players across a manifest refresh that only re-signs URLs", async () => {
    const first = manifest();
    const view = render(createElement(Screen, { replay: first }));
    await flush();
    const before = [...createdPlayers];

    // What `useReplayManifest` does before the presigned URLs lapse: the same
    // replay, new URLs. Rebuilding the players under it would restart playback.
    const resigned: ReplayManifest = {
      ...first,
      sessions: first.sessions.map((session) => ({
        ...session,
        segments: session.segments.map((seg) => ({ ...seg, url: `${seg.url}?sig=2` })),
      })),
    };
    view.rerender(createElement(Screen, { replay: resigned }));
    await flush();

    expect(createdPlayers).toEqual(before);
    view.unmount();
  });
});
