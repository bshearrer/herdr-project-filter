/**
 * Deliberately narrow TOML reader for herdr-plugin.toml's `[[panes]]` table —
 * just enough to pull one pane's `width`/`height` back out. Not a general
 * TOML parser (no arrays-of-inline-tables, no multiline strings): this file
 * ships next to a manifest we author ourselves, so it only has to survive
 * the shapes we actually write.
 *
 * This exists so picker.js's viewport fallback (FALLBACK_ROWS/COLUMNS, used
 * whenever `process.stdout` isn't a real TTY) is *derived* from the manifest
 * pane declaration instead of a hand-maintained constant that can silently
 * drift from it, which is how the pane going from height=12 to height=10
 * previously required remembering to also update a comment.
 *
 * @param {string} toml
 * @param {string} paneId
 * @returns {{width: number|string|null, height: number|null}|null}
 */
export function readPaneConfig(toml, paneId) {
  const blocks = toml.split(/^\[\[panes\]\]\s*$/m).slice(1);
  for (const block of blocks) {
    const id = block.match(/^\s*id\s*=\s*"([^"]*)"\s*$/m)?.[1];
    if (id !== paneId) continue;
    const heightMatch = block.match(/^\s*height\s*=\s*(\d+)\s*$/m);
    const widthMatch = block.match(/^\s*width\s*=\s*(?:"([^"]*)"|(\d+))\s*$/m);
    return {
      height: heightMatch ? Number(heightMatch[1]) : null,
      width: widthMatch ? (widthMatch[1] ?? Number(widthMatch[2])) : null,
    };
  }
  return null;
}
