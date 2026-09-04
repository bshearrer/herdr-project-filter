import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, formatError } from "../index.js";
import { tmpDir } from "./tmp.js";

const INDEX_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

const WORKSPACES = [
  { workspace_id: "wE", label: "api-server", worktree: { repo_key: "/y/.git", repo_name: "api-server" } },
  { workspace_id: "wAY", label: "Dev" },
];

/** Stub socket recording every request it receives. */
function stubServer() {
  const seen = [];
  const sock = path.join(tmpDir("hpf-index-"), "s.sock");
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      seen.push(req);
      const result =
        req.method === "workspace.list"
          ? { type: "workspace_list", workspaces: WORKSPACES }
          : { type: "agent_view", active: req.method === "agent.view.set" };
      conn.write(JSON.stringify({ id: req.id, result }) + "\n");
    });
  });
  return new Promise((resolve) => server.listen(sock, () => resolve({ sock, server, seen })));
}

function env(sock) {
  const dir = tmpDir("hpf-index-state-");
  process.env.HERDR_SOCKET_PATH = sock;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  return dir;
}

test("cycle advances from unfiltered to the first repo group", async () => {
  const { sock, server, seen } = await stubServer();
  env(sock);
  try {
    await run("cycle");
    const set = seen.find((r) => r.method === "agent.view.set");
    assert.ok(set, "expected an agent.view.set request");
    assert.equal(set.params.label, "api-server");
    assert.deepEqual(set.params.filter.values, ["wE"]);
    assert.equal(set.params.source, "plugin:project-filter");
  } finally {
    server.close();
  }
});

test("a second cycle advances to untracked", async () => {
  const { sock, server, seen } = await stubServer();
  env(sock);
  try {
    await run("cycle");
    await run("cycle");
    const sets = seen.filter((r) => r.method === "agent.view.set");
    assert.equal(sets.at(-1).params.label, "untracked");
  } finally {
    server.close();
  }
});

test("a third cycle returns to unfiltered and clears", async () => {
  const { sock, server, seen } = await stubServer();
  env(sock);
  try {
    await run("cycle");
    await run("cycle");
    await run("cycle");
    assert.equal(seen.at(-1).method, "agent.view.clear");
    assert.equal(seen.at(-1).params.source, "plugin:project-filter");
  } finally {
    server.close();
  }
});

test("startup resets a stored scope and clears", async () => {
  const { sock, server, seen } = await stubServer();
  const dir = env(sock);
  try {
    await run("cycle");
    await run("startup");
    assert.equal(seen.at(-1).method, "agent.view.clear");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).scope, null);
  } finally {
    server.close();
  }
});

test("refresh re-applies the stored scope without advancing", async () => {
  const { sock, server, seen } = await stubServer();
  env(sock);
  try {
    await run("cycle");
    await run("refresh");
    const sets = seen.filter((r) => r.method === "agent.view.set");
    assert.equal(sets.length, 2);
    assert.equal(sets[0].params.label, sets[1].params.label);
  } finally {
    server.close();
  }
});

test("rejects an unknown command", async () => {
  const { sock, server } = await stubServer();
  env(sock);
  try {
    await assert.rejects(() => run("nonsense"), /unknown command/i);
  } finally {
    server.close();
  }
});

// The guard must survive `herdr plugin link`, which invokes the entrypoint
// through a symlink. Node realpaths import.meta.url for the main module, so a
// lexical comparison against argv[1] silently fails to dispatch and exits 0.
test("dispatches when invoked through a symlink", () => {
  const dir = tmpDir("hpf-link-");
  const link = path.join(dir, "index.js");
  fs.symlinkSync(INDEX_PATH, link);
  try {
    // A bogus command throws in run()'s default case before any socket call,
    // so this cannot reach a real herdr. The env vars are scrubbed regardless.
    const childEnv = { ...process.env };
    delete childEnv.HERDR_SOCKET_PATH;
    delete childEnv.HERDR_PLUGIN_STATE_DIR;

    assert.throws(
      () => execFileSync(process.execPath, [link, "nonsense"], { env: childEnv, stdio: "pipe" }),
      (err) => {
        assert.equal(err.status, 1, "guard did not fire: process exited 0 having dispatched nothing");
        assert.match(err.stderr.toString(), /unknown command: nonsense/);
        return true;
      },
    );
  } finally {
    fs.unlinkSync(link);
  }
});

// herdr pipes plugin stderr into `herdr plugin logs`, and process.exit() does
// not flush a pending write to a pipe: the old `console.error(); process.exit(1)`
// truncated the only diagnostic channel a user has at the 64KiB pipe buffer.
test("a long error message reaches stderr in full", () => {
  // 100_000, not 200_000: Linux caps a single argv entry at MAX_ARG_STRLEN
  // (32 pages = 131_072 bytes), so a longer string fails execve with E2BIG
  // before node starts and the test reports a null exit status. This is still
  // comfortably past the 64KiB pipe buffer the test exists to prove.
  const command = "x".repeat(100000);
  const childEnv = { ...process.env };
  delete childEnv.HERDR_SOCKET_PATH;
  delete childEnv.HERDR_PLUGIN_STATE_DIR;

  assert.throws(
    () => execFileSync(process.execPath, [INDEX_PATH, command], { env: childEnv, stdio: "pipe", maxBuffer: 4 << 20 }),
    (err) => {
      assert.equal(err.status, 1);
      const stderr = err.stderr.toString();
      assert.ok(
        stderr.length > 65536,
        `stderr was truncated at ${stderr.length} bytes; process.exit() ate the diagnostic`,
      );
      assert.ok(stderr.trimEnd().endsWith("x"), "the tail of the message was lost");
      return true;
    },
  );
});

test("formatError never prints undefined for a non-Error rejection", () => {
  assert.equal(formatError(new Error("boom")), "[project-filter] boom");
  assert.equal(formatError("boom"), "[project-filter] boom");
  assert.equal(formatError({ code: 7 }), "[project-filter] [object Object]");
});

// Spec, error table: "scoped repo no longer present -> clear the view, reset
// state to `all`, log the reason". The clear and reset happened silently.
test("refresh logs the reason when the scoped repo is gone", async () => {
  const { sock, server, seen } = await stubServer();
  const dir = env(sock);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ scope: "/gone/.git" }) + "\n");

  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(line);
  try {
    await run("refresh");
  } finally {
    console.error = original;
    server.close();
  }

  assert.equal(seen.at(-1).method, "agent.view.clear");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).scope, null);
  assert.match(logged.join("\n"), /\[project-filter\].*\/gone\/\.git.*no longer open/);
});

test("refresh stays quiet when the scope is still live", async () => {
  const { sock, server } = await stubServer();
  env(sock);
  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(line);
  try {
    await run("cycle");
    await run("refresh");
  } finally {
    console.error = original;
    server.close();
  }
  assert.deepEqual(logged, []);
});
