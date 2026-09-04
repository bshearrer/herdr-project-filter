/**
 * Pure line-layout helpers for picker.js's popup TUI. Kept dependency-free of
 * process/stdout so the width math that caused rows to wrap in a real
 * terminal (NAME_WIDTH padding to a fixed 28 columns with nothing clamping
 * the result to the pane's actual width) can be unit tested directly.
 */

const ESC = "\x1b";
export const RESET = `${ESC}[0m`;

const ELLIPSIS = "…";

/**
 * Shrink `text` to at most `width` visible columns, replacing the last
 * column with an ellipsis rather than letting the terminal wrap it. Never
 * cuts mid-escape-sequence: callers always pass plain (unstyled) text and
 * layer color on afterward via {@link renderLine}.
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function truncate(text, width) {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return text.slice(0, 1);
  return `${text.slice(0, width - 1)}${ELLIPSIS}`;
}

/**
 * Size the name column to the longest name actually present, rather than a
 * fixed guess. Floored so a screen of short names (e.g. only "all") doesn't
 * collapse the column to nothing, and ceilinged so one very long repo name
 * doesn't push every other row's count out to the right — that name
 * truncates instead (see `truncate`).
 * @param {string[]} names
 * @param {{min?: number, max?: number}} [opts]
 * @returns {number}
 */
export function nameColumnWidth(names, { min = 6, max = 20 } = {}) {
  const longest = names.reduce((n, name) => Math.max(n, name.length), 0);
  return Math.max(min, Math.min(max, longest));
}

/**
 * "  3 agents" / "  1 agent", padded to a fixed width so the count column
 * lines up whether the row is singular or plural.
 * @param {number} total
 * @param {number} width
 * @returns {string}
 */
export function formatCount(total, width) {
  const noun = total === 1 ? "agent" : "agents";
  return `${String(total).padStart(3)} ${noun}`.padEnd(width);
}

/**
 * Compose a line from plain-text segments, each optionally wrapped in an
 * ANSI color code, and guarantee the *visible* result never exceeds
 * `columns` — the load-bearing fix: the picker's viewport math assumes one
 * output line per row, so a line the terminal has to wrap breaks it.
 *
 * Truncation (with an ellipsis) lands on whichever segment is straddling the
 * boundary; segments after it are dropped entirely. Callers get graceful
 * degradation for free by ordering the least important segments last (or, as
 * picker.js does for the attention flag and active marker, by omitting a
 * whole segment up front once it's clear it can't fit anyone's row).
 * @param {{text: string, color?: string}[]} segments
 * @param {number} columns
 * @returns {string}
 */
export function renderLine(segments, columns) {
  const width = Math.max(0, columns);
  let used = 0;
  let out = "";
  for (const segment of segments) {
    if (used >= width) break;
    const remaining = width - used;
    let text = segment.text ?? "";
    if (text.length > remaining) text = truncate(text, remaining);
    if (text.length === 0) continue;
    used += text.length;
    out += segment.color ? `${segment.color}${text}${RESET}` : text;
  }
  return out;
}

/** How many list rows fit alongside the fixed chrome (blank spacer(s) + footer). */
export function viewportSize(count, rows, chromeLines) {
  return Math.max(1, Math.min(count, rows - chromeLines));
}

/**
 * Scroll the window only as far as it takes to keep `selected` inside it, so
 * the list moves the way a list is expected to move: not at all until the
 * selection walks off an edge.
 */
export function scrollOffset(offset, selected, count, visible) {
  if (count <= visible) return 0;
  let next = Math.max(0, Math.min(offset, count - visible));
  if (selected < next) next = selected;
  else if (selected >= next + visible) next = selected - visible + 1;
  return next;
}
