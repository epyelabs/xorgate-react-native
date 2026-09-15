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
 * `randomUUID`, not `getRandomValues`, not `subtle`. `nativePlatform()` covers
 * the SDK's own need (client ids) through the `randomId` slot, so this import
 * is not what makes telemetry or video work. It is here for the layer
 * underneath: the AWS SDK and its signers reach for `crypto.getRandomValues`
 * on some paths, and so does almost any library that generates an id.
 *
 * It is an additive polyfill — an existing `crypto` keeps every function it
 * already has — and it is a separate entry point so the main entry never
 * pulls expo-crypto. A bare React Native app without expo-crypto installed
 * uses `react-native-get-random-values` and passes `randomId` instead.
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
