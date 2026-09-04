import { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every test file gets its own process under `node --test`, so this list is
// per-file and the hook below runs once that file's tests are done. Without it
// each run left its sockets and state dirs behind in $TMPDIR forever.
const created = [];

/** Make a temp directory that is removed when this test file finishes. */
export function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  created.length = 0;
});
