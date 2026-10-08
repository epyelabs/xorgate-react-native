/**
 * The disk side of the segment cache, over the in-memory `expo-file-system`
 * double: whole files only, one download per object, nothing a player holds
 * is ever deleted, and nothing outlives a launch or a sign-out.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSegmentCache, SegmentFetchError } from "../src/expo-segment-cache.js";
import { segmentCacheKey } from "../src/segment-cache.js";
import { disk, dirs, downloads, faults, resetFileSystem } from "./doubles/expo-file-system.js";

const DIR = "file:///cache/xorgate-replay-segments";
const URL0 = "https://s3.example/media-sessions/v1/dev/cam0/s1/00000.mp4?X-Amz-Signature=aaa";
const URL1 = "https://s3.example/media-sessions/v1/dev/cam0/s1/00001.mp4?X-Amz-Signature=aaa";
const URL2 = "https://s3.example/media-sessions/v1/dev/cam0/s1/00002.mp4?X-Amz-Signature=aaa";
const MB7 = 7_325_918;

const files = () => [...disk.keys()].filter((p) => p.startsWith(`${DIR}/`)).sort();
const finals = () => files().filter((p) => !p.endsWith(".part"));
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => resetFileSystem());
afterEach(() => resetFileSystem());

function signal(): AbortController {
  return new AbortController();
}

describe("createSegmentCache", () => {
  it("empties what a previous launch left behind", () => {
    dirs.add(DIR);
    disk.set(`${DIR}/stale.mp4`, 123);
    disk.set(`${DIR}/half.mp4.3.part`, 45);
    createSegmentCache();
    expect(files()).toEqual([]);
    expect(dirs.has(DIR)).toBe(true);
  });

  it("downloads into a .part file and serves it only once it is whole", async () => {
    const cache = createSegmentCache();
    const key = segmentCacheKey(URL0);
    const pending = cache.acquire(key, URL0, MB7, signal().signal);
    await tick();

    expect(downloads).toHaveLength(1);
    expect(downloads[0].url).toBe(URL0);
    expect(downloads[0].destination.endsWith(".part")).toBe(true);
    expect(finals()).toEqual([]);

    downloads[0].complete(MB7);
    const uri = await pending;
    expect(uri.startsWith(`${DIR}/`)).toBe(true);
    // AVPlayer infers the container from the extension of a local file.
    expect(uri.endsWith(".mp4")).toBe(true);
    expect(files()).toEqual([uri]);
  });

  it("re-signed URLs for the same object share one file", async () => {
    const cache = createSegmentCache();
    const resigned = URL0.replace("aaa", "bbb");
    expect(segmentCacheKey(resigned)).toBe(segmentCacheKey(URL0));

    const first = cache.acquire(segmentCacheKey(URL0), URL0, MB7, signal().signal);
    await tick();
    downloads[0].complete(MB7);
    const a = await first;
    const b = await cache.acquire(segmentCacheKey(resigned), resigned, MB7, signal().signal);
    expect(b).toBe(a);
    expect(downloads).toHaveLength(1);
  });

  it("two callers for one segment share a single download", async () => {
    const cache = createSegmentCache();
    const key = segmentCacheKey(URL0);
    const a = cache.acquire(key, URL0, MB7, signal().signal);
    const b = cache.acquire(key, URL0, MB7, signal().signal);
    await tick();
    expect(downloads).toHaveLength(1);
    downloads[0].complete(MB7);
    expect(await a).toBe(await b);
  });

  it("refuses a file that arrived short, and leaves nothing behind", async () => {
    const cache = createSegmentCache();
    const pending = cache.acquire(segmentCacheKey(URL0), URL0, MB7, signal().signal);
    await tick();
    downloads[0].complete(MB7 - 1000);
    await expect(pending).rejects.toMatchObject({ name: "SegmentFetchError", status: null });
    expect(files()).toEqual([]);
  });

  it("carries the HTTP status of a refused download", async () => {
    const cache = createSegmentCache();
    const pending = cache.acquire(segmentCacheKey(URL0), URL0, MB7, signal().signal);
    await tick();
    downloads[0].failWithStatus(403);
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SegmentFetchError);
    expect((err as SegmentFetchError).status).toBe(403);
    expect(files()).toEqual([]);
  });

  it("stops the download when its only caller gives up", async () => {
    const cache = createSegmentCache();
    const controller = signal();
    const pending = cache.acquire(segmentCacheKey(URL0), URL0, MB7, controller.signal);
    await tick();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(downloads[0].aborted).toBe(true);
    expect(files()).toEqual([]);
  });

  it("keeps downloading while another caller still wants the file", async () => {
    const cache = createSegmentCache();
    const key = segmentCacheKey(URL0);
    const leaving = signal();
    const a = cache.acquire(key, URL0, MB7, leaving.signal);
    const b = cache.acquire(key, URL0, MB7, signal().signal);
    await tick();
    leaving.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(downloads[0].aborted).toBe(false);
    downloads[0].complete(MB7);
    await expect(b).resolves.toMatch(/\.mp4$/);
  });

  it("a caller arriving in the same tick as the abort keeps the download alive", async () => {
    const cache = createSegmentCache();
    const key = segmentCacheKey(URL0);
    const leaving = signal();
    const a = cache.acquire(key, URL0, MB7, leaving.signal);
    await tick();
    leaving.abort();
    const b = cache.acquire(key, URL0, MB7, signal().signal);
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(downloads).toHaveLength(1);
    expect(downloads[0].aborted).toBe(false);
    downloads[0].complete(MB7);
    await expect(b).resolves.toMatch(/\.mp4$/);
  });

  it("a caller arriving after the download was abandoned starts a fresh one", async () => {
    const cache = createSegmentCache();
    const key = segmentCacheKey(URL0);
    const leaving = signal();
    const a = cache.acquire(key, URL0, MB7, leaving.signal);
    await tick();
    leaving.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(downloads[0].aborted).toBe(true);

    const b = cache.acquire(key, URL0, MB7, signal().signal);
    await tick();
    expect(downloads).toHaveLength(2);
    downloads[1].complete(MB7);
    await expect(b).resolves.toMatch(/\.mp4$/);
    // The abandoned download's cleanup did not take the new file with it.
    expect(finals()).toHaveLength(1);
    expect(files().filter((p) => p.endsWith(".part"))).toEqual([]);
  });

  it("evicts the oldest idle file beyond the cap and never one that is held", async () => {
    const cache = createSegmentCache({ maxEntries: 2 });
    const keys = [URL0, URL1, URL2].map(segmentCacheKey);
    const uris: string[] = [];
    for (const [i, url] of [URL0, URL1, URL2].entries()) {
      const pending = cache.acquire(keys[i], url, MB7, signal().signal);
      await tick();
      downloads[i].complete(MB7);
      uris.push(await pending);
    }
    // All three are held: over the cap, and nothing may go.
    expect(finals()).toHaveLength(3);

    cache.release(keys[1]);
    cache.release(keys[0]);
    // Two idle; the cap needs one gone, and it is the least recently used
    // (segment 1 was released first).
    expect(finals().sort()).toEqual([uris[0], uris[2]].sort());
  });

  it("downloads again when the OS purged the file", async () => {
    const cache = createSegmentCache();
    const key = segmentCacheKey(URL0);
    const first = cache.acquire(key, URL0, MB7, signal().signal);
    await tick();
    downloads[0].complete(MB7);
    const uri = await first;
    cache.release(key);
    disk.delete(uri);

    const again = cache.acquire(key, URL0, MB7, signal().signal);
    await tick();
    expect(downloads).toHaveLength(2);
    downloads[1].complete(MB7);
    await expect(again).resolves.toBe(uri);
  });

  it("clear() aborts downloads and deletes every file", async () => {
    const cache = createSegmentCache();
    const done = cache.acquire(segmentCacheKey(URL0), URL0, MB7, signal().signal);
    await tick();
    downloads[0].complete(MB7);
    await done;
    const inFlight = cache.acquire(segmentCacheKey(URL1), URL1, MB7, signal().signal);
    await tick();

    cache.clear();
    await expect(inFlight).rejects.toMatchObject({ name: "AbortError" });
    expect(downloads[1].aborted).toBe(true);
    expect(files()).toEqual([]);
  });

  it("a folder it cannot prepare fails every acquire, so the engine streams", async () => {
    faults.createThrows = true;
    const cache = createSegmentCache();
    const err = await cache
      .acquire(segmentCacheKey(URL0), URL0, MB7, signal().signal)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SegmentFetchError);
    expect((err as SegmentFetchError).status).toBeNull();
    expect(downloads).toHaveLength(0);
  });
});
