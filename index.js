import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { groupWorkspaces } from "./lib/groups.js";
import { nextScope, resolveScope } from "./lib/cycle.js";
import { buildViewRequest } from "./lib/view.js";
import { readScope, writeScope, stateDir } from "./lib/state.js";
import { call } from "./lib/rpc.js";

export const PLUGIN_ID = "project-filter";
export const SOURCE = `plugin:${PLUGIN_ID}`;

/**
 * herdr pipes plugin stderr into `herdr plugin logs`, which is the only
 * diagnostic channel a user has. Format defensively: a rejection that is not
 * an Error (or an Error subclass with no message) must not print "undefined".
 */
export function formatError(err) {
  return `[${PLUGIN_ID}] ${String(err?.message ?? err)}`;
}

/** @returns {Promise<import("./lib/groups.js").Group[]>} */
export async function resolveGroups() {
  const result = await call("workspace.list");
  return groupWorkspaces(result.workspaces ?? []);
}

/**
 * Persist the scope, then push the matching view. Every apply writes the
 * complete desired state, so a view replaced by another plugin self-corrects.
 */
export async function applyScope(scope, groups) {
  writeScope(stateDir(), scope);
  const request = buildViewRequest(groups, scope, SOURCE);
  return call(request.method, request.params);
}

function openPicker() {
  const bin = process.env.HERDR_BIN_PATH ?? "herdr";
  const child = spawn(
    bin,
    ["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "picker"],
    { stdio: "inherit" },
  );
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`plugin pane open exited ${code}`)),
    );
  });
}

/** @param {string} command */
export async function run(command) {
  switch (command) {
    case "startup":
    case "clear":
      return applyScope(null, []);
    case "cycle": {
      const groups = await resolveGroups();
      return applyScope(nextScope(groups, readScope(stateDir())), groups);
    }
    case "refresh": {
      const groups = await resolveGroups();
      const stored = readScope(stateDir());
      const scope = resolveScope(groups, stored);
      if (stored !== null && scope === null) {
        // Spec: scoped repo no longer present -> clear the view, reset state
        // to `all`, and log the reason so it surfaces in `herdr plugin logs`.
        console.error(
          formatError(`scope "${stored}" is no longer open; resetting to all`),
        );
      }
      return applyScope(scope, groups);
    }
    case "pick":
      return openPicker();
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

// Compare resolved absolute URLs, not basenames — a basename match (e.g. two
// different index.js files, or a test runner whose argv[1] happens to share
// the name) would fire the CLI dispatch on import, which breaks any module
// (this file's own tests, picker.js) that imports `run` for reuse.
//
// realpath before comparing: Node resolves symlinks when setting
// import.meta.url for the main module, but pathToFileURL resolves argv[1]
// only lexically. Without this, `node /symlinked/index.js` compares a
// symlink path against a real one, the guard silently does not fire, and the
// process exits 0 having dispatched nothing. `herdr plugin link` is exactly
// the operation that plants such a symlink.
let invokedDirectly = false;
try {
  invokedDirectly =
    Boolean(process.argv[1]) &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  // argv[1] is not a resolvable path, so this is not a direct invocation.
}
if (invokedDirectly) {
  run(process.argv[2] ?? "").catch((err) => {
    // process.exit() would not flush this write on a pipe, and herdr pipes
    // plugin stderr — set the code and let the process drain and exit.
    console.error(formatError(err));
    process.exitCode = 1;
  });
}
