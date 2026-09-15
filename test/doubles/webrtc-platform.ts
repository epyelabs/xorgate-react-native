/**
 * A fake `WebRtcPlatform`: no AWS, no sockets, no peer connection — just the
 * handles a test needs to drive the real `KvsViewerSession` inside
 * `@xorgate/react` through its states. It stands in for what happens above
 * `createPeerConnection`, so what these tests exercise is this package's
 * wiring plus the session's actual logic.
 */
import type { PeerConnectionLike, SignalingLike, WebRtcPlatform } from "@xorgate/react";

export class FakeSignaling implements SignalingLike {
  private readonly handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  opened = false;
  closed = false;
  on(event: string, cb: (...a: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb as (...a: unknown[]) => void);
    this.handlers.set(event, list);
  }
  open(): void {
    this.opened = true;
  }
  close(): void {
    this.closed = true;
  }
  sendSdpOffer(): void {}
  sendIceCandidate(): void {}
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
}

export class FakePeerConnection implements PeerConnectionLike {
  connectionState = "new";
  localDescription: unknown = { type: "offer" };
  closed = false;
  private readonly handlers = new Map<string, Array<(e: never) => void>>();
  addTransceiver(): unknown {
    return {};
  }
  async createOffer(): Promise<unknown> {
    return { type: "offer" };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  addEventListener(type: string, cb: (event: never) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(cb);
    this.handlers.set(type, list);
  }
  async getStats(): Promise<Iterable<unknown> & { forEach(cb: (r: unknown) => void): void }> {
    return [];
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, event: unknown): void {
    for (const cb of this.handlers.get(type) ?? []) cb(event as never);
  }
}

export interface Attempt {
  signaling: FakeSignaling;
  pc: FakePeerConnection;
  clientId: string;
}

export function fakeWebRtcPlatform(): { platform: WebRtcPlatform; attempts: Attempt[] } {
  const attempts: Attempt[] = [];
  const platform: WebRtcPlatform = {
    getViewerEndpoints: async () => ({ wss: "wss://signaling", https: "https://signaling" }),
    getIceServers: async () => [],
    createSignaling: (args) => {
      const signaling = new FakeSignaling();
      attempts.push({
        signaling,
        pc: null as unknown as FakePeerConnection,
        clientId: args.clientId,
      });
      return signaling;
    },
    createPeerConnection: () => {
      const pc = new FakePeerConnection();
      attempts[attempts.length - 1]!.pc = pc;
      return pc;
    },
    randomId: () => `fake-${attempts.length}`,
  };
  return { platform, attempts };
}

/** The remote stream a track event carries, with react-native-webrtc's `toURL()`. */
export function fakeStream(id: string): { id: string; toURL(): string } {
  return { id, toURL: () => `url:${id}` };
}
