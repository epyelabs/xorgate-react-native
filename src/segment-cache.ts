/**
 * Where a lane's segments can be kept as local files, so the native player is
 * handed a `file://` URI instead of a presigned S3 URL.
 *
 * Why it exists, measured on 2026-10-07: `AVPlayer` does not play a recorded
 * segment progressively. The fMP4 has no `sidx`, so AVFoundation walks every
 * `moof` to the end of the file before it reports `readyToPlay`, and it gets
 * there through five sequential range requests — two of them abandoned after
 * 32 KB, each costing a fresh TLS connection on S3's HTTP/1.1. Against the real
 * bucket the first frame of a 7.3 MB segment took 1.7-32 s (median ~13 s); one
 * plain GET to disk followed by a local load took 1.0-1.75 s. Android's
 * ExoPlayer starts after ~9 s of buffer and does not need this.
 *
 * The engine only knows this contract. The `expo-file-system` implementation
 * lives behind the `@xorgate/react-native/segment-cache` entry point, so an app
 * that never opts in never bundles it.
 */
export interface ReplaySegmentCache {
  /**
   * A local file URI holding the whole segment, downloading it first if it
   * is not already held. Each successful call takes one reference, which the
   * caller hands back through {@link ReplaySegmentCache.release}: a file with
   * references is never evicted, because a native player may still be reading
   * it. Aborting `signal` gives up this caller's interest; the download itself
   * stops once nobody is waiting for it. Rejects with a
   * {@link SegmentFetchError}, or an `AbortError` after an abort.
   */
  acquire(
    key: string,
    url: string,
    expectedBytes: number | null,
    signal: AbortSignal,
  ): Promise<string>;
  /** Hand back one reference taken by {@link ReplaySegmentCache.acquire}. */
  release(key: string): void;
}

/**
 * A segment could not be brought to disk. `status` is the HTTP status when the
 * server answered with one, which is what tells an expired signature (403 —
 * refresh the manifest) from a deleted segment (404/410) from anything else
 * (null: the network, the disk, a short file), where the engine falls back to
 * streaming.
 */
export class SegmentFetchError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "SegmentFetchError";
    this.status = status;
  }
}

/**
 * The cache key for a segment URL: the object path, without the query. A
 * presigned URL is re-signed on every manifest refresh, but the object it
 * names is the same file, so the signature must not split the cache.
 */
export function segmentCacheKey(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}
