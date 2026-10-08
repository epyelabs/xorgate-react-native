import { Directory, File, Paths } from "expo-file-system";
import { SegmentFetchError, type ReplaySegmentCache } from "./segment-cache.js";

export type { ReplaySegmentCache } from "./segment-cache.js";
export { SegmentFetchError } from "./segment-cache.js";

export interface SegmentCacheOptions {
  /**
   * How many finished segments to keep on disk once nothing is using them.
   * Default 4: about 30 MB of the recorder's 720p minute, which covers the
   * two a lane holds plus a step back across a boundary. A segment a player
   * still holds is never evicted, so the folder can briefly exceed this.
   */
  maxEntries?: number;
  /** The folder under `Paths.cache`. Default `xorgate-replay-segments`. */
  directoryName?: string;
}

/** The disk side of a segment, while it is arriving and once it is whole. */
interface Entry {
  file: File;
  ready: boolean;
  /** Callers holding the file — a native player may be reading it. */
  refs: number;
  /** Callers still waiting on the download. When this reaches 0, it is aborted. */
  waiting: number;
  lastUsed: number;
  controller: AbortController | null;
  done: Promise<void> | null;
}

/**
 * {@link ReplaySegmentCache} over `expo-file-system`, in the app's own cache
 * folder (`Library/Caches` on iOS).
 *
 * The cache folder because the content is re-downloadable: iOS excludes it from
 * iCloud backup and may purge it under storage pressure, which Apple's data
 * storage guidelines ask of exactly this kind of file. No permission, entitlement
 * or usage string is involved — it is the app's own sandbox — and
 * `expo-file-system` already ships its privacy manifest.
 *
 * - **Whole files only.** A download lands in `<name>.part` and is renamed when
 *   complete (and, when the manifest knows the size, only if it matches), so a
 *   download cut off by a kill or a full disk is never served as a segment.
 * - **One download per segment.** Both of a lane's players, or two lanes, asking
 *   for the same object share it; it is aborted once nobody is waiting.
 * - **Nothing outlives the process.** The folder is emptied the first time the
 *   cache is created in a launch, and {@link ExpoSegmentCache.clear} empties it
 *   on demand (sign-out). Recorded footage is not left on the device.
 */
export class ExpoSegmentCache implements ReplaySegmentCache {
  private readonly dir: Directory;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, Entry>();
  /** Bumped by `clear()`, so a download that finishes afterwards is discarded. */
  private epoch = 0;
  private downloads = 0;
  /** The folder could not be prepared: every acquire fails and the engine streams. */
  private broken: Error | null = null;

