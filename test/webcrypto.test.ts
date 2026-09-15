import { createHmac, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { subtle } from "../src/webcrypto.js";

/**
 * The three calls the KVS signaling client's SigV4 signer makes, checked
 * against Node's own crypto. A wrong answer here is not a crash: it is a
 * signature AWS rejects with a 403 that looks like an expired credential.
 */

const hex = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("hex");
const bytes = (text: string) => new TextEncoder().encode(text);

describe("the WebCrypto subset", () => {
  it("digests SHA-256 exactly as Node does", async () => {
    const digest = await subtle.digest({ name: "SHA-256" }, bytes("AWS4-HMAC-SHA256"));
    expect(hex(digest)).toBe(createHash("sha256").update("AWS4-HMAC-SHA256").digest("hex"));
  });

  it("accepts the algorithm as a bare string too", async () => {
    const digest = await subtle.digest("sha-256", bytes(""));
    expect(hex(digest)).toBe(createHash("sha256").update("").digest("hex"));
  });

  it("signs HMAC-SHA256 exactly as Node does", async () => {
    const secret = bytes("AWS4wJalrXUtnFEMI");
    const key = await subtle.importKey("raw", secret, { name: "HMAC" }, false, ["sign"]);
    const signature = await subtle.sign({ name: "HMAC" }, key, bytes("20260915"));
    expect(hex(signature)).toBe(
      createHmac("sha256", Buffer.from(secret)).update("20260915").digest("hex"),
    );
  });

  it("chains the four SigV4 signing keys correctly", async () => {
    // date -> region -> service -> "aws4_request", each key signing the next.
    let key = await subtle.importKey("raw", bytes("AWS4secret"), { name: "HMAC" }, false, ["sign"]);
    let signature: ArrayBuffer = new ArrayBuffer(0);
    for (const step of ["20260915", "us-east-1", "iotdevicegateway", "aws4_request"]) {
      signature = await subtle.sign({ name: "HMAC" }, key, bytes(step));
      key = await subtle.importKey("raw", signature, { name: "HMAC" }, false, ["sign"]);
    }

    let expected = Buffer.from("AWS4secret");
    for (const step of ["20260915", "us-east-1", "iotdevicegateway", "aws4_request"]) {
      expected = createHmac("sha256", expected).update(step).digest();
    }
    expect(hex(signature)).toBe(expected.toString("hex"));
  });

  it("copies the key material, so a reused caller buffer cannot corrupt it", async () => {
    const buffer = bytes("AWS4secret");
    const key = await subtle.importKey("raw", buffer, { name: "HMAC" }, false, ["sign"]);
    buffer.fill(0);
    const signature = await subtle.sign({ name: "HMAC" }, key, bytes("x"));
    expect(hex(signature)).toBe(
      createHmac("sha256", Buffer.from("AWS4secret")).update("x").digest("hex"),
    );
  });

  it("refuses anything outside the signer's three calls, by name", async () => {
    await expect(subtle.digest({ name: "SHA-512" }, bytes("x"))).rejects.toThrow(/SHA-512/);
    await expect(
      subtle.importKey("jwk", bytes("x"), { name: "HMAC" }, false, ["sign"]),
    ).rejects.toThrow(/jwk/);
    await expect(
      subtle.importKey("raw", bytes("x"), { name: "AES-GCM" }, false, ["encrypt"]),
    ).rejects.toThrow(/AES-GCM/);
  });
});
