import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { call } from "./lib/rpc.js";
import { readScope, stateDir } from "./lib/state.js";
import { countByGroup, ATTENTION } from "./lib/counts.js";
import { resolveGroups, applyScope, formatError } from "./index.js";
import { readPaneConfig } from "./lib/manifest.js";
import { truncate, nameColumnWidth, formatCount, renderLine, viewportSize as computeViewportSize, scrollOffset } from "./lib/layout.js";

const ESC = "\x1b";
const CTRL_C = "\x03";
const ALT_SCREEN_ON = `${ESC}[?1049h${ESC}[?25l`;
const ALT_SCREEN_OFF = `${ESC}[?25h${ESC}[?1049l`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const ACCENT = `${ESC}[36m`;
const YELLOW = `${ESC}[33m`;
const GREEN = `${ESC}[32m`;
const RESET = `${ESC}[0m`;

// A bare ESC byte and the start of an arrow-key sequence (ESC "[A"/"[B") are
// indistinguishable until the next byte arrives. Under a popup host's pty (or
// any latency) that next byte can land in a separate `data` event, so a lone
// "\x1b" chunk is held briefly rather than treated as Escape immediately.
const ESC_HOLD_MS = 50;

const COUNT_WIDTH = 10; // "999 agents"
// The name column is sized to content (see nameColumnWidth), floored so a
// screen of short names doesn't collapse it and ceilinged so one very long
// repo name truncates instead of shoving the count column out of alignment.
const NAME_WIDTH_MIN = 6;
const NAME_WIDTH_MAX = 20;
// cursor(1) + active-marker(1) + separator(1) before the name column. When
// even a flag-less row doesn't fit this, the active-marker slot is dropped
// for the whole frame, falling back to cursor(1) + separator(1) = 2.
const MARKER_FULL_WIDTH = 3;
// Leading blank spacer (implicit: the clear/home line carries no text of its
// own), trailing blank, and the footer line.
const CHROME_LINES = 3;

// The popup pane's width/height in herdr-plugin.toml drive picker.js's
// non-TTY fallbacks (process.stdout.columns/rows are undefined under piped
// stdio, and under `herdr plugin pane open` before the pty is sized), so
// those fallbacks are derived from the manifest instead of hand-copied
// constants that can drift from it. PANE_CHROME_ROWS is the one number that
// still has to be hand-verified against a live pane spawn: a pane declared
// at height = H is reported to the pty as rows = H - 2 once the popup
// border is drawn.
const PANE_CHROME_ROWS = 2;
const DEFAULT_FALLBACK_ROWS = 8;
const DEFAULT_FALLBACK_COLUMNS = 46;

function manifestPaneConfig() {
  try {
    const manifestPath = fileURLToPath(new URL("./herdr-plugin.toml", import.meta.url));
    return readPaneConfig(readFileSync(manifestPath, "utf8"), "picker");
  } catch {
    // picker.js run somewhere the manifest isn't sitting alongside it
    // (unlikely — they ship together — but the fallback below is safe).
    return null;
  }
}

const PANE_CONFIG = manifestPaneConfig();
const FALLBACK_ROWS = Number.isInteger(PANE_CONFIG?.height)
  ? Math.max(1, PANE_CONFIG.height - PANE_CHROME_ROWS)
  : DEFAULT_FALLBACK_ROWS;
// A percentage width can't be resolved without knowing the real terminal
// size, so only a manifest width given in cells feeds the fallback.
const FALLBACK_COLUMNS = typeof PANE_CONFIG?.width === "number" ? PANE_CONFIG.width : DEFAULT_FALLBACK_COLUMNS;

/**
 * Read a positive integer override from the environment. Used only to give
 * the child-process test harness a way to simulate a specific terminal size:
 * piped stdio always reports `process.stdout.columns`/`rows` as undefined,
 * so there is otherwise no way to drive picker.js at, say, a deliberately
 * narrow width without a real pty.
 */
function envOverride(name) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function terminalColumns() {
  if (process.stdout.columns) return process.stdout.columns;
  return envOverride("HERDR_PLUGIN_TEST_COLUMNS") ?? FALLBACK_COLUMNS;
}

