/**
 * The slice of React Native this package imports, as plain React so the hooks
 * and components can be rendered by @testing-library/react under jsdom. The
 * point is never to simulate the platform — it is to let the wiring
 * (which listener, which prop, which order) be asserted without a simulator,
 * because the simulator can only be run by hand.
 */
import { createElement, type ReactNode } from "react";

type AppStateStatus = "active" | "background" | "inactive";

const listeners = new Set<(state: AppStateStatus) => void>();

export const AppState = {
  addEventListener(event: string, cb: (state: AppStateStatus) => void) {
    if (event !== "change") throw new Error(`unexpected AppState event: ${event}`);
    listeners.add(cb);
    return {
      remove() {
        listeners.delete(cb);
      },
    };
  },
};

/** Test control: drive the app through a lifecycle transition. */
export function emitAppState(state: AppStateStatus): void {
  for (const cb of [...listeners]) cb(state);
}

/** Test control: how many change listeners are currently attached. */
export function appStateListenerCount(): number {
  return listeners.size;
}

export const StyleSheet = {
  create: <T,>(styles: T): T => styles,
  absoluteFill: { position: "absolute" as const, inset: 0 },
};

export function View(props: { children?: ReactNode; [key: string]: unknown }): ReactNode {
  const { children, style, testID, ...rest } = props;
  return createElement(
    "div",
    { "data-testid": testID, ...(rest as Record<string, unknown>) },
    children,
  );
}

export type ViewProps = { children?: ReactNode; style?: unknown; testID?: string };
