import {
  nextSegmentAfter,
  segmentAt,
  segmentEnd,
  type ReplayEngine,
  type ReplayEngineOptions,
  type ReplaySegment,
  type ReplayTimeline,
} from "@xorgate/react";
import type { VideoPlayer, VideoPlayerStatus } from "expo-video";

/** `expo-video` returns these from `addListener`; inferred so this file needs no import from expo-modules-core. */
type PlayerSubscription = ReturnType<VideoPlayer["addListener"]>;

/**
 * PREPARE the next segment this far before the manifest boundary. Nothing is
 * played early — the incoming player is only loaded and parked on its first
 * frame — so the lead costs no content and a generous one is free.
 */
const BOUNDARY_LEAD_S = 0.5;
/**
 * How close to a segment's end counts as having reached it. It must exceed
 * one `timeUpdate` interval: the last event before a file runs out lands
 * wherever the 50 ms cadence happens to put it, and a stricter test simply
 * never fires. The cost of releasing this early is at most one frame at the
 * recorder's 15 fps; the cost of never releasing is a stalled lane, which the
 * device showed is very much worse (see BOUNDARY_WAIT_MAX_MS).
 */
const BOUNDARY_EPSILON_S = 0.03;
/**
 * How long after a segment's expected end the boundary timer gives up waiting
 * for an event and swaps anyway. The device showed that the last `timeUpdate`
 * of a segment lands 60-80 ms short of the file's end and `playToEnd` /
 * `playingChange` follow a beat later, so something has to close the gap —
 * and it has to close it AFTER the end, not before: a timer that fires early
 * skips real video, where one that fires late only holds a frame.
 */
const BOUNDARY_TIMER_GRACE_MS = 120;
/**
 * Last resort, off the core's 500 ms pump: a lane that has stopped advancing
 * near the end of its segment with no lead-in armed at all. Nothing should
 * reach it, but a lane frozen at the end of a segment is invisible to the
 * player core — the media reports itself `readyToPlay`, because it is: it is
 * simply out of content — so it must not depend on any one signal.
 */
const BOUNDARY_WAIT_MAX_MS = 700;
/**
 * Two segments whose seam is wider than this are a CUT, not a boundary. The
 * lead-in only applies to contiguous media: playing across a real hole early
 * would show the future.
 */
const CONTIGUOUS_MS = 250;
/**
 * How long after crossing a boundary a move BACK into the segment just left is
 * treated as the clock catching up rather than as a seek. Promoting does not
 * move the playhead — the clock is paced by this lane, and it only learns the
 * new position on its next tick — so without this the very next `ensureAt`
 * arrives with a timestamp a few milliseconds before the boundary, drags the
 * lane back to the old segment, and the two ping-pong until the core gives up
 * and skips the whole segment. Measured on the device.
 */
const BOUNDARY_GRACE_MS = 1000;
/** Do not re-attempt a segment that just failed to load more often than this. */
const LOAD_RETRY_MS = 4000;
/**
 * `replaceAsync` resolves with `status` still `loading` and `readyToPlay`
 * follows ~200 ms later, so readiness is the EVENT's business (SPIKES.md §4).
 * This is the reconciler for the one case the event cannot cover: a player
 * whose status never left `readyToPlay` across the replace.
 */
const READY_RECONCILE_MS = 500;

/** One of the two native players, and what it is holding. */
interface Slot {
  readonly player: VideoPlayer;
  /** The segment this player holds, or is loading. */
  seg: ReplaySegment | null;
  /** `seg`'s media is loaded: the player has said `readyToPlay` for it. */
  ready: boolean;
  /** A `replaceAsync` for `seg` is in flight, or has not been confirmed yet. */
  loading: boolean;
  /** When the in-flight `replaceAsync` resolved, for the reconciler above. */
  loadedAt: number | null;
  /** Bumped on every load so a stale promise resolution is ignored. */
  gen: number;
  subs: PlayerSubscription[];
}

/** The hidden player being brought to the front, and how far along that is. */
interface Activation {
  idx: 0 | 1;
  seg: ReplaySegment;
  /** Seconds into `seg`. */
  offsetSec: number;
  /** Loaded and parked at `offsetSec`, showing that frame. */
  prepared: boolean;
  /** When `prepared` became true, for the watchdog. */
  preparedAt: number | null;
  /**
   * The outgoing media is finished (or there was never anything to wait for,
   * as on a seek): promote as soon as `prepared`. A boundary lead-in is
   * released by the outgoing player reaching the manifest boundary, which is
   * what keeps the playhead continuous across a seam.
   */
  released: boolean;
}