function terminalRows() {
  if (process.stdout.rows) return process.stdout.rows;
  return envOverride("HERDR_PLUGIN_TEST_ROWS") ?? FALLBACK_ROWS;
}

/** How many list rows fit alongside the header and footer. */
function viewportSize(count) {
  return computeViewportSize(count, terminalRows(), CHROME_LINES);
}

function flagText(row) {
  return row.attention > 0 ? ` ● ${row.attention} waiting` : "";
}

/**
 * Build one row, clamped to `columns`. The cursor (where you are) and the
 * active scope (what is currently applied) are different things and both
 * stay legible: the cursor is a leading `›`, the active scope a distinct
 * `✓` in its own column, never the same glyph or position. As width gets
 * scarce, the attention flag drops first, then the active-marker column —
 * the name and its count are what the row exists for and are never dropped.
 */
function buildRowLine(row, { isSelected, isActive, nameWidth, showActiveColumn, showFlags, columns }) {
  const segments = [{ text: isSelected ? "›" : " ", color: isSelected ? ACCENT : undefined }];
  if (showActiveColumn) {
    segments.push({ text: isActive ? "✓" : " ", color: isActive ? GREEN : undefined });
  }
  segments.push({ text: " " });
  segments.push({
    text: truncate(row.name, nameWidth).padEnd(nameWidth),
    color: isSelected ? BOLD : undefined,
  });
  segments.push({ text: formatCount(row.total, COUNT_WIDTH), color: DIM });
  if (showFlags) {
    const flag = flagText(row);
    if (flag) segments.push({ text: flag, color: YELLOW });
  }
  return renderLine(segments, columns);
}

function render(rows, selected, offset, active) {
  const columns = terminalColumns();
  const visible = viewportSize(rows.length);
  const end = Math.min(rows.length, offset + visible);

  const nameWidth = nameColumnWidth(
    rows.map((r) => r.name),
    { min: NAME_WIDTH_MIN, max: NAME_WIDTH_MAX },
  );
  const maxFlagWidth = rows.reduce((w, r) => Math.max(w, flagText(r).length), 0);
  const baseWidth = MARKER_FULL_WIDTH + nameWidth + COUNT_WIDTH;
  const showActiveColumn = columns >= baseWidth;
  const showFlags = maxFlagWidth > 0 && columns >= baseWidth + maxFlagWidth;

  // The pane border already titles the popup ("Project filter"), so the
  // frame opens on a blank spacer line rather than a redundant in-body
  // header — that's one more row available to the list.
  const lines = [`${ESC}[H${ESC}[2J`];
  for (let i = offset; i < end; i += 1) {
    const row = rows[i];
    lines.push(
      buildRowLine(row, {
        isSelected: i === selected,
        isActive: row.key === active,
        nameWidth,
        showActiveColumn,
        showFlags,
        columns,
      }),
    );
  }
  lines.push("", renderLine([{ text: "  ↑↓/jk move · enter select · esc cancel", color: DIM }], columns));
  process.stdout.write(lines.join("\r\n"));
}

