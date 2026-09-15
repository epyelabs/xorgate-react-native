import { describe, expect, it, vi } from "vitest";
import { appStateWake, composeWake } from "../src/wake.js";
import { appStateListenerCount, emitAppState } from "./doubles/react-native.js";

describe("appStateWake", () => {
  it("fires on the foreground edge only", () => {
    const onWake = vi.fn();
    const unsubscribe = appStateWake(onWake);

    emitAppState("background");
    emitAppState("inactive");
    expect(onWake).not.toHaveBeenCalled();

    emitAppState("active");
    expect(onWake).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("detaches its listener on unsubscribe", () => {
    const onWake = vi.fn();
    const before = appStateListenerCount();
    const unsubscribe = appStateWake(onWake);
    expect(appStateListenerCount()).toBe(before + 1);

    unsubscribe();
    expect(appStateListenerCount()).toBe(before);
    emitAppState("active");
    expect(onWake).not.toHaveBeenCalled();
  });
});

describe("composeWake", () => {
  it("fans one wake out over every source and unsubscribes all of them", () => {
    const fires: Array<() => void> = [];
    const unsubscribed: string[] = [];
    const source = (name: string) => (onWake: () => void) => {
      fires.push(onWake);
      return () => unsubscribed.push(name);
    };

    const onWake = vi.fn();
    const unsubscribe = composeWake(source("a"), source("b"))(onWake);

    expect(fires).toHaveLength(2);
    fires[0]();
    fires[1]();
    expect(onWake).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(unsubscribed).toEqual(["a", "b"]);
  });
});
