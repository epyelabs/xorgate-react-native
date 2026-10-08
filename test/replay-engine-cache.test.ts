/**
 * The lane engine with a segment cache: finished segments reach the player as
 * local files, everything else is exactly the streaming path it was. The cache
 * here is a hand-driven fake, so each test decides when (and how) a download
 * ends; the disk side has its own suite.
 */
import { describe, expect, it, vi } from "vitest";
import { buildTimeline, type ReplaySegment } from "@xorgate/react";
import { ExpoVideoReplayEngine } from "../src/replay-engine.js";
import {
  SegmentFetchError,
  segmentCacheKey,
  type ReplaySegmentCache,
} from "../src/segment-cache.js";
import { asNative, FakeVideoPlayer } from "./doubles/expo-video.js";

const FROM = 1_760_000_000_000;

function segments(finalized = true): ReplaySegment[] {
  return [0, 1, 2].map((seq) => ({
    seq,
    startTs: FROM + seq * 60_000,
    effectiveDurationMs: 60_000,
    finalized,
    anchor: "boundary" as const,
    sizeBytes: 7_000_000,
    url: `https://s3.example/s1/0000${seq}.mp4?sig=abc`,
  }));
}

interface Acquire {
  key: string;
  url: string;
  expectedBytes: number | null;
  signal: AbortSignal;
  resolve: (uri: string) => void;
  reject: (err: unknown) => void;
}

/** A cache whose every download waits for the test. */
function fakeCache() {
  const acquires: Acquire[] = [];
  const released: string[] = [];
  const cache: ReplaySegmentCache = {
    acquire: (key, url, expectedBytes, signal) =>
      new Promise<string>((resolve, reject) => {
        acquires.push({ key, url, expectedBytes, signal, resolve, reject });
      }),
    release: (key) => {
      released.push(key);
    },
  };
  return { cache, acquires, released };
}

const local = (seq: number) => `file:///cache/xorgate-replay-segments/seg${seq}.mp4`;
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function harness(segs = segments(), withCache = true) {
  const timeline = buildTimeline({ segments: segs, gaps: [] }, FROM, FROM + 180_000);
  const players: [FakeVideoPlayer, FakeVideoPlayer] = [new FakeVideoPlayer(), new FakeVideoPlayer()];
  const fake = fakeCache();
  const onError = vi.fn();
  const onAuthError = vi.fn();
  const engine = new ExpoVideoReplayEngine({
    timeline,
    getUrl: (seg) => seg.url,
    onError,
    onUpdate: vi.fn(),
    onAuthError,
    players: [asNative(players[0]), asNative(players[1])],
    ...(withCache ? { segmentCache: fake.cache } : {}),
  });
  return { engine, players, segs, onError, onAuthError, ...fake };
}

