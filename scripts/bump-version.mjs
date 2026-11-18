#!/usr/bin/env node
// Set the version everywhere it is written, and turn CHANGELOG.md's Unreleased section into that version.
//   node scripts/bump-version.mjs 0.3.0
// Then review the diff, open a pull request, and after it is merged tag main (see docs/releasing.md).
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const next = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next ?? "")) {
  console.error("usage: node scripts/bump-version.mjs <version, e.g. 0.3.0>");
  process.exit(1);
}

const conf = join(root, "apps/desktop/src-tauri/tauri.conf.json");
const prev = JSON.parse(readFileSync(conf, "utf8")).version;
if (prev === next) {
  console.error(`already ${next}`);
  process.exit(1);
}
const esc = (v) => v.replace(/[.+-]/g, "\\$&");

function edit(rel, fn) {
  const p = join(root, rel);
  const before = readFileSync(p, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`${rel}: nothing to change`);
  writeFileSync(p, after);
  console.log(`updated ${rel}`);
}

// JSON files: only the app's own version fields, keeping the formatting
const firstVersion = (s) => s.replace(new RegExp(`("version": ")${esc(prev)}"`), `$1${next}"`);
edit("apps/desktop/src-tauri/tauri.conf.json", firstVersion);
edit("apps/desktop/package.json", firstVersion);
edit("apps/desktop/package-lock.json", (s) => {
  const j = JSON.parse(s);
  j.version = next;
  j.packages[""].version = next;
  return JSON.stringify(j, null, 2) + "\n";
});

// Cargo manifests: the package version and the internal plyfold-* dependencies
const manifests = ["apps/desktop/src-tauri/Cargo.toml", ...readdirSync(join(root, "crates")).map((c) => `crates/${c}/Cargo.toml`)];
for (const m of manifests.filter((m) => existsSync(join(root, m)))) {
  edit(m, (s) =>
    s
      .replace(new RegExp(`^version = "${esc(prev)}"`, "m"), `version = "${next}"`)
      .replace(new RegExp(`(plyfold-[a-z0-9-]+ = \\{ version = ")${esc(prev)}"`, "g"), `$1${next}"`),
  );
}
edit("Cargo.lock", (s) => s.replace(new RegExp(`(name = "plyfold[a-z0-9-]*"\\nversion = ")${esc(prev)}"`, "g"), `$1${next}"`));

// CHANGELOG: the Unreleased notes become this version's, under a fresh empty Unreleased
const today = new Date().toISOString().slice(0, 10);
edit("CHANGELOG.md", (s) => {
  if (!/^## \[Unreleased\]\n\n### /m.test(s)) throw new Error("CHANGELOG.md: the Unreleased section is empty");
  return s
    .replace(/^## \[Unreleased\]\n/m, `## [Unreleased]\n\n## [${next}] - ${today}\n`)
    .replace(/^\[(\d[^\]]*)\]: /m, `[${next}]: https://github.com/Tettu0530/plyfold/releases/tag/v${next}\n[$1]: `);
});

console.log(`\n${prev} -> ${next}. Add a one-line summary under "## [${next}]" if you like, then commit.`);
