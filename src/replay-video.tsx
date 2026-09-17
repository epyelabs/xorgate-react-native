import type { ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import type { ViewProps } from "react-native";
import { VideoView } from "expo-video";
import type { VideoContentFit } from "expo-video";
import type { StreamKey } from "@xorgate/react";
import type { UseReplayPlayer } from "./use-replay-player.js";

export interface ReplayVideoProps extends Omit<ViewProps, "children"> {
  player: UseReplayPlayer;
  streamKey: StreamKey;
  /** Defaults to "contain", matching the web component's object-fit. */
  contentFit?: VideoContentFit;
}

/**
 * One replay lane's picture, and nothing else: no transport bar, no scrubber,
 * no gap overlay, no loading state. Same minimalism as `LiveVideo` and as the
 * web `ReplayVideo` — read `player.laneState(streamKey)` and render those
 * yourself.
 *
 * What it does that a single `VideoView` cannot is hold BOTH of the lane's
 * players mounted, the hidden one already loaded with the next segment. The
 * boundary is then an opacity flip between two live views rather than a
 * source change on one, which is the whole of why the seam is a picture
 * change instead of a reload. `nativeControls` is off: the clock owns the
 * transport, and a native scrubber would drive one segment's file rather than
 * the replay.
 *
 * On Android the two views are `TextureView`s rather than the default
 * `SurfaceView`s, and that is load-bearing — see {@link ANDROID_SURFACE}.
 */
/**
 * What the lane's two views are rendered INTO on Android, and the one thing
 * about this component that is not cosmetic.
 *
 * The seam is an opacity flip between two overlapping views, and `expo-video`
 * draws into a `SurfaceView` by default. A `SurfaceView`'s picture is not
 * drawn by the view hierarchy at all — it is a separate layer the system
 * composites — so `opacity: 0` does not hide it and `zIndex` does not order it
 * against a sibling surface. Two stacked lanes then fight over the same
 * pixels, and the PRELOAD is the one that wins: the hidden player parks on the
 * first frame of the NEXT segment, that still frame covers the player that is
 * actually running, and the lane freezes for a whole segment while the clock,
 * the map and the readouts carry on. Measured on an API 36 emulator before
 * this line existed: 11 distinct frames in three minutes, each freeze starting
 * within a second and a half of the hidden player reporting ready — and the
 * LAST segment of a replay playing normally, because by then there is nothing
 * left to preload on top of it.
 *
 * A `TextureView` is an ordinary view in the hierarchy, so alpha and z-order
 * mean what they say. It costs a GPU copy per frame and cannot show
 * DRM-protected media; a recorded lane is neither hot nor protected. iOS has
 * no such split — `AVPlayerLayer` is a real layer — and the prop is Android's
 * alone, so it is spread in rather than passed at all elsewhere.
 */
const ANDROID_SURFACE = { surfaceType: "textureView" } as const;

export function ReplayVideo(props: ReplayVideoProps): ReactNode {
  const { player, streamKey, contentFit = "contain", style, ...viewProps } = props;
  const media = player.laneMedia(streamKey);
  // Read per render rather than once at module load: it costs nothing, and a
  // constant frozen at import time cannot be asserted from the other platform.
  const surface = Platform.OS === "android" ? ANDROID_SURFACE : undefined;

  return (
    <View style={style} {...viewProps}>
      {media?.players.map((lanePlayer, index) => (
        <VideoView
          // Positional and stable: the pair is the same two objects for the
          // life of the lane, and only their order on screen changes.
          key={index}
          player={lanePlayer}
          style={[
            StyleSheet.absoluteFill,
            index === media.activeIndex ? styles.front : styles.behind,
          ]}
          contentFit={contentFit}
          nativeControls={false}
          {...surface}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  front: { opacity: 1, zIndex: 2 },
  // Mounted and decoding, invisible: this is the player holding what comes
  // next, and it is what the seam swaps to.
  behind: { opacity: 0, zIndex: 1 },
});
