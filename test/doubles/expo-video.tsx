/**
 * expo-video as a plain object with the same surface the engine drives, plus
 * the handles a test needs to play the native side's part: resolve a load,
 * announce `readyToPlay`, emit a `timeUpdate`, run a file off its end.
 *
 * It is not a simulation of AVPlayer. What it can prove is the wiring and the
 * ORDER of it — which player a segment is loaded onto, that nothing is
 * trusted before the status event, that the front view only changes at the
 * manifest boundary — and that is exactly the part of this package that is not
 * somebody else's already tested code. Decoding, seeking cost and the real
 * seam belong to the simulator, and are recorded in the plan.
 */
import { createElement, type ReactNode } from "react";
// Resolved by tsc against the REAL package (the alias in vitest.config.ts is a
// runtime rule only), and erased, so there is no cycle back into this file.
import type { VideoPlayer as NativeVideoPlayer } from "expo-video";

export type VideoPlayerStatus = "idle" | "loading" | "readyToPlay" | "error";
export type VideoSource = { uri: string } | string | number | null;
export type VideoContentFit = "contain" | "cover" | "fill";

type Listener = (payload: never) => void;

export class FakeVideoPlayer {
  status: VideoPlayerStatus = "idle";
  currentTime = 0;
  bufferedPosition = 0;
  playing = false;
  playbackRate = 1;
  muted = false;
  loop = true;
  timeUpdateEventInterval = 0;
  released = false;

  /** Every source this player was handed, in order. */
  readonly loads: VideoSource[] = [];
  /** Resolvers for loads a test chose to keep pending. */
  private pending: Array<() => void> = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  /** `play()` / `pause()` calls, in order, for transport assertions. */
  readonly transport: string[] = [];

  /** Hold the next `replaceAsync` open until `settleLoad()`. */
  deferLoads = false;

  addListener(event: string, listener: Listener): { remove(): void } {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return {
      remove: () => {
        set.delete(listener);
      },
    };
  }

  play(): void {
    this.playing = true;
    this.transport.push("play");
  }

  pause(): void {
    this.playing = false;
    this.transport.push("pause");
  }

  replaceAsync(source: VideoSource): Promise<void> {
    this.loads.push(source);
    this.status = source === null ? "idle" : "loading";
    this.currentTime = 0;
    this.bufferedPosition = 0;
    if (!this.deferLoads) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
  }

  release(): void {
    this.released = true;
  }

  // --- test controls -------------------------------------------------------

  /** Resolve every deferred `replaceAsync`. */
  settleLoad(): void {
    const waiting = this.pending;
    this.pending = [];
    for (const resolve of waiting) resolve();
  }

  /** The native side says the item is playable. */
  becomeReady(bufferedPosition = 60): void {
    this.bufferedPosition = bufferedPosition;
    this.emitStatus("readyToPlay");
  }

  emitStatus(status: VideoPlayerStatus, errorMessage?: string): void {
    this.status = status;
    this.emit("statusChange", {
      status,
      ...(errorMessage === undefined ? {} : { error: { message: errorMessage } }),
    });
  }

  /** Advance the playhead and tell the engine about it. */
  emitTime(currentTime: number): void {
    this.currentTime = currentTime;
    this.emit("timeUpdate", { currentTime, bufferedPosition: this.bufferedPosition });
  }

  emitPlayToEnd(): void {
    this.emit("playToEnd", {});
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /** The `uri` of the last non-null source, for readable assertions. */
  get loadedUri(): string | null {
    for (let i = this.loads.length - 1; i >= 0; i--) {
      const source = this.loads[i];
      if (source && typeof source === "object") return source.uri;
    }
    return null;
  }

  private emit(event: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      (listener as (p: unknown) => void)(payload);
    }
  }
}

/** Every player this module has made, so a test can assert the pool. */
export const createdPlayers: FakeVideoPlayer[] = [];

export function createVideoPlayer(_source?: VideoSource): FakeVideoPlayer {
  const player = new FakeVideoPlayer();
  createdPlayers.push(player);
  return player;
}

export function resetVideoPlayers(): void {
  createdPlayers.length = 0;
  mountedViews.length = 0;
}

interface MountedView {
  player: FakeVideoPlayer;
  opacity: number;
  nativeControls: boolean | undefined;
  contentFit: VideoContentFit | undefined;
}

const mountedViews: MountedView[] = [];

/** The views currently rendered, in tree order. */
export function mountedVideoViews(): MountedView[] {
  return mountedViews;
}

export function VideoView(props: {
  player: FakeVideoPlayer;
  style?: unknown;
  contentFit?: VideoContentFit;
  nativeControls?: boolean;
}): ReactNode {
  const flat = Array.isArray(props.style)
    ? Object.assign({}, ...(props.style as object[]))
    : props.style;
  const opacity = (flat as { opacity?: number } | undefined)?.opacity ?? 1;
  const index = mountedViews.findIndex((view) => view.player === props.player);
  const record: MountedView = {
    player: props.player,
    opacity,
    nativeControls: props.nativeControls,
    contentFit: props.contentFit,
  };
  if (index === -1) mountedViews.push(record);
  else mountedViews[index] = record;
  return createElement("div", null);
}

export type VideoPlayer = FakeVideoPlayer;

/**
 * The double where the package's signatures ask for the real class. Only the
 * members the engine actually touches exist on it; a reach for anything else
 * would be a test failure rather than a silent pass, which is the point.
 */
export function asNative(player: FakeVideoPlayer): NativeVideoPlayer {
  return player as unknown as NativeVideoPlayer;
}
