/**
 * An in-memory `expo-file-system` (the SDK 54+ object API): enough of
 * `Paths`, `Directory` and `File` for the segment cache, with every download
 * held open until a test settles it. The disk is a map of path → byte count.
 */

/** Every file on the "disk", by URI, with its size. */
export const disk = new Map<string, number>();
/** Directories that exist. */
export const dirs = new Set<string>();
/** Set to make the next `Directory.create` throw, as a full or read-only disk would. */
export const faults = { createThrows: false };

export interface PendingDownload {
  url: string;
  destination: string;
  signal: AbortSignal | undefined;
  aborted: boolean;
  settled: boolean;
  /** Write `bytes` to the destination and resolve. */
  complete: (bytes: number) => void;
  /** Reject the way the native module does on a non-2xx answer. */
  failWithStatus: (status: number) => void;
  /** Reject with an arbitrary error (the network, the disk). */
  fail: (message: string) => void;
}
export const downloads: PendingDownload[] = [];

export function resetFileSystem(): void {
  disk.clear();
  dirs.clear();
  downloads.length = 0;
  faults.createThrows = false;
}

function join(parts: Array<string | { uri: string }>): string {
  return parts
    .map((part) => (typeof part === "string" ? part : part.uri))
    .reduce((acc, part) => (acc === "" ? part : `${acc.replace(/\/+$/, "")}/${part.replace(/^\/+/, "")}`), "");
}

export const Paths = { cache: { uri: "file:///cache" } };

export class Directory {
  readonly uri: string;

  constructor(...parts: Array<string | { uri: string }>) {
    this.uri = join(parts);
  }

  get exists(): boolean {
    return dirs.has(this.uri);
  }

  create(_options?: { intermediates?: boolean; idempotent?: boolean }): void {
    if (faults.createThrows) throw new Error("No space left on device");
    dirs.add(this.uri);
  }

  delete(): void {
    dirs.delete(this.uri);
    for (const path of [...disk.keys()]) if (path.startsWith(`${this.uri}/`)) disk.delete(path);
  }
}

export class File {
  uri: string;

  constructor(...parts: Array<string | { uri: string }>) {
    this.uri = join(parts);
  }

  get exists(): boolean {
    return disk.has(this.uri);
  }

  get size(): number | null {
    return disk.get(this.uri) ?? null;
  }

  delete(): void {
    if (!disk.has(this.uri)) throw new Error(`no such file: ${this.uri}`);
    disk.delete(this.uri);
  }

  async move(destination: File, options?: { overwrite?: boolean }): Promise<void> {
    const size = disk.get(this.uri);
    if (size === undefined) throw new Error(`no such file: ${this.uri}`);
    if (disk.has(destination.uri) && !options?.overwrite) throw new Error("destination exists");
    disk.delete(this.uri);
    disk.set(destination.uri, size);
    this.uri = destination.uri;
  }

  static downloadFileAsync(
    url: string,
    destination: File,
    options?: { signal?: AbortSignal; idempotent?: boolean },
  ): Promise<File> {
    return new Promise<File>((resolve, reject) => {
      const pending: PendingDownload = {
        url,
        destination: destination.uri,
        signal: options?.signal,
        aborted: false,
        settled: false,
        complete: (bytes) => {
          if (pending.settled) return;
          pending.settled = true;
          disk.set(destination.uri, bytes);
          resolve(destination);
        },
        failWithStatus: (status) => {
          if (pending.settled) return;
          pending.settled = true;
          reject(new Error(`Unable to download a file: response has status ${status}`));
        },
        fail: (message) => {
          if (pending.settled) return;
          pending.settled = true;
          reject(new Error(message));
        },
      };
      options?.signal?.addEventListener("abort", () => {
        if (pending.settled) return;
        pending.settled = true;
        pending.aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
      downloads.push(pending);
    });
  }
}
