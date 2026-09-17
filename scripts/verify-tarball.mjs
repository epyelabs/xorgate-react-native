// Verify the artifact npm would publish, not the working tree: pack the
// tarball, check its file list, install it into an EMPTY directory and import
// it the way a consumer would. Mirrors @xorgate/react's script; the consumer
// probe grows with the surface (N2: the provider and hooks; N3: replay).
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const packJson = JSON.parse(
  execSync("npm pack --dry-run --json", { cwd: repo, encoding: "utf8" }),
);
const files = packJson[0].files.map((f) => f.path);
const allowed = /^(dist\/|readme\.md$|changelog\.md$|license$|package\.json$)/i;
for (const f of files) {
  if (!allowed.test(f)) fail(`unexpected file in tarball: ${f}`);
}
// The readme is lowercase in this repo (created that way on a case-insensitive
// filesystem); npm includes it either way, so match case-insensitively.
const lower = files.map((f) => f.toLowerCase());
for (const required of ["dist/index.js", "dist/index.d.ts", "license", "readme.md"]) {
  if (!lower.includes(required.toLowerCase())) fail(`missing from tarball: ${required}`);
}
console.log(`tarball: ${files.length} files, ${Math.round(packJson[0].size / 1024)} kB packed`);

const tarName = execSync("npm pack", { cwd: repo, encoding: "utf8" }).trim().split("\n").pop();
const tarPath = path.join(repo, tarName);
const work = mkdtempSync(path.join(tmpdir(), "xg-rn-consumer-"));
try {
  writeFileSync(
    path.join(work, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarPath, "react"], {
    cwd: work,
    stdio: "pipe",
  });

  // React Native and react-native-webrtc are peers with no Node build, so the
  // probe supplies the smallest thing that satisfies the imports. This is not
  // a simulation of the runtime — it is a load-bearing check that the shipped
  // ESM graph resolves and that every name the README promises is really on
  // the namespace, which is the class of mistake (a missing re-export, a bad
  // relative specifier, a `.js` extension left off) that only shows up in a
  // consumer and never in the working tree.
  const stub = (name, body) => {
    const dir = path.join(work, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version: "0.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(path.join(dir, "index.js"), body);
  };
  stub(
    "react-native",
    `export const AppState = { addEventListener: () => ({ remove() {} }) };
export const Platform = { OS: "ios" };
export const StyleSheet = { create: (s) => s, absoluteFill: {} };
export const View = () => null;
`,
  );
  stub(
    "react-native-webrtc",
    `export class RTCPeerConnection {}
export class MediaStream {}
export const RTCView = () => null;
`,
  );
  stub(
    "expo-crypto",
    `export const randomUUID = () => "stub-uuid";
export const getRandomValues = (a) => a;
`,
  );
  stub(
    "expo-video",
    `export const createVideoPlayer = () => ({});
export const VideoView = () => null;
`,
  );

  writeFileSync(
    path.join(work, "probe.mjs"),
    `
import * as xg from "@xorgate/react-native";
import { strict as assert } from "node:assert";

// The React Native surface this package exists to add.
for (const name of [
  "nativePlatform",
  "createNativeWebRtcPlatform",
  "appStateWake",
  "composeWake",
  "XorgateNativeProvider",
  "useLiveVideo",
  "LiveVideo",
  "useReplayPlayer",
  "ReplayVideo",
  "ExpoVideoReplayEngine",
]) {
  assert.equal(typeof xg[name], "function", \`\${name} is not exported as a function\`);
}

// A sample of the neutral surface re-exported from @xorgate/react: if the
// re-export block breaks, an app importing from one package loses these
// silently at build time rather than here.
for (const name of [
  "XorgateProvider",
  "XorgateError",
  "useLiveTelemetry",
  "useLiveVideoSession",
  "useLiveBlock",
  "useDevices",
  "useVideoChannels",
  "useReplayPlayerCore",
  "buildTimeline",
  "ReplayClock",
  "presignIotWssUrl",
]) {
  assert.ok(xg[name] !== undefined, \`\${name} is missing from the re-export surface\`);
}

// The browser-only helpers must NOT be here: they need HTMLVideoElement,
// \`window\` or MSE, and re-exporting them would let an app import something
// that throws on a phone. \`useLiveVideo\`, \`LiveVideo\`, \`useReplayPlayer\` and
// \`ReplayVideo\` are SHADOWED by the native ones, asserted above — so the
// check here is that the shadowing really happened and did not leave the
// browser implementation in place.
for (const name of ["browserPlatform", "browserRandomId"]) {
  assert.equal(xg[name], undefined, \`\${name} is browser-only and must not be re-exported\`);
}
assert.ok(
  !String(xg.ReplayVideo).includes("laneVideoRef"),
  "ReplayVideo is @xorgate/react's browser component, not the native one",
);

// The platform object is assembled correctly without a React render.
const platform = xg.nativePlatform({ randomId: () => "fixed-id" });
assert.equal(typeof platform.createWebRtcPlatform, "function");
assert.equal(typeof platform.subscribeWake, "function");
assert.equal(platform.randomId(), "fixed-id");
assert.equal(platform.createWebRtcPlatform().randomId(), "fixed-id");

// Entropy defaults to expo-crypto: Hermes has no crypto global to fall back
// to, and a default that throws would surface at the first MQTT connect.
assert.equal(xg.nativePlatform().randomId(), "stub-uuid");

console.log("consumer import ok");
`,
  );
  execFileSync("node", [path.join(work, "probe.mjs")], { cwd: work, stdio: "inherit" });

  // The polyfill entry is reachable on its own subpath. It is not imported
  // here: it pulls expo-crypto, which has no Node build.
  const polyfillTypes = JSON.parse(
    readFileSync(path.join(work, "node_modules/@xorgate/react-native/package.json"), "utf8"),
  ).exports["./polyfills"];
  if (!polyfillTypes) fail("the ./polyfills subpath is missing from the published exports map");
  for (const f of ["dist/polyfills.js", "dist/polyfills.d.ts"]) {
    if (!lower.includes(f)) fail(`missing from tarball: ${f}`);
  }

  // No secret material in the tarball (the local .env, if any, is gitignored
  // AND unpacked; scan the shipped bytes anyway).
  let localKey = null;
  try {
    const env = readFileSync(path.join(repo, ".env"), "utf8");
    localKey = env.match(/XORGATE_API_KEY=(\S+)/)?.[1] ?? null;
  } catch {
    /* no .env locally */
  }
  if (localKey && localKey.length > 8) {
    const shipped = execSync(`tar -xOzf ${tarPath}`, { maxBuffer: 64 * 1024 * 1024 }).toString();
    if (shipped.includes(localKey)) fail("the local API key is inside the tarball");
  }
  console.log("no secret material in the tarball");
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(tarPath, { force: true });
}
console.log("verify:tarball ok");