  constructor(options: SegmentCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 4);
    this.dir = new Directory(Paths.cache, options.directoryName ?? "xorgate-replay-segments");
    this.reset();
  }

  async acquire(
    key: string,
    url: string,
    expectedBytes: number | null,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw abortError();
    if (this.broken) {
      throw new SegmentFetchError(`segment cache unavailable: ${this.broken.message}`, null);
    }

    let entry = this.entries.get(key);
    if (entry?.ready && !this.isWhole(entry, expectedBytes)) {
      // Purged by the OS, or a different object behind the same key.
      this.drop(key, entry);
      entry = undefined;
    }
    if (entry?.ready) {
      entry.refs++;
      entry.lastUsed = Date.now();
      return entry.file.uri;
    }
    // A download whose last waiter just left is already aborting: start over
    // rather than join it.
    if (!entry || entry.controller?.signal.aborted) entry = this.start(key, url, expectedBytes);

    entry.waiting++;
    const held = entry;
    try {
      await raceAbort(held.done!, signal);
    } catch (err) {
      held.waiting--;
      // The last one out stops the download: nobody is going to play it.
      if (!held.ready && held.waiting === 0) held.controller?.abort();
      throw err;
    }
    held.waiting--;
    held.refs++;
    held.lastUsed = Date.now();
    this.evict();
    return held.file.uri;
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.lastUsed = Date.now();
    this.evict();
  }

  /**
   * Abort every download and delete every file. For sign-out: call it once
   * nothing is playing, since a player reading a deleted file stops.
   */
  clear(): void {
    this.epoch++;
    for (const entry of this.entries.values()) entry.controller?.abort();
    this.entries.clear();
    this.reset();
  }

  // --- internals -------------------------------------------------------------

  private reset(): void {
    try {
      if (this.dir.exists) this.dir.delete();
      this.dir.create({ intermediates: true, idempotent: true });
      this.broken = null;
    } catch (err) {
      this.broken = err instanceof Error ? err : new Error(String(err));
    }
  }

  private start(key: string, url: string, expectedBytes: number | null): Entry {
    const name = fileName(key);
    const entry: Entry = {
      file: new File(this.dir, name),
      ready: false,
      refs: 0,
      waiting: 0,
      lastUsed: Date.now(),
      controller: new AbortController(),
      done: null,
    };
    this.entries.set(key, entry);
    entry.done = this.download(key, entry, url, name, expectedBytes);
    // Every waiter observes `done` through raceAbort; this keeps an abandoned
    // download's rejection from surfacing as unhandled.
    entry.done.catch(() => undefined);
    return entry;
  }

  private async download(
    key: string,
    entry: Entry,
    url: string,
    name: string,
    expectedBytes: number | null,
  ): Promise<void> {
    const epoch = this.epoch;
    // Unique per download: an aborted one cleaning up must not delete the
    // partial file of the download that replaced it.
    const part = new File(this.dir, `${name}.${++this.downloads}.part`);
    try {
      await File.downloadFileAsync(url, part, {
        signal: entry.controller!.signal,
        idempotent: true,
      });
      if (epoch !== this.epoch) throw abortError();
      if (expectedBytes !== null && part.size !== expectedBytes) {
        throw new SegmentFetchError(
          `segment arrived short: ${part.size ?? 0} of ${expectedBytes} bytes`,
          null,
        );
      }
      await part.move(entry.file, { overwrite: true });
      entry.file = new File(this.dir, name);
      entry.ready = true;
      entry.controller = null;
    } catch (err) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      safeDelete(part);
      if (isAbort(err) || epoch !== this.epoch) throw abortError();
      if (err instanceof SegmentFetchError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      // expo-file-system rejects a non-2xx answer as "response has status 403".
      const status = /status (\d{3})/.exec(message);
      throw new SegmentFetchError(message, status ? Number(status[1]) : null);
    }
  }

  private isWhole(entry: Entry, expectedBytes: number | null): boolean {
    try {
      if (!entry.file.exists) return false;
      return expectedBytes === null || entry.file.size === expectedBytes;
    } catch {
      return false;
    }
  }

  private drop(key: string, entry: Entry): void {
    this.entries.delete(key);
    safeDelete(entry.file);
  }

  /** Oldest first, and never a file somebody holds. */
  private evict(): void {
    const ready = [...this.entries].filter(([, e]) => e.ready);
    let excess = ready.length - this.maxEntries;
    if (excess <= 0) return;
    const idle = ready.filter(([, e]) => e.refs === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of idle) {
      if (excess-- <= 0) break;
      this.drop(key, entry);
    }
  }
}

/** The cache for this app. Create ONE and share it: the folder is emptied on creation. */
export function createSegmentCache(options?: SegmentCacheOptions): ExpoSegmentCache {
  return new ExpoSegmentCache(options);
}

/**
 * A stable file name for an object path: a hash, so two keys never collide on
 * a shared basename (every session has a `00000.mp4`), and the `.mp4`
 * extension, which is how `AVPlayer` knows what a local file is.
 */
function fileName(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}.mp4`;
}

function safeDelete(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    /* already gone, or the folder was cleared under it */
  }
}

function abortError(): Error {
  return Object.assign(new Error("The segment download was aborted."), { name: "AbortError" });
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** `promise`, unless `signal` aborts first. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