describe("ExpoVideoReplayEngine with a segment cache", () => {
  it("hands the player the local file once the segment is on disk", async () => {
    const h = harness();
    h.engine.ensureAt(FROM);
    await flush();

    // Asked for by object path (the signature is not part of the key), with
    // the manifest's size so a short file is refused.
    expect(h.acquires).toHaveLength(1);
    expect(h.acquires[0].key).toBe(segmentCacheKey(h.segs[0].url));
    expect(h.acquires[0].key).not.toContain("sig=");
    expect(h.acquires[0].expectedBytes).toBe(7_000_000);
    // Nothing reaches the player until the file is whole.
    expect(h.players[1].loadedUri).toBeNull();
    expect(h.engine.isStalled()).toBe(true);

    h.acquires[0].resolve(local(0));
    await flush();
    expect(h.players[1].loadedUri).toBe(local(0));

    h.players[1].becomeReady(60);
    expect(h.engine.activeIndex).toBe(1);
  });

  it("streams a segment that is still being recorded", async () => {
    const h = harness(segments(false));
    h.engine.ensureAt(FROM);
    await flush();
    expect(h.acquires).toHaveLength(0);
    expect(h.players[1].loadedUri).toBe(h.segs[0].url);
  });

  it("streams everything when no cache is given", async () => {
    const h = harness(segments(), false);
    h.engine.ensureAt(FROM);
    await flush();
    expect(h.acquires).toHaveLength(0);
    expect(h.players[1].loadedUri).toBe(h.segs[0].url);
  });

  it("ignores what the player reports about its previous item while downloading", async () => {
    const h = harness();
    h.engine.ensureAt(FROM);
    await flush();
    // The hidden player still holds whatever it had; a status event now is
    // about THAT item, and must not promote it as segment 0.
    h.players[1].emitStatus("readyToPlay");
    expect(h.engine.activeIndex).toBe(0);
    expect(h.engine.isStalled()).toBe(true);
  });

  it("an expired signature refreshes the manifest instead of streaming", async () => {
    const h = harness();
    h.engine.ensureAt(FROM);
    await flush();
    h.acquires[0].reject(new SegmentFetchError("response has status 403", 403));
    await flush();
    expect(h.onAuthError).toHaveBeenCalledTimes(1);
    expect(h.players[1].loadedUri).toBeNull();
    // Retried through the backoff, not at notify rate.
    h.engine.ensureAt(FROM);
    await flush();
    expect(h.acquires).toHaveLength(1);
  });

  it("a deleted segment is a media error", async () => {
    const h = harness();
    h.engine.ensureAt(FROM);
    await flush();
    h.acquires[0].reject(new SegmentFetchError("response has status 404", 404));
    await flush();
    expect(h.onError).toHaveBeenCalledWith("Recorded video segment 0 is no longer available.");
    expect(h.players[1].loadedUri).toBeNull();
  });

  it("anything else falls back to streaming the presigned URL", async () => {
    const h = harness();
    h.engine.ensureAt(FROM);
    await flush();
    h.acquires[0].reject(new SegmentFetchError("No space left on device", null));
    await flush();
    expect(h.players[1].loadedUri).toBe(h.segs[0].url);
    expect(h.onError).not.toHaveBeenCalled();
    h.players[1].becomeReady(60);
    expect(h.engine.activeIndex).toBe(1);
  });

  it("a seek away abandons the download, and a late file is handed straight back", async () => {
    const h = harness();
    h.engine.ensureAt(FROM);
    await flush();
    const first = h.acquires[0];

    // Seek to segment 2 before segment 0 arrives: same hidden slot, new load.
    h.engine.seek(125);
    await flush();
    expect(first.signal.aborted).toBe(true);
    expect(h.acquires.at(-1)?.key).toBe(segmentCacheKey(h.segs[2].url));

    // The abandoned download completes anyway: never shown, reference returned.
    first.resolve(local(0));
    await flush();
    expect(h.released).toContain(first.key);
    expect(h.players.some((p) => p.loadedUri === local(0))).toBe(false);
  });

  it("returns a file when its player moves on to another segment", async () => {
    const h = harness();
    h.engine.ensureAt(FROM);
    await flush();
    h.acquires[0].resolve(local(0));
    await flush();
    h.players[1].becomeReady(60);
    h.engine.play();
    h.engine.ensureAt(FROM);
    await flush();
    // The preload of segment 1 goes to the other player.
    const next = h.acquires.find((a) => a.key === segmentCacheKey(h.segs[1].url));
    expect(next).toBeDefined();
    next?.resolve(local(1));
    await flush();
    expect(h.players[0].loadedUri).toBe(local(1));
    expect(h.released).toEqual([]);

    // A seek far ahead reloads the hidden player (segment 1's): its file goes back.
    h.engine.seek(125);
    await flush();
    h.acquires.at(-1)?.resolve(local(2));
    await flush();
    expect(h.released).toEqual([segmentCacheKey(h.segs[1].url)]);
  });

  it("destroy aborts a download in flight and hands back every file", async () => {
    const h = harness();
    h.engine.ensureAt(FROM);
    await flush();
    h.acquires[0].resolve(local(0));
    await flush();
    h.players[1].becomeReady(60);
    h.engine.play();
    h.engine.ensureAt(FROM);
    await flush();
    const preload = h.acquires.at(-1)!;

    h.engine.destroy();
    expect(preload.signal.aborted).toBe(true);
    expect(h.released).toEqual([segmentCacheKey(h.segs[0].url)]);
  });
});
