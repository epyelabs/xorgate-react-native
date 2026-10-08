import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `react-native` and `react-native-webrtc` have no Node build, so the suite
 * runs against the doubles in `test/doubles` and renders through react-dom
 * under jsdom. What that can prove is the wiring — which listener is
 * attached, which prop the view gets, what happens across a reconnect — and
 * that is exactly the part of this package that is not somebody else's already
 * tested code. Pixels, hardware decode and the real socket lifecycle are the
 * simulator's and the phone's job, and are recorded in the plan instead.
 *
 * Anchored regexes, not bare strings: a string alias matches by PREFIX, so
 * `react-native` would swallow `react-native-webrtc` on any reordering.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^react-native-webrtc$/,
        replacement: path.join(here, "test/doubles/react-native-webrtc.tsx"),
      },
      { find: /^react-native$/, replacement: path.join(here, "test/doubles/react-native.tsx") },
      { find: /^expo-crypto$/, replacement: path.join(here, "test/doubles/expo-crypto.ts") },
      { find: /^expo-video$/, replacement: path.join(here, "test/doubles/expo-video.tsx") },
      {
        find: /^expo-file-system$/,
        replacement: path.join(here, "test/doubles/expo-file-system.ts"),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "jsdom",
  },
});
