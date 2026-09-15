/**
 * The two-player lane engine, driven the way the player core drives it
 * (`ensureAt` at notify rate, `play`/`pause`/`seek`/`setRate`) with the native
 * side played by the expo-video double.
 *
 * Nothing here re-tests the timeline or the clock: those are `@xorgate/react`'s
 * and already covered there. What is asserted is the part that is only true on
 * a phone — which player a segment lands on, that nothing is trusted before
 * the status event, that the playhead does not jump at a seam, and that the
 * outgoing picture survives a seek.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildTimeline,
  type ReplaySegment,
  type ReplayTimeline,
} from "@xorgate/react";
import { ExpoVideoReplayEngine } from "../src/replay-engine.js";
import { asNative, FakeVideoPlayer } from "./doubles/expo-video.js";

const FROM = 1_760_000_000_000;

/** Three contiguous 60 s / 60 s / 25 s segments — the shape of the real run. */
function segments(): ReplaySegment[] {
  const spec = [
    { seq: 0, durationMs: 60_000 },
    { seq: 1, durationMs: 60_000 },
    { seq: 2, durationMs: 25_000 },
  ];
  let startTs = FROM;
  return spec.map(({ seq, durationMs }) => {
    const seg: ReplaySegment = {
      seq,
      startTs,
      effectiveDurationMs: durationMs,
      finalized: true,
      anchor: "boundary",
      sizeBytes: null,
      url: `https://s3.example/seg-${seq}.mp4`,
    };
    startTs += durationMs;
    return seg;
  });
}

interface Harness {
  engine: ExpoVideoReplayEngine;
  players: [FakeVideoPlayer, FakeVideoPlayer];
  timeline: ReplayTimeline;
  segs: ReplaySegment[];
  onError: ReturnType<typeof vi.fn>;
  onUpdate: ReturnType<typeof vi.fn>;
  onAuthError: ReturnType<typeof vi.fn>;
  onActivePlayerChange: ReturnType<typeof vi.fn>;
  hidden: () => FakeVideoPlayer;
  front: () => FakeVideoPlayer;
}

function harness(overrides: { segments?: ReplaySegment[] } = {}): Harness {
  const segs = overrides.segments ?? segments();
  const to =
    segs[segs.length - 1].startTs + segs[segs.length - 1].effectiveDurationMs;
  const timeline = buildTimeline({ segments: segs, gaps: [] }, FROM, to);
  const players: [FakeVideoPlayer, FakeVideoPlayer] = [
    new FakeVideoPlayer(),
    new FakeVideoPlayer(),
  ];
  const onError = vi.fn();
  const onUpdate = vi.fn();
  const onAuthError = vi.fn();
  const onActivePlayerChange = vi.fn();
  const engine = new ExpoVideoReplayEngine({
    timeline,
    getUrl: (seg) => seg.url,
    onError,
    onUpdate,
    onAuthError,
    players: [asNative(players[0]), asNative(players[1])],
    onActivePlayerChange,
  });
  return {
    engine,
    players,
    timeline,
    segs,
    onError,
    onUpdate,
    onAuthError,
    onActivePlayerChange,
    hidden: () => players[1 - engine.activeIndex],
    front: () => players[engine.activeIndex],
  };
}

/** Load segment 0, make it ready and start playing — the state every test starts from. */
async function startPlaying(h: Harness): Promise<void> {
  h.engine.ensureAt(FROM);
  await Promise.resolve();
  const loading = h.players.find((p) => p.loadedUri === h.segs[0].url);
  loading?.becomeReady(60);
  h.engine.play();
  // The core pumps `ensureAt`; that is what starts the one-ahead preload.
  h.engine.ensureAt(FROM);
  await Promise.resolve();
  h.hidden().becomeReady(60);
}

