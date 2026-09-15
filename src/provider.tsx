import { useMemo } from "react";
import type { ReactNode } from "react";
import { XorgateProvider } from "@xorgate/react";
import type { XorgatePlatform, XorgateProviderProps } from "@xorgate/react";
import { nativePlatform, type NativePlatformOptions } from "./platform.js";

export interface XorgateNativeProviderProps
  extends Omit<XorgateProviderProps, "platform">,
    NativePlatformOptions {
  /**
   * Slots merged OVER the native defaults, for the rare case where one of
   * them is wrong for your app. Everything you leave out stays native.
   */
  platform?: XorgatePlatform;
}

/**
 * `XorgateProvider` with the React Native platform already in it. Use it
 * exactly where a web app uses `XorgateProvider` — same `auth`,
 * `organizationId`, `workspaceId`, `config` and `onError` props, same rule
 * that remounting on the organization (`key={orgId}`) is how you switch
 * tenants.
 */
export function XorgateNativeProvider(props: XorgateNativeProviderProps): ReactNode {
  const { randomId, wake, mqttConnect, platform, children, ...providerProps } = props;

  const merged = useMemo<XorgatePlatform>(
    () => ({
      ...nativePlatform({
        ...(randomId ? { randomId } : {}),
        ...(wake ? { wake } : {}),
        ...(mqttConnect ? { mqttConnect } : {}),
      }),
      ...platform,
    }),
    // The wake array is read once per subscription; an inline literal must not
    // rebuild the platform on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [randomId, mqttConnect, platform],
  );

  return (
    <XorgateProvider {...providerProps} platform={merged}>
      {children}
    </XorgateProvider>
  );
}
