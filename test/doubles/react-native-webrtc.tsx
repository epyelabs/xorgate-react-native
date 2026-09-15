/**
 * react-native-webrtc as plain React. `RTCView` records the props the real
 * renderer would act on (which stream, how visible) and keeps the first-frame
 * callback reachable — that callback is the signal `LiveVideo`'s reconnect
 * hold turns on, so a test has to be able to fire it.
 */
import { createElement, useEffect, useRef, type ReactNode } from "react";

export class RTCPeerConnection {
  config: unknown;
  constructor(config?: unknown) {
    this.config = config;
  }
}

export class MediaStream {
  constructor(public readonly id: string) {}
  toURL(): string {
    return `url:${this.id}`;
  }
}

export interface RTCVideoViewProps {
  streamURL?: string;
  objectFit?: "contain" | "cover";
  zOrder?: number;
  mirror?: boolean;
  style?: unknown;
  onDimensionsChange?: (event: { nativeEvent: { width: number; height: number } }) => void;
}

interface Record {
  props: RTCVideoViewProps;
  opacity: number;
}

/**
 * Registered on COMMIT and keyed by object identity, not by stream url and
 * not during render. Two reasons, both learned here: during a reconnect two
 * views briefly carry the same url — one retiring, one warming up — so a url
 * key makes the retiring view's unmount delete the survivor; and React may
 * render a component more than once before committing, so registering in the
 * render body leaves a phantom entry that never unmounts.
 */
const live = new Set<Record>();

export function resetRtcViews(): void {
  live.clear();
}

/**
 * The views mounted right now, in mount order. The suite reads this rather
 * than the DOM: the package compiles without the DOM lib on purpose, so a test
 * that reached for `querySelectorAll` would not typecheck.
 */
export function mountedRtcViews(): Array<{ streamURL: string | undefined; opacity: number }> {
  return [...live].map((entry) => ({
    streamURL: entry.props.streamURL,
    opacity: entry.opacity,
  }));
}

/** The props the view for `streamURL` last rendered with. */
export function rtcViewProps(streamURL: string): RTCVideoViewProps | undefined {
  return [...live].find((entry) => entry.props.streamURL === streamURL)?.props;
}

/** The renderer reports the video's size: the package reads this as "first frame". */
export function fireDimensions(streamURL: string, width = 1280, height = 720): void {
  const props = rtcViewProps(streamURL);
  if (!props) throw new Error(`no RTCView is rendering ${streamURL}`);
  props.onDimensionsChange?.({ nativeEvent: { width, height } });
}

export function RTCView(props: RTCVideoViewProps): ReactNode {
  const flat = Array.isArray(props.style) ? Object.assign({}, ...props.style) : props.style;
  const opacity = (flat as { opacity?: number } | undefined)?.opacity ?? 1;

  const entry = useRef<Record>({ props, opacity });
  entry.current.props = props;
  entry.current.opacity = opacity;

  useEffect(() => {
    const record = entry.current;
    live.add(record);
    return () => {
      live.delete(record);
    };
  }, []);

  return createElement("div", null);
}
