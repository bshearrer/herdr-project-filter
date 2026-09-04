import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { readScope, writeScope } from "../lib/state.js";
import { tmpDir } from "./tmp.js";

const STATE_URL = new URL("../lib/state.js", import.meta.url).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tmp() {
  return tmpDir("hpf-state-");
}

test("returns null when no state file exists", () => {
  assert.equal(readScope(tmp()), null);
});

test("round-trips a scope", () => {
  const dir = tmp();
  writeScope(dir, "/y/.git");
  assert.equal(readScope(dir), "/y/.git");
});

test("round-trips null", () => {
  const dir = tmp();
  writeScope(dir, "/y/.git");
  writeScope(dir, null);
  assert.equal(readScope(dir), null);
});

test("treats a corrupt state file as unfiltered", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "state.json"), "{not json");
  assert.equal(readScope(dir), null);
});

test("treats a non-string scope as unfiltered", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ scope: 42 }));
  assert.equal(readScope(dir), null);
});

test("creates the state directory when it is missing", () => {
  const dir = path.join(tmp(), "nested");
  writeScope(dir, "untracked");
  assert.equal(readScope(dir), "untracked");
});

// herdr emits workspace.created AND worktree.opened for a single worktree-open
// action, and both are hooked, so every worktree open runs two `index.js
// refresh` processes concurrently against this one file. A truncate-then-write
// exposes an empty (or half-written) file to the other process, whose readScope
// reports `null` — and refresh then persists that as "unfiltered", silently
// dropping the operator's scope for good.
test("concurrent writers never expose a torn or partial state file", async () => {
  const dir = tmp();
  const file = path.join(dir, "state.json");
  const LONG = "/repos/" + "a".repeat(4000) + "/.git";
  const SHORT = "/b/.git";

  const writer = path.join(dir, "writer.mjs");
  fs.writeFileSync(
    writer,
    `import { writeScope } from ${JSON.stringify(STATE_URL)};\n` +
      "const [dir, scope, n] = process.argv.slice(2);\n" +
      "for (let i = 0; i < Number(n); i++) writeScope(dir, scope);\n",
  );

  const children = [LONG, SHORT, LONG, SHORT].map((scope) =>
    spawn(process.execPath, [writer, dir, scope, "3000"], { stdio: "ignore" }),
  );
  let running = children.length;
  const allDone = Promise.all(
    children.map((c) => new Promise((resolve) => c.on("exit", resolve))),
  ).then(() => (running = 0));

  let reads = 0;
  let torn = 0;
  while (running > 0) {
    for (let i = 0; i < 100; i += 1) {
      let raw;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue; // the very first write has not landed yet
      }
      reads += 1;
      try {
        const scope = JSON.parse(raw).scope;
        if (scope !== LONG && scope !== SHORT) torn += 1;
      } catch {
        torn += 1;
      }
    }
    await sleep(0);
  }
  await allDone;

  assert.ok(reads > 500, `test was vacuous: only ${reads} reads observed`);
  assert.equal(torn, 0, `${torn} of ${reads} reads saw a torn state file`);
  assert.equal(readScope(dir), fs.readFileSync(file, "utf8").includes(SHORT) ? SHORT : LONG);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
    "atomic writes must not leave temp files behind",
  );
});
