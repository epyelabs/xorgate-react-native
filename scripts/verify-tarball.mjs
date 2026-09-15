// Verify the artifact npm would publish, not the working tree: pack the
// tarball, check its file list, install it into an EMPTY directory and import
// it the way a consumer would. Mirrors @xorgate/react's script; the consumer
// probe grows with the surface (N2: the provider and hooks; N3: replay).
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarPath], {
    cwd: work,
    stdio: "pipe",
  });
  writeFileSync(
    path.join(work, "probe.mjs"),
    `
import * as xg from "@xorgate/react-native";
import { strict as assert } from "node:assert";
assert.equal(xg.PACKAGE_NAME, "@xorgate/react-native");
console.log("consumer import ok");
`,
  );
  execFileSync("node", [path.join(work, "probe.mjs")], { cwd: work, stdio: "inherit" });

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
