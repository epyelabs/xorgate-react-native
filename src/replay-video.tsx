import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
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
 */
export function ReplayVideo(props: ReplayVideoProps): ReactNode {
  const { player, streamKey, contentFit = "contain", style, ...viewProps } = props;
  const media = player.laneMedia(streamKey);

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
