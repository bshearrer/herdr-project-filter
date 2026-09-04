import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./tmp.js";
import { readPaneConfig } from "../lib/manifest.js";

// Regression coverage for picker.js's interactive key-handling path, driven
// as a child process against a stub Unix socket — the same technique
// test/index.test.js uses for the RPC layer. picker.js opens a real popup
// under herdr, so it cannot be exercised through `herdr plugin action
// invoke` here; running it out-of-process with piped, non-TTY stdio is the
// closest durable equivalent.

const PICKER_PATH = fileURLToPath(new URL("../picker.js", import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL("../herdr-plugin.toml", import.meta.url));

// picker.js derives its non-TTY row/column fallback from the "picker" pane's
// declared height/width in herdr-plugin.toml (see lib/manifest.js), rather
// than a hand-copied constant. Tests derive their expectations the same way,
// so a manifest resize doesn't silently desync this file from picker.js.
const PANE_CONFIG = readPaneConfig(fs.readFileSync(MANIFEST_PATH, "utf8"), "picker");
const PANE_CHROME_ROWS = 2; // see picker.js: a declared height=H pane reports rows=H-2 once spawned.
const FALLBACK_ROWS = PANE_CONFIG.height - PANE_CHROME_ROWS;
const FALLBACK_COLUMNS = PANE_CONFIG.width;

const WORKSPACES = [
  { workspace_id: "wE", label: "api-server", worktree: { repo_key: "/y/.git", repo_name: "api-server" } },
  { workspace_id: "wAW", label: "api-2", worktree: { repo_key: "/y/.git", repo_name: "api-server" } },
  { workspace_id: "wAY", label: "Dev" },
];

const AGENTS = [
  { workspace_id: "wE", agent_status: "working", state_change_seq: 1 },
  { workspace_id: "wAW", agent_status: "blocked", state_change_seq: 2 },
  { workspace_id: "wAW", agent_status: "done", state_change_seq: 3 },
  { workspace_id: "wAY", agent_status: "idle", state_change_seq: 4 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the picker to exit, but never forever: a regression that leaves it
 * running must fail its assertion rather than hang the whole runner.
 */
/** Drop SGR/CSI sequences so a frame can be measured in visible columns. */
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** The most recent full repaint: render() begins every frame with home+clear. */
const lastFrame = (stdout) => stdout.split("\x1b[H\x1b[2J").at(-1);

async function mustExit(exited, ms = 3000) {
  const result = await Promise.race([exited, sleep(ms).then(() => null)]);
  assert.ok(result, `picker was still running ${ms}ms after the key that should have closed it`);
  return result;
}

/**
 * Stub socket answering workspace.list and agent.list with fixture data. By
 * default agent.view.set/agent.view.clear are acknowledged; passing
 * `failMethod` makes that one method drop the connection instead of
 * responding, simulating an RPC failure.
 */
function stubServer({ failMethod, workspaces = WORKSPACES, agents = AGENTS } = {}) {
  const seen = [];
  const sock = path.join(tmpDir("hpf-picker-"), "s.sock");
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const req = JSON.parse(line);
        seen.push(req);
        if (req.method === failMethod) {
          conn.destroy();
          return;
        }
        const result =
          req.method === "workspace.list"
            ? { type: "workspace_list", workspaces }
            : req.method === "agent.list"
              ? { type: "agent_list", agents }
              : { type: "agent_view", active: req.method === "agent.view.set" };
        conn.write(JSON.stringify({ id: req.id, result }) + "\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(sock, () => resolve({ sock, server, seen })));
}

// render() begins every frame with this home+clear sequence (see also
// `lastFrame` above) — its first appearance on stdout is the observable
// signal that resolveGroups()/agent.list have resolved and the picker has
// drawn its first frame and installed its key handler.
const HOME_CLEAR = "\x1b[H\x1b[2J";

/** Spawn picker.js with piped, non-TTY stdio against a stub socket. */
function spawnPicker(sock, stateDir, env = {}) {
  const child = spawn(process.execPath, [PICKER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HERDR_SOCKET_PATH: sock, HERDR_PLUGIN_STATE_DIR: stateDir, ...env },
  });
  let stdout = "";
  let stderr = "";
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  child.stdout.on("data", (c) => {
    stdout += c.toString();
    if (stdout.includes(HOME_CLEAR)) resolveReady();
  });
  child.stderr.on("data", (c) => (stderr += c.toString()));
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    ready,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

/**
 * Wait for the picker's first rendered frame rather than hoping a fixed
 * delay was long enough. A picker that never renders (a real regression, not
 * just a slow runner) must fail loudly here instead of hanging the suite.
 */
async function waitForReady(picker, ms = 5000) {
  const timedOut = Symbol("timed out");
  const result = await Promise.race([picker.ready, sleep(ms).then(() => timedOut)]);
  assert.notEqual(
    result,
    timedOut,
    `picker did not render its first frame within ${ms}ms\nstdout: ${JSON.stringify(picker.stdout())}\nstderr: ${JSON.stringify(picker.stderr())}`,
  );
}

async function setup(opts = {}) {
  const { sock, server, seen } = await stubServer(opts);
  const stateDir = tmpDir("hpf-picker-state-");
  if (opts.scope !== undefined) {
    fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ scope: opts.scope }) + "\n");
  }
  const picker = spawnPicker(sock, stateDir, opts.env);
  // Wait for resolveGroups()/agent.list to resolve and the first render to
  // happen, rather than a fixed sleep — see waitForReady().
  await waitForReady(picker);
  return { server, seen, stateDir, ...picker };
}

test("a split escape sequence (ESC then '[B' in separate writes) moves the selection instead of closing the picker", async () => {
  const { child, exited, stdout, seen, server } = await setup();
  try {
    child.stdin.write("\x1b");
    await sleep(10); // well under the 50ms hold, but a separate data event
    child.stdin.write("[B");

    // Long enough that a buggy build (which treats the lone ESC as an
    // immediate cancel) would already have exited.
    await sleep(200);
    assert.equal(child.exitCode, null, "picker exited on a split arrow-key sequence instead of moving the selection");

    // The down-arrow should have moved the highlight onto the first repo row.
    const frame = lastFrame(stdout());
    assert.ok(
      /\x1b\[36m›\x1b\[0m\s+\x1b\[1mapi-server/.test(frame),
      `expected the selected-row marker on "api-server"; frame was:\n${JSON.stringify(frame)}`,
    );
    assert.ok(
      strip(frame).split("\r\n").some((line) => /^›\s+api-server/.test(line)),
      `expected selection to move to "api-server"; frame was:\n${strip(frame)}`,
    );

    child.stdin.write("q");
    const { code, signal } = await mustExit(exited);
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.ok(!seen.some((r) => r.method === "agent.view.set"), "quitting with q must not apply a scope");
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("a bare ESC with no continuation still cancels the picker", async () => {
  const { child, exited, seen, stateDir, server } = await setup();
  try {
    child.stdin.write("\x1b");
    const { code, signal } = await mustExit(exited);
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.ok(!seen.some((r) => r.method === "agent.view.set" || r.method === "agent.view.clear"));
    assert.ok(!fs.existsSync(path.join(stateDir, "state.json")), "escape must not persist a scope");
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("selecting a project applies the scope and exits cleanly", async () => {
  const { child, exited, seen, stateDir, server } = await setup();
  try {
    child.stdin.write("j");
    await sleep(50);
    child.stdin.write("\r");
    const { code, signal } = await mustExit(exited);
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.ok(seen.some((r) => r.method === "agent.view.set"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).scope, "/y/.git");
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("a failing RPC during selection is reported as [project-filter] ... and exits non-zero, not an unhandled rejection", async () => {
  const { child, exited, stderr, server } = await setup({ failMethod: "agent.view.set" });
  try {
    child.stdin.write("j");
    await sleep(50);
    child.stdin.write("\r");
    const { code, signal } = await mustExit(exited);
    assert.equal(signal, null);
    assert.notEqual(code, 0, "a failed RPC during selection must exit non-zero");
    assert.match(stderr(), /^\[project-filter\] /, `expected a graceful [project-filter] error, got:\n${stderr()}`);
    assert.doesNotMatch(stderr(), /Unhandled/i, `expected no raw unhandled-rejection output, got:\n${stderr()}`);
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

// The 50ms ESC hold window must not swallow the key that follows a real
// Escape. herdr forwards every key to an open popup, so a picker that stays
// up after Escape looks like a frozen session.
test("two Escapes 10ms apart cancel the picker", async () => {
  const { child, exited, seen, server } = await setup();
  try {
    child.stdin.write("\x1b");
    await sleep(10); // inside the hold window
    child.stdin.write("\x1b");
    const { code, signal } = await mustExit(exited);
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.ok(!seen.some((r) => r.method === "agent.view.set"));
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("Escape followed by an unrelated key still cancels the picker", async () => {
  const { child, exited, seen, server } = await setup();
  try {
    child.stdin.write("\x1b");
    await sleep(10); // inside the hold window
    child.stdin.write("j");
    const { code, signal } = await mustExit(exited);
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.ok(!seen.some((r) => r.method === "agent.view.set"));
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

// A slow runner can leave a scripted key sequence sitting in the pipe buffer
// until the picker resumes stdin, so it arrives as one coalesced `data`
// chunk rather than the separate reads a human's keystrokes would produce.
// The picker must parse a chunk into multiple keys instead of treating it as
// one unrecognized blob and dropping every key inside it.
test("a coalesced double Escape (one write) closes the picker", async () => {
  const { child, exited, seen, server } = await setup();
  try {
    child.stdin.write("\x1b\x1b"); // Escape pressed twice quickly, one read
    const { code, signal } = await mustExit(exited);
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.ok(!seen.some((r) => r.method === "agent.view.set"));
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("a coalesced Escape+j (one write) cancels on the Escape and does not leave the picker running", async () => {
  const { child, exited, seen, server } = await setup();
  try {
    child.stdin.write("\x1bj"); // Escape immediately followed by "j", one read
    const { code, signal } = await mustExit(exited);
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.ok(!seen.some((r) => r.method === "agent.view.set"), "the trailing 'j' must not have selected and applied a scope");
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("a coalesced arrow sequence plus a following key (one write) is parsed as two keys, not dropped", async () => {
  const { child, exited, stdout, server } = await setup();
  try {
    // "\x1b[B" (down) then "j" (down again), arriving as a single read:
    // selection should move from "all" to "api-server" and then to "untracked".
    child.stdin.write("\x1b[Bj");
    await sleep(100);
    assert.equal(child.exitCode, null, "picker exited instead of just moving the selection twice");

    const lines = strip(lastFrame(stdout())).split("\r\n");
    const selected = lines.find((line) => line.startsWith("›"));
    assert.ok(selected, `nothing is selected in:\n${lines.join("\n")}`);
    assert.match(selected, /untracked/, `expected two down-moves to land on "untracked":\n${lines.join("\n")}`);

    child.stdin.write("q");
    await mustExit(exited);
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("the count column stays put when the selection moves", async () => {
  const { child, exited, stdout, server } = await setup();
  try {
    child.stdin.write("j"); // bolding the selected name must not steal columns
    await sleep(100);
    const rows = strip(lastFrame(stdout()))
      .split("\r\n")
      .filter((line) => / agents?\b/.test(line));
    assert.equal(rows.length, 3, `expected 3 rows, got:\n${rows.join("\n")}`);
    const columns = rows.map((line) => line.search(/\d+ agents?\b/));
    assert.equal(new Set(columns).size, 1, `count column shifted between rows:\n${rows.join("\n")}`);
    child.stdin.write("q");
    await mustExit(exited);
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("a single agent is reported in the singular", async () => {
  const { child, exited, stdout, server } = await setup();
  try {
    const frame = strip(lastFrame(stdout()));
    assert.match(frame, /\b1 agent\b/);
    assert.doesNotMatch(frame, /\b1 agents\b/);
    child.stdin.write("q");
    await mustExit(exited);
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

// The "all" row is the one an operator checks first, so it must be able to
// show the waiting flag rather than hardcoding attention to zero.
test("the all row counts agents needing attention across every group", async () => {
  const { child, exited, stdout, server } = await setup();
  try {
    const allRow = strip(lastFrame(stdout()))
      .split("\r\n")
      .find((line) => /\ball\b/.test(line));
    assert.match(allRow, /4 agents.*● 2 waiting/);
    child.stdin.write("q");
    await mustExit(exited);
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

// The active scope (what agent.view is currently scoped to) and the cursor
// (where the highlight sits) are different things and both stay legible: a
// compact "✓" in its own column for the former, the "›" cursor glyph — a
// different symbol, in a different column, in a different color — for the
// latter, rather than the old "(active)" text that read as noise next to it.
test("the active scope stays marked, distinctly from the cursor, after the selection moves off it", async () => {
  const { child, exited, stdout, server } = await setup({ scope: "/y/.git" });
  try {
    child.stdin.write("j"); // selection moves to untracked; api-server stays active
    await sleep(100);
    const rawLines = lastFrame(stdout()).split("\r\n");
    const plainLines = rawLines.map(strip);
    const apiRowIndex = plainLines.findIndex((line) => /\bapi-server\b/.test(line));
    const untrackedIndex = plainLines.findIndex((line) => /\buntracked\b/.test(line));
    assert.ok(apiRowIndex >= 0 && untrackedIndex >= 0, `expected both rows; frame was:\n${plainLines.join("\n")}`);

    // "(active)" text is gone entirely.
    assert.doesNotMatch(plainLines.join("\n"), /\(active\)/);

    // api-server (active, not selected): green "✓" marks it, no cyan "›" cursor.
    assert.match(rawLines[apiRowIndex], /\x1b\[32m✓\x1b\[0m/, `expected an active marker on api-server:\n${rawLines[apiRowIndex]}`);
    assert.doesNotMatch(rawLines[apiRowIndex], /\x1b\[36m›\x1b\[0m/, "api-server is not selected, so it must not carry the cursor");
    assert.match(plainLines[apiRowIndex], /^\s*✓/, "active marker should render at the start of the row");

    // untracked (selected, not active): cyan "›" cursor, no green "✓".
    assert.match(rawLines[untrackedIndex], /\x1b\[36m›\x1b\[0m/, "selection should have moved to untracked");
    assert.doesNotMatch(rawLines[untrackedIndex], /\x1b\[32m✓\x1b\[0m/, "untracked is not the active scope");
    assert.match(plainLines[untrackedIndex], /^›/, "selection should have moved to untracked");

    child.stdin.write("q");
    await mustExit(exited);
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

// The popup pane's declared height maps to FALLBACK_ROWS usable rows (see
// above). Without a viewport, five or more groups push the footer off-screen
// and scroll the top of the list away — on a plugin whose whole premise is a
// heavy multi-project day.
const MANY_WORKSPACES = Array.from({ length: 12 }, (_, i) => ({
  workspace_id: `w${i}`,
  label: `p${i}`,
  worktree: { repo_key: `/r${i}/.git`, repo_name: `repo-${String(i).padStart(2, "0")}` },
}));
const MANY_AGENTS = MANY_WORKSPACES.map((ws) => ({
  workspace_id: ws.workspace_id,
  agent_status: "working",
}));

test("more groups than fit still render the top of the list and the footer", async () => {
  const { child, exited, stdout, server } = await setup({
    workspaces: MANY_WORKSPACES,
    agents: MANY_AGENTS,
  });
  try {
    const frame = strip(lastFrame(stdout()));
    const lines = frame.split("\r\n");
    assert.ok(
      lines.length <= FALLBACK_ROWS,
      `frame is ${lines.length} lines, taller than the ${FALLBACK_ROWS}-row pane:\n${frame}`,
    );
    // No selection has moved yet, so the window starts at the top of the
    // list ("all") rather than having scrolled past it.
    assert.match(lines[1], /\ball\b/, `top of the list scrolled away:\n${frame}`);
    assert.match(lines.at(-1), /esc cancel/, "footer pushed off-screen");
    assert.ok(!frame.includes("repo-11"), "the whole list rendered instead of a window");
    for (const line of lines) {
      assert.ok(
        line.length <= FALLBACK_COLUMNS,
        `line is ${line.length} columns wide, wider than the ${FALLBACK_COLUMNS}-column pane: ${JSON.stringify(line)}`,
      );
    }
    child.stdin.write("q");
    await mustExit(exited);
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("moving the selection to the last row scrolls it into view", async () => {
  const { child, exited, stdout, server } = await setup({
    workspaces: MANY_WORKSPACES,
    agents: MANY_AGENTS,
  });
  try {
    child.stdin.write("k"); // wraps from "all" to the last group
    await sleep(100);
    const frame = strip(lastFrame(stdout()));
    const lines = frame.split("\r\n");
    assert.ok(lines.length <= FALLBACK_ROWS, `frame is ${lines.length} lines:\n${frame}`);
    assert.match(lines.at(-1), /esc cancel/, "footer pushed off-screen");
    const selected = lines.find((line) => line.startsWith("›"));
    assert.ok(selected, `nothing is selected in:\n${frame}`);
    assert.match(selected, /repo-11/, `selected row is not visible:\n${frame}`);
    child.stdin.write("q");
    await mustExit(exited);
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

// --- Layout invariant: no emitted line is ever wider than the pane. -------
//
// picker.js can't be driven under a real narrow pty here (see the file
// header), so HERDR_PLUGIN_TEST_COLUMNS gives the child process the same
// seam picker.js already has for piped stdio (process.stdout.columns/rows
// are always undefined off a real TTY) — a deterministic way to simulate a
// specific terminal size instead of guessing what a CI runner's pty reports.

/** Assert every ANSI-stripped line of `frame` fits within `columns`. */
function assertFits(frame, columns) {
  for (const line of strip(frame).split("\r\n")) {
    assert.ok(
      line.length <= columns,
      `line is ${line.length} columns wide, wider than the ${columns}-column pane: ${JSON.stringify(line)}`,
    );
  }
}

test("a narrow pane never wraps: every line fits, and the widest optional element (the attention flag) drops before anything essential does", async () => {
  const NARROW_COLUMNS = 30;
  const { child, exited, stdout, server } = await setup({ env: { HERDR_PLUGIN_TEST_COLUMNS: String(NARROW_COLUMNS) } });
  try {
    const frame = lastFrame(stdout());
    assertFits(frame, NARROW_COLUMNS);

    const lines = strip(frame).split("\r\n");
    // The name and its count are what the row exists for and must survive
    // even though there isn't room for the attention flag alongside them.
    assert.match(lines[1], /\ball\b.*4 agents/, `"all" row lost content at ${NARROW_COLUMNS} columns:\n${frame}`);
    assert.doesNotMatch(frame, /waiting/, "the attention flag should have been dropped, not wrapped or truncated mid-word");
    // At 30 columns the 40-column footer text is itself too wide to show in
    // full — it truncates like everything else rather than wrapping onto a
    // second line, which is exactly the invariant under test.
    assert.match(lines.at(-1), /^\s*↑↓\/jk move/, "footer pushed off-screen at a merely narrow width");

    child.stdin.write("q");
    await mustExit(exited);
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("a pathologically narrow pane still emits no wrapped line", async () => {
  const TINY_COLUMNS = 14;
  const { child, exited, stdout, server } = await setup({ env: { HERDR_PLUGIN_TEST_COLUMNS: String(TINY_COLUMNS) } });
  try {
    const frame = lastFrame(stdout());
    assertFits(frame, TINY_COLUMNS);
    child.stdin.write("q");
    await mustExit(exited);
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("a long group name truncates with an ellipsis instead of shifting the count column out of alignment", async () => {
  const LONG_NAME = "x".repeat(32);
  const workspaces = [{ workspace_id: "wL", label: "long", worktree: { repo_key: "/l/.git", repo_name: LONG_NAME } }];
  const agents = [{ workspace_id: "wL", agent_status: "working" }];
  const { child, exited, stdout, server } = await setup({ workspaces, agents });
  try {
    const frame = lastFrame(stdout());
    assertFits(frame, FALLBACK_COLUMNS);

    const lines = strip(frame).split("\r\n");
    const rows = lines.filter((line) => / agents?\b/.test(line));
    assert.equal(rows.length, 2, `expected the "all" row and the long-name row:\n${lines.join("\n")}`);

    // Truncated, not left to push everything after it out of place.
    const longRow = rows.find((line) => line.includes(LONG_NAME.slice(0, 10)));
    assert.ok(longRow, `expected a truncated form of the long name:\n${rows.join("\n")}`);
    assert.ok(!longRow.includes(LONG_NAME), "the full 32-character name should have been truncated");
    assert.match(longRow, /…/, "a truncated name should carry an ellipsis rather than just being cut off");

    // The count column still lines up between the short "all" row and the
    // long-named row — this is the pre-existing "shifts the count column"
    // bug the report calls out.
    const columns = rows.map((line) => line.search(/\d+ agents?\b/));
    assert.equal(new Set(columns).size, 1, `count column shifted:\n${rows.join("\n")}`);

    child.stdin.write("q");
    await mustExit(exited);
  } finally {
    server.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
