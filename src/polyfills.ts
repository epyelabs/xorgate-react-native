/**
 * `@xorgate/react-native/polyfills` — the one runtime shim React Native needs
 * for the live plane. Import it for its side effect, once, at the very top of
 * your entry file, before anything that reaches the SDK:
 *
 * ```ts
 * import "@xorgate/react-native/polyfills"
 * ```
 *
 * Hermes on Expo SDK 57 has NO `crypto` global — measured, not assumed: not
 * `randomUUID`, not `getRandomValues`, not `subtle`.
 *
 * **Live video does not work without this import**, though not because of
 * this package: `nativePlatform()` covers the SDK's own client ids through
 * the `randomId` slot, and live telemetry runs with no polyfill at all. It is
 * the AWS SDK underneath the KVS viewer. `@smithy/core`'s React Native serde
 * bundle ends its UUID v4 path in `(array) => crypto.getRandomValues(array)`
 * with a BARE `crypto`, and that is the fallback `bindV4` selects precisely
 * when `typeof crypto === "undefined"` — so the guard hands control to the
 * one line that cannot survive the case it guards for (the same bug was fixed
 * for the Node build in smithy-typescript#2022; the native build was not —
 * smithy-typescript#2276). `createNativeWebRtcPlatform` checks for the global
 * at its first AWS call so the message names this import rather than leaving
 * a `ReferenceError` to be retried forever.
 *
 * It is additive — an existing `crypto` keeps every function it already has —
 * and it is a separate entry point so the polyfill is a deliberate line in
 * your entry file rather than a side effect of importing the package.
 *
 * NOTE this is entropy and UUIDs only. `crypto.subtle` is NOT installed: the
 * one place the SDK needs WebCrypto is SigV4 signing inside the KVS signaling
 * client, and that is a Metro resolver rule (`isomorphic-webcrypto`), not a
 * global. See README "Metro setup".
 */
import * as Crypto from "expo-crypto";

interface CryptoGlobal {
  getRandomValues?: unknown;
  randomUUID?: unknown;
}

/** What this module installed, for diagnostics screens. Empty = nothing was missing. */
export const INSTALLED_POLYFILLS: string[] = [];

const g = globalThis as { crypto?: CryptoGlobal };

if (!g.crypto) {
  g.crypto = {
    getRandomValues: Crypto.getRandomValues,
    randomUUID: Crypto.randomUUID,
  };
  INSTALLED_POLYFILLS.push("crypto.getRandomValues", "crypto.randomUUID");
} else {
  if (typeof g.crypto.getRandomValues !== "function") {
    g.crypto.getRandomValues = Crypto.getRandomValues;
    INSTALLED_POLYFILLS.push("crypto.getRandomValues");
  }
  if (typeof g.crypto.randomUUID !== "function") {
    g.crypto.randomUUID = Crypto.randomUUID;
    INSTALLED_POLYFILLS.push("crypto.randomUUID");
  }
}
