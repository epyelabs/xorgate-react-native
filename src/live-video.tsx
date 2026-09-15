import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { ViewProps } from "react-native";
import { RTCView } from "react-native-webrtc";
import type { RTCVideoViewProps } from "react-native-webrtc";
import type { VideoChannel, XorgateError } from "@xorgate/react";
import { useLiveVideo } from "./use-live-video.js";
import type {
  LiveVideoStats,
  LiveVideoStatus,
  UseLiveVideoOptions,
} from "./use-live-video.js";

/** How long to keep the outgoing picture if the incoming stream never reports a frame. */
const HOLD_TIMEOUT_MS = 3000;

export interface LiveVideoProps extends Omit<ViewProps, "children"> {
  channel: VideoChannel | null;
  options?: UseLiveVideoOptions;
  /** Defaults to "cover", matching the web component's object-fit. */
  objectFit?: RTCVideoViewProps["objectFit"];
  zOrder?: RTCVideoViewProps["zOrder"];
  mirror?: RTCVideoViewProps["mirror"];
  /** Called on every transition. The component renders no status chrome of its own. */
  onStatusChange?: (status: LiveVideoStatus, error: XorgateError | null) => void;
  /** Each inbound-rtp sample, for a stats row. Null between sessions. */
  onStats?: (stats: LiveVideoStats | null) => void;
  /** The encoded size of the picture on screen, as the renderer reports it. */
  onVideoDimensions?: (dimensions: { width: number; height: number }) => void;
  /**
   * The stream actually ON SCREEN, which during a reconnect lags the session's
   * by the length of the hold below. Null while nothing is displayed.
   */
  onDisplayedStreamChange?: (streamURL: string | null) => void;
}

/**
 * `useLiveVideo` plus the native video view, and nothing else: no card, no
 * spinner, no status text, no aspect ratio. It exists so the 90% case is one
 * line, not so it can be your player — the web `LiveVideo` makes the same
 * promise.
 *
 * What it does add over a bare `RTCView` is the reconnect hold. Every
 * reconnect produces a new `MediaStream` with a new `streamURL`, and an
 * `RTCView` pointed at a stream that has not decoded a frame yet is black —
 * so a 2 s blip on a phone would blank the picture, where the browser's
 * `<video>` simply keeps its last frame. Here the new stream is mounted
 * underneath at zero opacity and only promoted once the renderer reports its
 * dimensions, which is the first-frame signal; until then the outgoing view
 * stays on screen. If the new stream never produces a frame the swap happens
 * anyway after {@link HOLD_TIMEOUT_MS}, so a dead stream cannot pin a stale
 * frame forever.
 */
export function LiveVideo(props: LiveVideoProps): ReactNode {
  const {
    channel,
    options,
    objectFit = "cover",
    zOrder,
    mirror,
    onStatusChange,
    onStats,
    onVideoDimensions,
    onDisplayedStreamChange,
    style,
    ...viewProps
  } = props;

  const { streamURL, status, error, stats } = useLiveVideo(channel, options);

  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  useEffect(() => {
    onStatusChangeRef.current?.(status, error);
  }, [status, error]);

  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  useEffect(() => {
    onStatsRef.current?.(stats);
  }, [stats]);

  const onVideoDimensionsRef = useRef(onVideoDimensions);
  onVideoDimensionsRef.current = onVideoDimensions;

  // `shown` is the picture on screen; `incoming` is a newer stream warming up
  // behind it. A first stream goes straight to `shown` — there is nothing to
  // hold on to and no reason to make the viewer wait.
  const [shown, setShown] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<string | null>(null);

  useEffect(() => {
    if (streamURL === null) {
      setShown(null);
      setIncoming(null);
      return;
    }
    setShown((current) => {
      if (current === null) return streamURL;
      if (current !== streamURL) setIncoming(streamURL);
      return current;
    });
  }, [streamURL]);

  useEffect(() => {
    if (incoming === null) return;
    const timer = setTimeout(() => {
      setShown(incoming);
      setIncoming(null);
    }, HOLD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [incoming]);

  const promote = (url: string) => {
    setShown(url);
    setIncoming((current) => (current === url ? null : current));
  };

  const onDisplayedStreamChangeRef = useRef(onDisplayedStreamChange);
  onDisplayedStreamChangeRef.current = onDisplayedStreamChange;
  useEffect(() => {
    onDisplayedStreamChangeRef.current?.(shown);
  }, [shown]);

  return (
    <View style={style} {...viewProps}>
      {shown !== null && (
        <RTCView
          streamURL={shown}
          objectFit={objectFit}
          {...(zOrder !== undefined ? { zOrder } : {})}
          {...(mirror !== undefined ? { mirror } : {})}
          style={StyleSheet.absoluteFill}
          onDimensionsChange={(event) => onVideoDimensionsRef.current?.(event.nativeEvent)}
        />
      )}
      {incoming !== null && (
        <RTCView
          streamURL={incoming}
          objectFit={objectFit}
          {...(zOrder !== undefined ? { zOrder } : {})}
          {...(mirror !== undefined ? { mirror } : {})}
          style={[StyleSheet.absoluteFill, styles.warming]}
          onDimensionsChange={() => promote(incoming)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Mounted so the renderer decodes, invisible so the outgoing frame stands.
  warming: { opacity: 0 },
});
