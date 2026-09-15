/**
 * `@xorgate/react-native/webcrypto` — the WebCrypto subset the KVS signaling
 * client's SigV4 signer needs, for Metro to alias `isomorphic-webcrypto` at.
 * See README "Metro setup"; it is one line of config and is not imported by
 * anything in this package.
 *
 * Why an alias is needed at all: `amazon-kinesis-video-streams-webrtc` signs
 * its WebSocket URL through `isomorphic-webcrypto`, whose React Native build
 * evaluates to `undefined` on Hermes — its export is assembled behind an
 * msrcrypto PRNG promise, and it also wants `expo-random`, removed from the
 * Expo SDK after 51. The symptom is "Cannot read property 'subtle' of
 * undefined" the first time a viewer connects.
 *
 * Why this is a complete answer rather than a stopgap: the signer makes
 * exactly three calls — `digest(SHA-256)`, `importKey("raw", HMAC)` and
 * `sign(HMAC)` — and all three are deterministic hashing over
 * `@aws-crypto/sha256-js`, which is already in the tree because
 * `presignIotWssUrl` signs with it. The entropy msrcrypto was providing is
 * not used on this path. Anything outside those three calls throws by name
 * instead of returning a wrong answer quietly.
 */
import { Sha256 } from "@aws-crypto/sha256-js";

type Bytes = ArrayBuffer | ArrayBufferView;

function toU8(data: Bytes): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export interface HmacKey {
  type: "secret";
  algorithm: { name: "HMAC"; hash: { name: "SHA-256" } };
  extractable: boolean;
  usages: string[];
  raw: Uint8Array;
}

export const subtle = {
  async digest(algorithm: { name: string } | string, data: Bytes): Promise<ArrayBuffer> {
    const name = typeof algorithm === "string" ? algorithm : algorithm.name;
    if (name.toUpperCase() !== "SHA-256") {
      throw new Error(`@xorgate/react-native/webcrypto: unsupported digest ${name}`);
    }
    const hash = new Sha256();
    hash.update(toU8(data));
    return toArrayBuffer(await hash.digest());
  },

  async importKey(
    format: string,
    keyData: Bytes,
    algorithm: { name: string; hash?: { name: string } | string },
    extractable: boolean,
    usages: string[],
  ): Promise<HmacKey> {
    if (format !== "raw" || algorithm.name.toUpperCase() !== "HMAC") {
      throw new Error(
        `@xorgate/react-native/webcrypto: unsupported importKey ${format}/${algorithm.name}`,
      );
    }
    return {
      type: "secret",
      algorithm: { name: "HMAC", hash: { name: "SHA-256" } },
      extractable,
      usages,
      // Copied: the caller may reuse its buffer for the next signing step.
      raw: toU8(keyData).slice(),
    };
  },

  async sign(_algorithm: { name: string }, key: HmacKey, data: Bytes): Promise<ArrayBuffer> {
    const hash = new Sha256(key.raw);
    hash.update(toU8(data));
    return toArrayBuffer(await hash.digest());
  },
};

const webcrypto = { subtle };
export default webcrypto;