export interface ExpoVideoReplayEngineOptions extends ReplayEngineOptions {
  /**
   * The lane's two players. The engine drives them but does not own them:
   * `useReplayPlayer` creates and releases the pair, the same way the browser
   * engine is handed a `<video>` it did not create.
   */
  players: readonly [VideoPlayer, VideoPlayer];
  /** The player on screen changed. The hook re-renders so the views swap. */
  onActivePlayerChange?: () => void;
  /**
   * Every decision this lane makes, as one line. Off by default and costing
   * nothing when unset. A replay seam is tens of milliseconds wide and the
   * native player is the half you cannot step through, so the only way to
   * find out why a boundary did or did not happen is to have the engine say
   * so at the time.
   */
  onDebug?: (message: string) => void;
}

/**
 * One replay lane over two `expo-video` players (replay option A).
 *
 * The browser plays a lane as ONE `<video>` fed by Media Source Extensions:
 * segments are appended into a single continuous buffer and there is no seam
 * to manage. A phone has no MSE. `AVPlayer` and `ExoPlayer` play a FILE, and
 * every recorded segment is a self-contained fMP4 (own `ftyp`+`moov`, `tfdt`
 * from 0) — an ordinary playable MP4, and nothing that can be concatenated at
 * runtime. So a lane is two players: one showing segment N while the other
 * already holds N+1, and a boundary is an opacity swap between two views that
 * are both mounted.
 *
 * Four things shape the code, all measured on real segments before it was
 * written (SPIKES.md §4):
 *
 * - **The boundary is the MANIFEST's** (`effectiveDurationMs`), not the file's
 *   end: a segment's file routinely runs past the next segment's start
 *   (`fstat` anchors), and playing that tail would show the same wall clock
 *   twice. `playToEnd` is the fallback for the opposite case, a file SHORTER
 *   than the manifest claims.
 * - **Readiness is an event, not a promise.** `replaceAsync` resolves with
 *   `status` still `loading`, and `bufferedPosition` can report the previous
 *   item's value for a beat afterwards. Nothing here trusts a player until
 *   `statusChange → readyToPlay`.
 * - **Prepare early, promote on time.** The incoming player is loaded and
 *   parked on its first frame half a second before the boundary, but it is
 *   not played until the outgoing one actually reaches the boundary. That is
 *   what makes the seam a picture change with no playhead jump — swapping
 *   early would silently skip the lead, once per segment.
 * - **A cross-segment seek is download-bound** (1.3-5.3 s for a 6-13 MB
 *   segment), so it always loads onto the HIDDEN player and the outgoing
 *   picture stays up until the new one has a frame. Replacing the visible
 *   player's source instead is seconds of black.
 *
 * Positions are lane-local seconds, as `ReplayEngine` requires; the wall clock
 * stays the player core's business.
 */
export class ExpoVideoReplayEngine implements ReplayEngine {
  private readonly timeline: ReplayTimeline;
  private readonly getUrl: (seg: ReplaySegment) => string;
  private readonly onError: (message: string) => void;
  private readonly onUpdate: () => void;
  private readonly onAuthError: (() => void) | undefined;
  private readonly onActivePlayerChange: (() => void) | undefined;
  private readonly onDebug: ((message: string) => void) | undefined;

  private readonly slots: readonly [Slot, Slot];
  private activeIdx: 0 | 1 = 0;
  private activation: Activation | null = null;
  private boundaryTimer: ReturnType<typeof setTimeout> | null = null;

  private wantPlay = false;
  private rate = 1;
  private destroyed = false;
  private firstFrameFired = false;
  /** Lane-local seconds, kept so `position` is honest while nothing is ready. */
  private lastPos = 0;
  /** The last position the active player was seen at, and when — see `watchStall`. */
  private stalledAt: number | null = null;
  private stalledSince: number | null = null;
  /** The segment most recently left at a boundary, and when. See `activate`. */
  private crossed: { seg: ReplaySegment; at: number } | null = null;

  private readonly failedAt = new Map<number, number>();
  private readonly probing = new Set<number>();
  private readonly abort = new AbortController();
  private readonly waitingCbs = new Set<() => void>();
  private readonly firstFrameCbs = new Set<() => void>();

