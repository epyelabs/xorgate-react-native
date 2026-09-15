import { useCallback, useEffect, useState } from "react";
import { useLiveVideoSession } from "@xorgate/react";
import type {
  LiveUnavailableReason,
  LiveVideoStats,
  LiveVideoStatus,
  UseLiveVideoSessionOptions,
  VideoChannel,
  XorgateError,
} from "@xorgate/react";
import type { MediaStream } from "react-native-webrtc";

export type { LiveVideoStatus, LiveVideoStats } from "@xorgate/react";

export interface UseLiveVideo {
  /**
   * The received remote stream, or null while idle. A reconnect delivers a
   * NEW stream object: the previous one is dead, not resumable.
   */
  stream: MediaStream | null;
  /** `stream.toURL()`, the only thing `RTCView` takes. Null while idle. */
  streamURL: string | null;
  status: LiveVideoStatus;
  unavailableReason: LiveUnavailableReason | null;
  error: XorgateError | null;
  /** Null until the first sample lands. Reset to null on every reconnect. */
  stats: LiveVideoStats | null;
}

export type UseLiveVideoOptions = Omit<UseLiveVideoSessionOptions, "onStream">;

/**
 * Run a KVS WebRTC VIEWER for one signaling channel and hand back the
 * received stream for an `RTCView`. Pass `null` to stay idle.
 *
 * This is the React Native wrapper over `@xorgate/react`'s
 * `useLiveVideoSession`: the session itself — generation counter, per-step and
 * whole-attempt deadlines, the disconnect grace, backoff, the ~50 minute
 * credential cycle, the wake nudge — is the same code the web app runs, and it
 * was earned against real LTE devices. What differs on a phone is the
 * platform underneath it (`nativePlatform()`) and the fact that the picture
 * goes to a native view instead of an element.
 *
 * Unlike the browser, where a reconnect leaves the last frame in the `<video>`
 * element, `streamURL` changes on every reconnect and an `RTCView` handed a
 * new URL has nothing to show until the first frame decodes. `LiveVideo`
 * holds the outgoing picture across that swap; if you render `RTCView`
 * yourself and care, do the same.
 */
export function useLiveVideo(
  channel: VideoChannel | null,
  options: UseLiveVideoOptions = {},
): UseLiveVideo {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [streamURL, setStreamURL] = useState<string | null>(null);

  const onStream = useCallback((next: unknown) => {
    const ms = next as MediaStream;
    setStream(ms);
    setStreamURL(ms.toURL());
  }, []);

  const session = useLiveVideoSession(channel, {
    onStream,
    ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
    ...(options.statsIntervalMs !== undefined
      ? { statsIntervalMs: options.statsIntervalMs }
      : {}),
  });

  // Drop the stream when the session goes away (channel change, disable,
  // unmount) — never on a reconnect, which replaces it through `onStream`.
  const active = channel !== null && options.enabled !== false;
  useEffect(() => {
    if (!active) return;
    return () => {
      setStream(null);
      setStreamURL(null);
    };
  }, [active, channel?.channelRef, channel?.region]);

  return { stream, streamURL, ...session };
}
