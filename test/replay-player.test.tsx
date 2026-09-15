/**
 * The hook and the component, over the real `useReplayPlayerCore` from
 * `@xorgate/react`: only the native players are doubles. So the lane wiring
 * that this package exists to add — a pair of players per lane, attached
 * through `attachLane`, both views mounted, the front one following the
 * engine — is what is asserted, and the core's clock is exercised rather than
 * re-implemented.
 */
import { act, render } from "@testing-library/react";
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