  constructor(opts: ExpoVideoReplayEngineOptions) {
    this.timeline = opts.timeline;
    this.getUrl = opts.getUrl;
    this.onError = opts.onError;
    this.onUpdate = opts.onUpdate;
    this.onAuthError = opts.onAuthError;
    this.onActivePlayerChange = opts.onActivePlayerChange;
    this.onDebug = opts.onDebug;
    this.slots = [this.makeSlot(opts.players[0], 0), this.makeSlot(opts.players[1], 1)];
  }

  private makeSlot(player: VideoPlayer, idx: 0 | 1): Slot {
    // Recorded segments are video-only; muting keeps the player away from the
    // audio session entirely, so a replay never ducks anything.
    player.muted = true;
    player.loop = false;
    // 50 ms: the resolution the boundary check and the seam measurement rest
    // on, and under one frame at the recorder's 15 fps.
    player.timeUpdateEventInterval = 0.05;
    const slot: Slot = {
      player,
      seg: null,
      ready: false,
      loading: false,
      loadedAt: null,
      gen: 0,
      subs: [],
    };
    slot.subs.push(
      player.addListener("timeUpdate", ({ currentTime }) => {
        this.onTimeUpdate(idx, currentTime);
      }),
      player.addListener("statusChange", ({ status, error }) => {
        this.onStatusChange(idx, status, error?.message ?? null);
      }),
      player.addListener("playToEnd", () => {
        this.onPlayToEnd(idx);
      }),
      player.addListener("playingChange", ({ isPlaying }) => {
        // A player that stops on its own while the transport says play has
        // run out of file. On the real segments this fires where `playToEnd`
        // does not, and it is the signal that releases a boundary whose file
        // ended a few milliseconds short of what the manifest claims.
        if (!isPlaying && this.wantPlay && idx === this.activeIdx) {
          this.releaseBoundary("the player stopped");
        }
      }),
    );
    return slot;
  }

  // --- the media surface (ReplayEngine) ------------------------------------

  get position(): number {
    const pending = this.activation;
    // A seek's target IS the position from the instant it is requested: the
    // browser's `video.currentTime = x` takes effect whether the media is
    // there or not, and a pacer that reported the outgoing segment instead
    // would drag the clock straight back to where the picture still is.
    if (pending && pending.released) {
      return this.segPos(pending.seg) + pending.offsetSec;
    }
    const active = this.slots[this.activeIdx];
    if (active.seg && active.ready) {
      return this.segPos(active.seg) + active.player.currentTime;
    }
    if (pending) return this.segPos(pending.seg) + pending.offsetSec;
    return this.lastPos;
  }

  get paused(): boolean {
    // Intent, not the native flag: a player mid-load is not "paused", and the
    // core reconciles transport off this on every notify.
    return !this.wantPlay;
  }

  /** The player whose picture belongs on screen. */
  get activePlayer(): VideoPlayer {
    return this.slots[this.activeIdx].player;
  }

  /** Which of the two players `activePlayer` is. */
  get activeIndex(): 0 | 1 {
    return this.activeIdx;
  }