async function main() {
  const groups = await resolveGroups();
  const agents = (await call("agent.list")).agents ?? [];
  const counts = countByGroup(groups, agents);
  const current = readScope(stateDir());

  const rows = [
    {
      key: null,
      name: "all",
      total: agents.length,
      // The row an operator checks first has to be able to say "something in
      // here is waiting on you", so count attention across every agent.
      attention: agents.filter((a) => ATTENTION.has(a.agent_status)).length,
    },
    ...groups.map((g) => ({
      key: g.key,
      name: g.name,
      total: counts.get(g.key).total,
      attention: counts.get(g.key).attention,
    })),
  ];

  let selected = Math.max(0, rows.findIndex((r) => r.key === current));
  // A stored scope whose group has gone resolves to unfiltered on the next
  // refresh, so mark "all" rather than marking nothing.
  const active = rows.some((r) => r.key === current) ? current : null;
  let offset = 0;

  const draw = () => {
    offset = scrollOffset(offset, selected, rows.length, viewportSize(rows.length));
    render(rows, selected, offset, active);
  };

  process.stdout.write(ALT_SCREEN_ON);
  draw();

  // Holds an incomplete escape sequence — a lone ESC, or an ESC + CSI/SS3
  // introducer with no final byte yet — while we wait to see whether the
  // rest arrives in a following `data` event (see ESC_HOLD_MS above), or
  // whether it was truly a standalone Escape keypress (or a literal "["/"O"
  // typed right after one).
  let pendingEsc = null;
  let escTimer = null;
  // Set once finish() starts so that a key dispatched behind an Escape (or
  // arriving while applyScope is in flight) cannot redraw or re-enter.
  let exiting = false;

  const clearEscTimer = () => {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
  };

  const finish = async (apply) => {
    if (exiting) return;
    exiting = true;
    // A held ESC timer must never fire after finish() has run (it would
    // re-enter finish() on an already-exiting picker), and must never be the
    // thing keeping the process alive once we're on our way out.
    clearEscTimer();
    process.stdout.write(ALT_SCREEN_OFF);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    if (apply) {
      try {
        await applyScope(rows[selected].key, groups);
      } catch (err) {
        console.error(formatError(err));
        process.exitCode = 1;
      }
    }
    // Deliberately no process.exit(): it would not flush a piped stderr write,
    // and herdr pipes plugin stderr. Releasing stdin lets the loop drain.
    process.stdin.unref?.();
  };

  const handleKey = (key) => {
    if (exiting) return;
    if (key === CTRL_C || key === ESC || key === "q") return void finish(false);
    if (key === "\r" || key === "\n") return void finish(true);
    if (key === "j" || key === `${ESC}[B`) selected = (selected + 1) % rows.length;
    else if (key === "k" || key === `${ESC}[A`) selected = (selected - 1 + rows.length) % rows.length;
    else return;
    draw();
  };

  /**
   * A held escape sequence's hold window expired with no continuation
   * arriving: none of it was actually the start of a longer sequence, so
   * every byte is dispatched as its own keypress rather than dropped. (A
   * lone held "\x1b" dispatches as a real Escape; a held "\x1b[" or "\x1bO"
   * dispatches as Escape followed by a literal "[" or "O", which matches no
   * key binding and is a no-op — but is not silently swallowed.)
   */
  const flushPendingEsc = () => {
    escTimer = null;
    const held = pendingEsc;
    pendingEsc = null;
    for (const ch of held) handleKey(ch);
  };

  const armEscHold = (held) => {
    pendingEsc = held;
    escTimer = setTimeout(flushPendingEsc, ESC_HOLD_MS);
    escTimer.unref?.();
  };

  /**
   * Tokenize one read into a sequence of keys and dispatch each in turn. A
   * single `data` event can carry more than one keypress — two Escapes
   * pressed quickly, Escape immediately followed by a movement key, or an
   * arrow sequence followed by another key — and treating the whole chunk as
   * one key (the previous behavior) silently drops all of them.
   */
  const processBuffer = (buf) => {
    while (buf.length > 0) {
      // A key dispatched earlier in this same buffer may already have
      // started finish() (e.g. two coalesced Escapes, or Escape then Enter);
      // nothing behind it should be parsed once that latch is set.
      if (exiting) return;

      if (buf[0] === ESC) {
        if (buf.length === 1) {
          // Ambiguous: the rest of a sequence may be one read-event away.
          armEscHold(buf);
          return;
        }
        const introducer = buf[1];
        if (introducer === "[" || introducer === "O") {
          if (buf.length === 2) {
            // CSI/SS3 introducer with no final byte yet — just as
            // ambiguous as a lone ESC, and for the same reason.
            armEscHold(buf);
            return;
          }
          handleKey(buf.slice(0, 3)); // e.g. "\x1b[B"
          buf = buf.slice(3);
          continue;
        }
        // A real Escape followed by a separate, unrelated key.
        handleKey(ESC);
        buf = buf.slice(1);
        continue;
      }

      handleKey(buf[0]);
      buf = buf.slice(1);
    }
  };

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    if (exiting) return;
    let data = chunk.toString();
    if (pendingEsc !== null) {
      clearEscTimer();
      data = pendingEsc + data;
      pendingEsc = null;
    }
    processBuffer(data);
  });
}

main().catch((err) => {
  process.stdout.write(ALT_SCREEN_OFF);
  console.error(formatError(err));
  process.exitCode = 1;
  process.stdin.unref?.();
});
