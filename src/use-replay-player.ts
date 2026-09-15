import { useCallback, useEffect, useRef, useState } from "react";
import {
  useReplayPlayerCore,
  type ReplayManifest,
  type StreamKey,
  type UseReplayPlayerCore,
  type UseReplayPlayerOptions,
} from "@xorgate/react";
import { createVideoPlayer, type VideoPlayer } from "expo-video";
import { ExpoVideoReplayEngine } from "./replay-engine.js";

export type {
  ReplayLaneState,
  ReplayLaneStatus,
  UseReplayPlayerOptions,
} from "@xorgate/react";

/** A lane's two players, and which one is showing. */
export interface ReplayLaneMedia {
  /**
   * Both players. Render BOTH views — the hidden one is where the next
   * segment is already loaded, and mounting it is what makes a boundary an
   * opacity flip instead of a reload. Two mounted views cost nothing visible
   * (SPIKES.md §4).
   */
  players: readonly [VideoPlayer, VideoPlayer];
  /** The index in `players` whose picture belongs on screen. */
  activeIndex: 0 | 1;
}

export interface UseReplayPlayer extends UseReplayPlayerCore {
  /**
   * The player currently showing this lane. Null before the manifest arrives
   * or for a `streamKey` the replay has no lane for. This is the one-view
   * shortcut; `ReplayVideo` uses {@link UseReplayPlayer.laneMedia} instead,
   * because a single view cannot hold the outgoing picture across a seam.
   */
  lanePlayer: (streamKey: StreamKey) => VideoPlayer | null;
  /** Both of a lane's players and which is in front. What `ReplayVideo` renders. */
  laneMedia: (streamKey: StreamKey) => ReplayLaneMedia | null;
}

export interface UseReplayPlayerNativeOptions extends UseReplayPlayerOptions {
  /**
   * How a lane's players are made. Defaults to `expo-video`'s
   * `createVideoPlayer`; a test supplies its own.
   */
  createPlayer?: () => VideoPlayer;
  /**
   * Every decision each lane's engine makes, prefixed with its `streamKey`.
   * Off by default and free when unset. A seam is tens of milliseconds wide
   * and the native player is the half you cannot step through, so this is how
   * you find out why a boundary did or did not happen.
   */
  debug?: (message: string) => void;
}

/**
 * The headless replay player on React Native: the clock and lane logic of
 * `@xorgate/react`'s `useReplayPlayerCore`, with each lane's media driven by
 * two `expo-video` players instead of one `<video>` over MSE.
 *
 * Where the browser wrapper hands out a `laneVideoRef` and waits for an
 * element to attach, this hook owns the media itself: a phone player needs no
 * view to load or decode, so a lane starts as soon as the manifest describes
 * it and a `VideoView` is only a window onto it. That also means the players
 * outlive any one render of a tile, which is what lets a tile be unmounted
 * and remounted (a tab change, a rotation) without re-downloading a segment.
 *
 * The pair per lane is created lazily and released when the lane disappears or
 * the hook unmounts — `createVideoPlayer` is manual memory, unlike
 * `useVideoPlayer`, and nothing else in the tree knows to free it.
 */
export function useReplayPlayer(
  manifest: ReplayManifest | null | undefined,
  options: UseReplayPlayerNativeOptions = {},
): UseReplayPlayer {
  const { createPlayer, debug, ...coreOptions } = options;
  const core = useReplayPlayerCore(manifest, coreOptions);
  const { lanes, attachLane } = core;

  const createPlayerRef = useRef(createPlayer);
  createPlayerRef.current = createPlayer;
  const debugRef = useRef(debug);
  debugRef.current = debug;

  const pool = useRef(new Map<string, readonly [VideoPlayer, VideoPlayer]>());
  const engines = useRef(new Map<string, ExpoVideoReplayEngine>());
  // Bumped when a lane's front player changes, so the views re-render and the
  // opacity follows. Not state per lane: one counter re-renders the consumer
  // once, whichever lane swapped.
  const [, bumpActive] = useState(0);

  // A string, not the array: `lanes` is a new array identity on every manifest
  // refresh (the presigned URLs change), and re-running this effect would
  // rebuild the players under a playing lane.
  const laneKeys = lanes.map((lane) => lane.streamKey).join("\u0000");

  useEffect(() => {
    const keys = laneKeys === "" ? [] : laneKeys.split("\u0000");
    // Release the players of a lane this replay no longer has.
    for (const [key, players] of [...pool.current]) {
      if (keys.includes(key)) continue;
      for (const player of players) player.release();
      pool.current.delete(key);
      engines.current.delete(key);
    }

    const detachers = keys.map((streamKey) => {
      let players = pool.current.get(streamKey);
      if (!players) {
        const make = createPlayerRef.current ?? (() => createVideoPlayer(null));
        players = [make(), make()] as const;
        pool.current.set(streamKey, players);
      }
      const pair = players;
      return attachLane(streamKey, (engineOptions) => {
        const engine = new ExpoVideoReplayEngine({
          ...engineOptions,
          players: pair,
          onActivePlayerChange: () => bumpActive((v) => v + 1),
          ...(debugRef.current
            ? { onDebug: (message: string) => debugRef.current?.(`${streamKey}: ${message}`) }
            : {}),
        });
        engines.current.set(streamKey, engine);
        return engine;
      });
    });
    return () => {
      for (const detach of detachers) detach();
    };
  }, [laneKeys, attachLane]);

  // Unmount: the pool is manual memory and nothing else frees it.
  useEffect(() => {
    const players = pool.current;
    const lanEngines = engines.current;
    return () => {
      // Engines first, players second, and explicitly rather than by trusting
      // React's cleanup order: a `release()`d player throws on every access,
      // so an engine torn down after its pair would throw into the tree.
      for (const engine of lanEngines.values()) engine.destroy();
      for (const pair of players.values()) {
        for (const player of pair) player.release();
      }
      players.clear();
      lanEngines.clear();
    };
  }, []);

  const laneMedia = useCallback((streamKey: StreamKey): ReplayLaneMedia | null => {
    const players = pool.current.get(streamKey);
    if (!players) return null;
    // The pool is the stable half: an engine can be torn down and rebuilt by
    // the core (a new replay) while the same two players carry on.
    return { players, activeIndex: engines.current.get(streamKey)?.activeIndex ?? 0 };
  }, []);

  const lanePlayer = useCallback(
    (streamKey: StreamKey): VideoPlayer | null => {
      const media = laneMedia(streamKey);
      return media ? media.players[media.activeIndex] : null;
    },
    [laneMedia],
  );

  return { ...core, lanePlayer, laneMedia };
}