  buffered(): Array<{ start: number; end: number }> {
    const out: Array<{ start: number; end: number }> = [];
    for (const slot of this.slots) {
      if (!slot.seg || !slot.ready) continue;
      const start = this.segPos(slot.seg);
      // Clamped to the MANIFEST duration: a file's tail past the next
      // segment's start is media this lane must never play.
      const end =
        start + Math.min(slot.player.bufferedPosition, slot.seg.effectiveDurationMs / 1000);
      if (end > start) out.push({ start, end });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  isBufferedAt(posSec: number): boolean {
    const ts = this.timeline.from + posSec * 1000;
    const hit = segmentAt(this.timeline, ts);
    if (!hit) return false;
    // Per-player state: "is ts buffered" is a question about the player that
    // HOLDS that segment, and a segment neither player holds is by definition
    // not buffered (SPIKES.md §4). `ready` is what makes `bufferedPosition`
    // safe to read — it can answer for the previous item until then.
    const slot = this.slotHolding(hit.segment);
    if (!slot || !slot.ready) return false;
    return (ts - hit.segment.startTs) / 1000 <= slot.player.bufferedPosition + 0.1;
  }

  isStalled(): boolean {
    // A prepared lead-in is NOT a stall: the next segment is loaded and one
    // event away from being shown. Saying otherwise sends the core's stall
    // recovery into a boundary it is about to cross anyway — and because the
    // playhead is already inside the NEXT segment by then, that recovery
    // jumps to the end of it and skips the whole segment. Measured on the
    // device: 57.7 s of a 145.6 s replay silently gone.
    if (this.activation?.prepared && !this.activation.released) return false;
    // Waiting on media that is due now: the outgoing player has run out (or a
    // seek has landed) and the incoming one is not loaded yet. Without this
    // the core cannot see a boundary the download did not make in time — the
    // frozen player still reports `readyToPlay`.
    if (this.activation?.released && !this.activation.prepared) return true;
    const active = this.slots[this.activeIdx];
    if (!active.seg || !active.ready) return true;
    return active.player.status !== "readyToPlay";
  }

  seek(posSec: number): void {
    if (this.destroyed) return;
    this.lastPos = posSec;
    const ts = this.timeline.from + posSec * 1000;
    const hit = segmentAt(this.timeline, ts);
    // In a gap the clock owns the playhead; `ensureAt` keeps the far side warm
    // so coming out of it is instant.
    if (!hit) return;

    const offsetSec = (ts - hit.segment.startTs) / 1000;
    const pending = this.activation;
    if (pending && sameSeg(pending.seg, hit.segment)) {
      pending.offsetSec = offsetSec;
      // A seek is due at once, even if this activation started as a boundary
      // lead-in that was still waiting for the outgoing segment.
      pending.released = true;
      if (pending.prepared) this.slots[pending.idx].player.currentTime = offsetSec;
      this.maybePromote();
      return;
    }
    const active = this.slots[this.activeIdx];
    if (sameSeg(active.seg, hit.segment) && active.ready) {
      // Back inside what is already on screen: an in-segment seek, 63 ms.
      this.cancelActivation();
      active.player.currentTime = offsetSec;
      return;
    }
    this.activate(hit.segment, offsetSec, false);
  }

  play(): void {
    if (this.destroyed) return;
    this.wantPlay = true;
    this.applyTransport();
    // A lead-in prepared while paused has no timer: arm it now that the
    // outgoing segment is running towards its end again.
    if (this.activation?.prepared && !this.activation.released) this.armBoundaryTimer();
  }

  pause(): void {
    if (this.destroyed) return;
    this.wantPlay = false;
    this.applyTransport();
  }

  setRate(rate: number): void {
    if (this.destroyed || this.rate === rate) return;
    this.rate = rate;
    this.applyTransport();
  }

  /**
   * Keep the media around `ts` — and the segment after it — loaded. Called at
   * clock-notify rate and from the core's 500 ms pump, so every path is
   * guarded: steady state does no work.
   */
  ensureAt(ts: number): void {
    if (this.destroyed) return;
    this.reconcileReady();

    // A load the backoff refused still has an activation waiting on it.
    // `load` re-throttles itself, so this is the retry ladder.
    const pending = this.activation;
    if (pending) {
      const slot = this.slots[pending.idx];
      if (!slot.ready && !slot.loading) this.load(pending.idx, pending.seg);
      // A prepared lead-in with no timer running (the app was backgrounded
      // and the timer was starved, say) still has to cross its boundary.
      if (this.wantPlay && pending.prepared && !pending.released && this.boundaryTimer === null) {
        this.armBoundaryTimer();
      }
    }
    this.watchStall();

    const hit = segmentAt(this.timeline, ts);
    if (hit) {
      const active = this.slots[this.activeIdx];
      const pendingSeg = this.activation?.seg ?? null;
      if (!sameSeg(active.seg, hit.segment) && !sameSeg(pendingSeg, hit.segment)) {
        this.activate(hit.segment, (ts - hit.segment.startTs) / 1000, false);
        return;
      }
      if (sameSeg(active.seg, hit.segment) && !active.ready && !active.loading) {
        // The visible slot's own load failed. Retry it through the backoff;
        // there is no picture to protect here.
        this.load(this.activeIdx, hit.segment);
        return;
      }
    }
    this.prefetchAfter(hit ? segmentEnd(hit.segment) : ts);
  }

  on(event: "waiting" | "firstFrame", cb: () => void): () => void {
    const set = event === "waiting" ? this.waitingCbs : this.firstFrameCbs;
    set.add(cb);
    return () => set.delete(cb);
  }

  destroy(): void {
    this.destroyed = true;
    this.abort.abort();
    this.clearBoundaryTimer();
    this.activation = null;
    for (const slot of this.slots) {
      for (const sub of slot.subs) sub.remove();
      slot.subs = [];
      slot.gen++;
      slot.seg = null;
      slot.ready = false;
      slot.loading = false;
      slot.loadedAt = null;
      try {
        slot.player.pause();
        // Drop the item so the native decoder and its buffer go with it. The
        // players themselves belong to the hook and are released there.
        void slot.player.replaceAsync(null).catch(() => undefined);
      } catch {
        /* already released by the hook's cleanup */
      }
    }
    this.waitingCbs.clear();
    this.firstFrameCbs.clear();
  }

  // --- internals -----------------------------------------------------------

  private debug(message: string): void {
    this.onDebug?.(message);
  }

  /** One line of state, for a debug message that has to explain a decision. */
  private snapshot(): string {
    const [a, b] = this.slots;
    const pending = this.activation;
    return (
      `active=${this.activeIdx === 0 ? "A" : "B"} ` +
      `A[seq=${a.seg?.seq ?? "-"} ready=${a.ready} loading=${a.loading} st=${a.player.status} ct=${a.player.currentTime.toFixed(2)} dur=${a.player.duration.toFixed(2)}] ` +
      `B[seq=${b.seg?.seq ?? "-"} ready=${b.ready} loading=${b.loading} st=${b.player.status} ct=${b.player.currentTime.toFixed(2)} dur=${b.player.duration.toFixed(2)}] ` +
      `pending=${pending ? `${pending.idx === 0 ? "A" : "B"}/seq${pending.seg.seq}/prep=${pending.prepared}/rel=${pending.released}` : "-"}`
    );
  }

  private segPos(seg: ReplaySegment): number {
    return (seg.startTs - this.timeline.from) / 1000;
  }

  private slotHolding(seg: ReplaySegment): Slot | null {
    for (const slot of this.slots) if (sameSeg(slot.seg, seg)) return slot;
    return null;
  }

  /**
   * Only the player on screen ever plays; the other one is preload.
   *
   * Every write below goes through JSI to a native object the hook owns, and
   * a call on one that has been released throws `NotFoundException` rather
   * than returning — so nothing here may run after `destroy()`.
   */
  private applyTransport(): void {
    if (this.destroyed) return;
    for (let i = 0; i < 2; i++) {
      const idx = i as 0 | 1;
      const slot = this.slots[idx];
      if (idx === this.activeIdx && this.wantPlay && slot.ready) {
        // The rate goes on the player that is about to play, and on no other:
        // on iOS a rate IS the transport, so setting it on a parked preload
        // can start it — which is how a preloaded segment reached 15.68 s
        // before it was ever shown.
        if (slot.player.playbackRate !== this.rate) slot.player.playbackRate = this.rate;
        slot.player.play();
      } else {
        slot.player.pause();
      }
    }
  }

  /**
   * Bring `seg` to the front at `offsetSec`, always through the HIDDEN player
   * so the picture on screen survives the load.
   */
  private activate(seg: ReplaySegment, offsetSec: number, seamless: boolean): void {
    if (this.destroyed) return;
    const crossed = this.crossed;
    if (crossed && sameSeg(crossed.seg, seg) && Date.now() - crossed.at < BOUNDARY_GRACE_MS) {
      // The clock is still a few milliseconds behind the boundary this lane
      // has already crossed. Going back would undo the swap, and then the
      // next tick would redo it.
      this.debug(`ignored a move back into seq ${seg.seq}: the clock has not caught up`);
      return;
    }
    const idx = (1 - this.activeIdx) as 0 | 1;
    const incoming = this.slots[idx];
    this.activation = {
      idx,
      seg,
      offsetSec,
      prepared: false,
      preparedAt: null,
      // A boundary lead-in waits for the outgoing segment to finish; anything
      // else (a seek, a gap exit, the first segment of all) is due now.
      released: !seamless,
    };
    this.debug(`activate seq ${seg.seq} +${offsetSec.toFixed(2)}s seamless=${seamless} · ${this.snapshot()}`);
    if (sameSeg(incoming.seg, seg) && incoming.ready) {
      this.prepare();
      return;
    }
    if (sameSeg(incoming.seg, seg) && incoming.loading) return;
    this.load(idx, seg);
  }

  private cancelActivation(): void {
    const pending = this.activation;
    if (!pending) return;
    this.activation = null;
    this.clearBoundaryTimer();
    this.slots[pending.idx].player.pause();
  }

  /** Park the incoming player on the frame it will be promoted with. */
  private prepare(): void {
    if (this.destroyed) return;
    const pending = this.activation;
    if (!pending || pending.prepared) return;
    const slot = this.slots[pending.idx];
    if (!slot.ready) return;
    // Unconditionally, not only for a non-zero offset: a preloaded player is
    // not reliably parked at 0 (the device found one sitting at 15.68 s), and
    // promoting it then starts the new segment part-way through.
    if (Math.abs(slot.player.currentTime - pending.offsetSec) > 0.05) {
      slot.player.currentTime = pending.offsetSec;
    }
    pending.prepared = true;
    pending.preparedAt = Date.now();
    this.debug(`prepared seq ${pending.seg.seq} on ${pending.idx === 0 ? "A" : "B"}`);
    this.armBoundaryTimer();
    this.maybePromote();
  }

  private maybePromote(): void {
    if (this.destroyed) return;
    const pending = this.activation;
    if (!pending || !pending.prepared || !pending.released) return;
    this.activation = null;
    this.clearBoundaryTimer();
    this.debug(`promote seq ${pending.seg.seq} to ${pending.idx === 0 ? "A" : "B"} at +${pending.offsetSec.toFixed(2)}s`);
    const retiredIdx = this.activeIdx;
    const retiredSeg = this.slots[retiredIdx].seg;
    this.activeIdx = pending.idx;
    if (retiredIdx !== pending.idx) this.slots[retiredIdx].player.pause();
    // Remember what was left, so the clock catching up cannot drag us back.
    if (retiredSeg && !sameSeg(retiredSeg, pending.seg)) {
      this.crossed = { seg: retiredSeg, at: Date.now() };
    }
    this.stalledAt = null;
    this.stalledSince = null;
    this.lastPos = this.segPos(pending.seg) + pending.offsetSec;
    this.applyTransport();
    this.onActivePlayerChange?.();
    if (!this.firstFrameFired) {
      this.firstFrameFired = true;
      for (const cb of this.firstFrameCbs) cb();
    }
    this.onUpdate();
    this.prefetchAfter(segmentEnd(pending.seg));
  }

  /** One segment of look-ahead on the hidden player — what makes a boundary free. */
  /**
   * Cross the boundary on time even if the outgoing player never says it is
   * finished. Armed when the lead-in is prepared, for the moment the segment
   * is expected to run out plus a short grace, and re-armed rather than fired
   * if the player is somehow still behind that (a pause, a slower rate). An
   * event almost always beats it; what it buys is that none of them has to,
   * and that the swap lands AFTER the end rather than before it — a timer
   * that fires early skips real video, one that fires late holds a frame.
   */
  private armBoundaryTimer(): void {
    this.clearBoundaryTimer();
    if (!this.wantPlay || this.destroyed) return;
    const slot = this.slots[this.activeIdx];
    if (!slot.seg) return;
    const remainMs = ((this.endOf(slot) - slot.player.currentTime) * 1000) / (this.rate || 1);
    this.boundaryTimer = setTimeout(
      () => this.onBoundaryTimer(),
      Math.max(0, remainMs) + BOUNDARY_TIMER_GRACE_MS,
    );
  }

  private onBoundaryTimer(): void {
    this.boundaryTimer = null;
    if (this.destroyed || !this.wantPlay) return;
    const pending = this.activation;
    if (!pending || pending.released || !pending.prepared) return;
    const slot = this.slots[this.activeIdx];
    if (!slot.seg) return;
    const remainMs = ((this.endOf(slot) - slot.player.currentTime) * 1000) / (this.rate || 1);
    if (remainMs > BOUNDARY_TIMER_GRACE_MS) {
      this.armBoundaryTimer();
      return;
    }
    this.releaseBoundary("the boundary timer");
  }

  private clearBoundaryTimer(): void {
    if (this.boundaryTimer !== null) {
      clearTimeout(this.boundaryTimer);
      this.boundaryTimer = null;
    }
  }

  private prefetchAfter(refTs: number): void {
    if (this.destroyed || this.activation) return;
    const next = nextSegmentAfter(this.timeline, refTs);
    if (!next) return;
    const idx = (1 - this.activeIdx) as 0 | 1;
    if (sameSeg(this.slots[idx].seg, next)) return;
    if (sameSeg(this.slots[this.activeIdx].seg, next)) return;
    this.load(idx, next);
  }

  private load(idx: 0 | 1, seg: ReplaySegment): void {
    const slot = this.slots[idx];
    const failed = this.failedAt.get(seg.startTs);
    if (failed !== undefined && Date.now() - failed < LOAD_RETRY_MS) return;
    this.debug(`load seq ${seg.seq} onto ${idx === 0 ? "A" : "B"}`);
    const gen = ++slot.gen;
    slot.seg = seg;
    slot.ready = false;
    slot.loading = true;
    slot.loadedAt = null;
    void slot.player.replaceAsync({ uri: this.getUrl(seg) }).then(
      () => {
        if (this.destroyed || slot.gen !== gen) return;
        slot.loadedAt = Date.now();
        // Deliberately not ready here: the promise resolves with `status`
        // still `loading`. `onStatusChange` is what promotes it, and
        // `reconcileReady` covers a status that never moved.
      },
      (err: unknown) => {
        if (this.destroyed || slot.gen !== gen) return;
        slot.loading = false;
        this.onLoadFailure(seg, err);
      },
    );
  }

  /**
   * The player on screen has stopped advancing while the transport says play.
   * That is a segment that has run out of file without saying so — and it is
   * the state that must never be left alone, because the player core's stall
   * recovery reads the playhead (already inside the NEXT segment) rather than
   * the media, and jumps to the end of a segment that was never shown.
   */
  private watchStall(): void {
    if (!this.wantPlay || this.destroyed) return;
    const slot = this.slots[this.activeIdx];
    if (!slot.seg || !slot.ready) {
      this.stalledSince = null;
      return;
    }
    const at = slot.player.currentTime;
    if (this.stalledAt === null || Math.abs(at - this.stalledAt) > 0.001) {
      this.stalledAt = at;
      this.stalledSince = Date.now();
      return;
    }
    if (this.stalledSince === null) {
      this.stalledSince = Date.now();
      return;
    }
    if (Date.now() - this.stalledSince <= BOUNDARY_WAIT_MAX_MS) return;
    // Only a stall at the END of the segment is a boundary; anywhere else it
    // is a buffer underrun and the core's recovery is the right answer.
    if (this.endOf(slot) - at > BOUNDARY_LEAD_S) return;
    this.stalledSince = null;
    this.releaseBoundary("the player stopped advancing");
  }

  private markReady(idx: 0 | 1): void {
    if (this.destroyed) return;
    const slot = this.slots[idx];
    if (!slot.seg || slot.ready) return;
    slot.ready = true;
    slot.loading = false;
    this.debug(`ready seq ${slot.seg.seq} on ${idx === 0 ? "A" : "B"} (buffered ${slot.player.bufferedPosition.toFixed(1)}s, duration ${slot.player.duration.toFixed(2)}s)`);
    this.failedAt.delete(slot.seg.startTs);
    // Always, not only for the visible slot: a freshly loaded preload must be
    // held still, and the rate belongs to whatever is about to play.
    this.applyTransport();
    if (this.activation?.idx === idx) this.prepare();
    this.onUpdate();
  }

  /**
   * The one case `statusChange` cannot report: a player that was already
   * `readyToPlay` and whose new item loaded without the status ever leaving
   * that value. Runs off the core's pump, so it costs nothing in steady state.
   */
  private reconcileReady(): void {
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      const idx = i as 0 | 1;
      const slot = this.slots[idx];
      if (!slot.loading || slot.loadedAt === null) continue;
      if (now - slot.loadedAt < READY_RECONCILE_MS) continue;
      if (slot.player.status === "readyToPlay") this.markReady(idx);
    }
  }

  private onTimeUpdate(idx: 0 | 1, currentTime: number): void {
    if (this.destroyed || idx !== this.activeIdx) return;
    const slot = this.slots[idx];
    if (!slot.seg) return;
    this.lastPos = this.segPos(slot.seg) + currentTime;
    if (!this.wantPlay) return;

    const remainS = this.endOf(slot) - currentTime;
    if (this.activation) {
      // The outgoing segment has played out: release the lead-in. THIS is the
      // moment that keeps the playhead continuous across the seam — releasing
      // at the lead instead would silently drop half a second per boundary.
      if (remainS <= BOUNDARY_EPSILON_S) this.releaseBoundary("reached the boundary");
      return;
    }
    if (remainS > BOUNDARY_LEAD_S) return;
    const next = this.contiguousNext(slot.seg);
    if (next) this.activate(next, 0, true);
  }

  private onPlayToEnd(idx: 0 | 1): void {
    if (this.destroyed || idx !== this.activeIdx || !this.wantPlay) return;
    this.releaseBoundary("playToEnd");
  }

  /**
   * The outgoing segment is finished, however we found out. With a lead-in
   * already prepared this swaps; without one — the file ran out well before
   * the manifest said it would, which `fstat`-anchored rows do — it starts
   * the next segment now rather than leave the clock on a player that will
   * never advance again.
   */
  private releaseBoundary(reason: string): void {
    if (this.destroyed || !this.wantPlay) return;
    const slot = this.slots[this.activeIdx];
    if (!slot.seg) return;
    const next = this.contiguousNext(slot.seg);
    if (!next) return;
    this.debug(`release (${reason}) seq ${slot.seg.seq} → ${next.seq} · ${this.snapshot()}`);
    const pending = this.activation;
    if (pending) {
      if (!sameSeg(pending.seg, next) || pending.released) return;
      pending.released = true;
      this.maybePromote();
      return;
    }
    this.activate(next, 0, false);
  }

  /**
   * Where this player's segment really ends, in its own seconds: the manifest
   * duration, or the file's if the file is shorter. A file that outruns the
   * manifest must be cut at the manifest (its tail is the next segment's wall
   * clock); a file that falls short can only be played to its own end, and
   * waiting for a boundary it can never reach is what freezes a lane.
   */
  private endOf(slot: Slot): number {
    const manifestEnd = slot.seg ? slot.seg.effectiveDurationMs / 1000 : 0;
    const fileEnd = slot.player.duration;
    return fileEnd > 0 ? Math.min(manifestEnd, fileEnd) : manifestEnd;
  }

  private contiguousNext(seg: ReplaySegment): ReplaySegment | null {
    const end = segmentEnd(seg);
    const next = nextSegmentAfter(this.timeline, end);
    if (!next) return null;
    return Math.abs(next.startTs - end) <= CONTIGUOUS_MS ? next : null;
  }

  private onStatusChange(idx: 0 | 1, status: VideoPlayerStatus, message: string | null): void {
    if (this.destroyed) return;
    const slot = this.slots[idx];
    if (status === "readyToPlay") {
      if (!slot.ready) this.markReady(idx);
      else if (idx === this.activeIdx) this.onUpdate();
      return;
    }
    if (status === "error") {
      slot.ready = false;
      slot.loading = false;
      if (slot.seg) this.onLoadFailure(slot.seg, message === null ? null : new Error(message));
      return;
    }
    if (status === "loading" && idx === this.activeIdx && slot.ready && this.wantPlay) {
      // A buffer underrun on the player that is on screen. The core's stall
      // recovery reads `buffered()` and decides whether to jump or wait.
      for (const cb of this.waitingCbs) cb();
    }
  }

  /**
   * A native player reports that a source would not load, and never why: the
   * HTTP status is not on the error. A one-byte ranged GET against the same
   * presigned URL is the cheapest way to tell an expired signature (403 —
   * refresh the manifest, exactly as the browser engine does) from a network
   * blip (retry), and it only ever runs on a failure.
   */
  private onLoadFailure(seg: ReplaySegment, err: unknown): void {
    this.failedAt.set(seg.startTs, Date.now());
    console.warn(
      `replay segment ${seg.seq} failed to load`,
      err instanceof Error ? err.message : err,
    );
    if (this.probing.has(seg.startTs)) return;
    this.probing.add(seg.startTs);
    void (async () => {
      try {
        const res = await fetch(this.getUrl(seg), {
          headers: { Range: "bytes=0-0" },
          signal: this.abort.signal,
        });
        if (this.destroyed) return;
        if (res.status === 403) this.onAuthError?.();
        else if (res.status === 404 || res.status === 410) {
          this.onError(`Recorded video segment ${seg.seq} is no longer available.`);
        }
      } catch {
        /* offline or aborted: `ensureAt` retries after the backoff window */
      } finally {
        this.probing.delete(seg.startTs);
      }
    })();
  }
}

/** Segment identity within a lane is `startTs`: `seq` restarts per session. */
function sameSeg(a: ReplaySegment | null, b: ReplaySegment | null): boolean {
  return a !== null && b !== null && a.startTs === b.startTs;
}
