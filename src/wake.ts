import { AppState } from "react-native";

/** `XorgatePlatform["subscribeWake"]`: call `onWake`, get an unsubscribe back. */
export type WakeSource = (onWake: () => void) => () => void;

/**
 * The foreground edge. This is the wake source a phone actually needs: iOS
 * suspends the app's sockets within seconds of it leaving the screen, so both
 * the MQTT connection and the peer connection are usually dead by the time the
 * user comes back — and the live plane would otherwise sit out a backoff of up
 * to 30 s in front of them. A browser tab has the same problem in miniature;
 * `visibilitychange` is the web's version of this listener.
 *
 * Only the `active` edge counts. "inactive" is the app switcher or a system
 * sheet over the app, where nothing has been torn down yet.
 */
export function appStateWake(onWake: () => void): () => void {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") onWake();
  });
  return () => subscription.remove();
}

/**
 * Fan one `onWake` out over several sources. Used to add "the network came
 * back" to the foreground edge; see the README for the expo-network and
 * NetInfo recipes, which are four lines each and stay in the consumer so this
 * package needs neither as a dependency.
 *
 * A wake is a hint, never a command: the feeds and the video session ignore
 * one while they are connected or mid-connect, so firing twice costs nothing.
 */
export function composeWake(...sources: WakeSource[]): WakeSource {
  return (onWake) => {
    const unsubscribes = sources.map((source) => source(onWake));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  };
}