describe("ExpoVideoReplayEngine", () => {
  it("loads the covering segment onto the hidden player and preloads the next", async () => {
    const h = harness();
    h.engine.ensureAt(FROM);
    await Promise.resolve();

    // The first activation goes to the hidden slot like every other one: the
    // engine never replaces the source of the player that is on screen.
    expect(h.players[1].loadedUri).toBe(h.segs[0].url);
    expect(h.players[0].loadedUri).toBeNull();

    h.players[1].becomeReady(60);
    expect(h.engine.activeIndex).toBe(1);
    expect(h.onActivePlayerChange).toHaveBeenCalled();

    h.engine.ensureAt(FROM);
    await Promise.resolve();
    expect(h.players[0].loadedUri).toBe(h.segs[1].url);
  });

  it("does not trust a load until the status event says readyToPlay", async () => {
    const h = harness();
    h.engine.play();
    h.engine.ensureAt(FROM);
    await Promise.resolve();

    // `replaceAsync` has resolved. SPIKES §4: status is still `loading` at
    // this point, and `bufferedPosition` may still answer for the old item.
    expect(h.engine.activeIndex).toBe(0);
    expect(h.players[1].playing).toBe(false);
    expect(h.engine.isStalled()).toBe(true);

    h.players[1].becomeReady(60);
    expect(h.engine.activeIndex).toBe(1);
    expect(h.players[1].playing).toBe(true);
    expect(h.engine.isStalled()).toBe(false);
  });

  it("prepares the next segment early but only swaps AT the manifest boundary", async () => {
    const h = harness();
    await startPlaying(h);
    const showing = h.front();
    const next = h.hidden();
    expect(next.loadedUri).toBe(h.segs[1].url);

    // Half a second out: the incoming player is parked, not playing, and the
    // picture has not changed.
    showing.emitTime(59.6);
    expect(next.playing).toBe(false);
    expect(h.engine.activeIndex).toBe(showing === h.players[0] ? 0 : 1);
    expect(h.engine.position).toBeCloseTo(59.6, 3);

    // At the boundary the swap happens, and the playhead is continuous: the
    // outgoing player was at 60.0 s of segment 0, the incoming is at 0 s of
    // segment 1, and both are 60 s into the lane.
    showing.emitTime(60.0);
    expect(h.engine.activeIndex).toBe(next === h.players[0] ? 0 : 1);
    expect(next.playing).toBe(true);
    expect(showing.playing).toBe(false);
    expect(h.engine.position).toBeCloseTo(60, 3);
  });

  it("crosses the second boundary and preloads the segment after each swap", async () => {
    const h = harness();
    await startPlaying(h);

    h.front().emitTime(59.6);
    h.front().emitTime(60.0);
    await Promise.resolve();
    // The retired player is now the preload slot for segment 2.
    expect(h.hidden().loadedUri).toBe(h.segs[2].url);
    h.hidden().becomeReady(25);

    h.front().emitTime(59.6);
    h.front().emitTime(60.0);
    expect(h.front().loadedUri).toBe(h.segs[2].url);
    expect(h.engine.position).toBeCloseTo(120, 3);

    // The last segment: nothing to prepare, and the lane simply runs out.
    h.front().emitTime(25);
    expect(h.engine.position).toBeCloseTo(145, 3);
  });

  it("crosses a boundary whose file falls a few ms short of the manifest", async () => {
    const h = harness();
    await startPlaying(h);
    const showing = h.front();
    const next = h.hidden();
    // What the real seq-0 segment does: 60.000 s claimed, 59.987 s of file.
    showing.duration = 59.987;

    showing.emitTime(59.6); // lead-in prepared
    expect(next.playing).toBe(false);

    // The 50 ms cadence never lands on 59.987, and this file emits no
    // `playToEnd` — the two ways a strict boundary test silently never fires.
    showing.emitTime(59.95);

    expect(h.engine.activeIndex).toBe(next === h.players[0] ? 0 : 1);
    expect(next.playing).toBe(true);
    expect(h.engine.position).toBeCloseTo(60, 2);
  });

  it("swaps on the player stopping by itself when no other signal arrives", async () => {
    const h = harness();
    await startPlaying(h);
    const showing = h.front();
    const next = h.hidden();
    showing.duration = 60;

    showing.emitTime(59.6); // lead-in prepared, not released
    expect(h.engine.activeIndex).toBe(showing === h.players[0] ? 0 : 1);

    // No further `timeUpdate`, no `playToEnd`: the native player simply stops.
    showing.stopOnItsOwn();
    expect(h.engine.activeIndex).toBe(next === h.players[0] ? 0 : 1);
    expect(next.playing).toBe(true);
  });

  it("does not report a prepared lead-in as a stall", async () => {
    const h = harness();
    await startPlaying(h);
    const showing = h.front();
    showing.emitTime(59.6);

    // The core's stall recovery reads this. Answering `true` here sends it
    // into a boundary the engine is one event away from crossing — and since
    // the playhead is already inside the NEXT segment, its recovery jumps to
    // the END of that segment and skips the whole thing. Measured on the
    // device before this guard existed: 57.7 s of a 145.6 s replay gone.
    expect(h.engine.isStalled()).toBe(false);

    // Even with the outgoing player reporting a buffer underrun at its own
    // file end, which is how the device got there.
    showing.emitStatus("loading");
    expect(h.engine.isStalled()).toBe(false);
  });

  it("releases a prepared lead-in from the pump if nothing else did", async () => {
    const h = harness();
    await startPlaying(h);
    const showing = h.front();
    const next = h.hidden();
    showing.emitTime(59.6);
    expect(h.engine.activeIndex).toBe(showing === h.players[0] ? 0 : 1);

    // Nothing at all arrives: no time update, no stop, no end. The watchdog
    // is the only thing between that and a lane frozen forever, because a
    // player that is out of content still reports itself `readyToPlay`.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 500);
      h.engine.ensureAt(FROM + 59_700);
    } finally {
      vi.useRealTimers();
    }
    expect(h.engine.activeIndex).toBe(next === h.players[0] ? 0 : 1);
  });

  it("treats playToEnd as the boundary when the file is shorter than the manifest", async () => {
    const h = harness();
    await startPlaying(h);
    const showing = h.front();
    const next = h.hidden();

    // The file ends at 58 s although the manifest claims 60 — what an
    // `fstat`-anchored seq-0 row does.
    showing.emitTime(58);
    expect(h.engine.activeIndex).toBe(showing === h.players[0] ? 0 : 1);
    showing.emitPlayToEnd();

    expect(h.engine.activeIndex).toBe(next === h.players[0] ? 0 : 1);
    expect(next.playing).toBe(true);
    // The shortfall is skipped rather than freezing the clock on a player
    // that will never advance again.
    expect(h.engine.position).toBeCloseTo(60, 3);
  });

  it("keeps the outgoing picture up while a cross-segment seek downloads", async () => {
    const h = harness();
    await startPlaying(h);
    const showing = h.front();
    showing.emitTime(10);
    const beforeIndex = h.engine.activeIndex;

    h.engine.seek(130); // into segment 2, which nothing holds
    await Promise.resolve();

    // Still the same player on screen, still its frame; the target segment is
    // loading on the hidden one.
    expect(h.engine.activeIndex).toBe(beforeIndex);
    expect(h.hidden().loadedUri).toBe(h.segs[2].url);
    // The seek target IS the position from the instant it is asked for, or
    // the pacer would drag the clock back to where the picture still is.
    expect(h.engine.position).toBeCloseTo(130, 3);
    expect(h.engine.isStalled()).toBe(true);

    h.hidden().becomeReady(25);
    expect(h.engine.activeIndex).not.toBe(beforeIndex);
    expect(h.front().currentTime).toBeCloseTo(10, 3); // 130 s − segment 2's 120 s start
    expect(h.front().playing).toBe(true);
  });

  it("seeks inside the active segment without loading anything", async () => {
    const h = harness();
    await startPlaying(h);
    const before = h.front().loads.length;

    h.engine.seek(20);
    await Promise.resolve();

    expect(h.front().currentTime).toBeCloseTo(20, 3);
    expect(h.front().loads.length).toBe(before);
    expect(h.engine.position).toBeCloseTo(20, 3);
  });

  it("answers isBufferedAt from the player that holds the segment", async () => {
    const h = harness();
    await startPlaying(h);
    h.front().bufferedPosition = 30;
    h.hidden().bufferedPosition = 12;

    expect(h.engine.isBufferedAt(25)).toBe(true); // segment 0, within 30 s
    expect(h.engine.isBufferedAt(45)).toBe(false); // segment 0, past its buffer
    expect(h.engine.isBufferedAt(70)).toBe(true); // segment 1, 10 s in, hidden has 12 s
    expect(h.engine.isBufferedAt(80)).toBe(false); // segment 1, 20 s in
    expect(h.engine.isBufferedAt(130)).toBe(false); // segment 2: neither player holds it

    // Buffered ranges are lane-local and clamped to the manifest duration.
    expect(h.engine.buffered()).toEqual([
      { start: 0, end: 30 },
      { start: 60, end: 72 },
    ]);
  });

  it("does not activate anything inside a gap, and keeps the far side warm", async () => {
    const segs = segments();
    // Push segment 2 ten seconds late: a real hole between 120 s and 130 s.
    segs[2] = { ...segs[2], startTs: segs[2].startTs + 10_000 };
    const h = harness({ segments: segs });
    await startPlaying(h);
    h.front().emitTime(59.6);
    h.front().emitTime(60.0);
    await Promise.resolve();
    h.hidden().becomeReady(25);
    const inGapIndex = h.engine.activeIndex;

    // The clock free-runs the gap; the engine must not swap to media that
    // does not cover it.
    h.engine.ensureAt(FROM + 125_000);
    await Promise.resolve();
    expect(h.engine.activeIndex).toBe(inGapIndex);
    expect(h.hidden().loadedUri).toBe(segs[2].url);

    // A wider hole is a cut, not a boundary: no lead-in across it.
    const showing = h.front();
    showing.emitTime(59.6);
    expect(h.hidden().playing).toBe(false);
  });

  it("probes a failed load and reports an expired signature as an auth error", async () => {
    const h = harness();
    const fetchMock = vi.fn().mockResolvedValue({ status: 403, ok: false });
    vi.stubGlobal("fetch", fetchMock);
    try {
      h.engine.ensureAt(FROM);
      await Promise.resolve();
      h.players[1].emitStatus("error", "The operation could not be completed");
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledWith(
        h.segs[0].url,
        expect.objectContaining({ headers: { Range: "bytes=0-0" } }),
      );
      expect(h.onAuthError).toHaveBeenCalledTimes(1);
      expect(h.onError).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a segment that is really gone as a media error", async () => {
    const h = harness();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 404, ok: false }),
    );
    try {
      h.engine.ensureAt(FROM);
      await Promise.resolve();
      h.players[1].emitStatus("error", "gone");
      await Promise.resolve();
      await Promise.resolve();

      expect(h.onAuthError).not.toHaveBeenCalled();
      expect(h.onError).toHaveBeenCalledWith(
        "Recorded video segment 0 is no longer available.",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("emits firstFrame once and waiting on an underrun of the visible player", async () => {
    const h = harness();
    const firstFrame = vi.fn();
    const waiting = vi.fn();
    h.engine.on("firstFrame", firstFrame);
    h.engine.on("waiting", waiting);

    await startPlaying(h);
    expect(firstFrame).toHaveBeenCalledTimes(1);
    expect(waiting).not.toHaveBeenCalled();

    h.front().emitStatus("loading");
    expect(waiting).toHaveBeenCalledTimes(1);

    // Recovery is not a second first frame.
    h.front().emitStatus("readyToPlay");
    h.front().emitTime(59.6);
    h.front().emitTime(60.0);
    expect(firstFrame).toHaveBeenCalledTimes(1);
  });

  it("applies the rate to both players and pauses only what is on screen", async () => {
    const h = harness();
    await startPlaying(h);

    h.engine.setRate(2);
    expect(h.players[0].playbackRate).toBe(2);
    expect(h.players[1].playbackRate).toBe(2);

    h.engine.pause();
    expect(h.engine.paused).toBe(true);
    expect(h.players[0].playing).toBe(false);
    expect(h.players[1].playing).toBe(false);

    h.engine.play();
    expect(h.front().playing).toBe(true);
    // The preload slot never plays: it is holding the next segment's frame 0.
    expect(h.hidden().playing).toBe(false);
  });

  it("detaches every listener and drops both sources on destroy", async () => {
    const h = harness();
    await startPlaying(h);
    h.engine.destroy();

    for (const player of h.players) {
      expect(player.listenerCount("timeUpdate")).toBe(0);
      expect(player.listenerCount("statusChange")).toBe(0);
      expect(player.listenerCount("playToEnd")).toBe(0);
      expect(player.loads[player.loads.length - 1]).toBeNull();
      // The players themselves belong to the hook, not to the engine.
      expect(player.released).toBe(false);
    }
  });
});
