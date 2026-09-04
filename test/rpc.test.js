import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { call, RPC_TIMEOUT_MS } from "../lib/rpc.js";
import { tmpDir } from "./tmp.js";

/** A socket that accepts the connection and then says nothing, ever. */
function silentServer() {
  const sock = path.join(tmpDir("hpf-sock-"), "s.sock");
  const server = net.createServer((conn) => {
    conn.on("error", () => {}); // the client hangs up on timeout
  });
  return new Promise((resolve) => {
    server.listen(sock, () => resolve({ sock, server }));
  });
}

/** Start a stub herdr socket that replies with `respond(request)`. */
function stubServer(respond, { split = false } = {}) {
  const sock = path.join(tmpDir("hpf-sock-"), "s.sock");
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      const line = JSON.stringify(respond(req)) + "\n";
      if (split) {
        conn.write(line.slice(0, 5));
        setTimeout(() => conn.write(line.slice(5)), 5);
      } else {
        conn.write(line);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(sock, () => resolve({ sock, server }));
  });
}

test("sends method and params and resolves the result", async () => {
  const { sock, server } = await stubServer((req) => ({
    id: req.id,
    result: { type: "echo", method: req.method, params: req.params },
  }));
  try {
    const result = await call("workspace.list", { a: 1 }, sock);
    assert.equal(result.method, "workspace.list");
    assert.deepEqual(result.params, { a: 1 });
  } finally {
    server.close();
  }
});

test("reassembles a response split across chunks", async () => {
  const { sock, server } = await stubServer(
    (req) => ({ id: req.id, result: { ok: true } }),
    { split: true },
  );
  try {
    assert.deepEqual(await call("agent.list", {}, sock), { ok: true });
  } finally {
    server.close();
  }
});

test("rejects with the herdr error code", async () => {
  const { sock, server } = await stubServer((req) => ({
    id: req.id,
    error: { code: "plugin_not_found", message: "plugin not found" },
  }));
  try {
    await assert.rejects(
      () => call("agent.view.set", {}, sock),
      (err) => err.code === "plugin_not_found" && /plugin not found/.test(err.message),
    );
  } finally {
    server.close();
  }
});

test("rejects when the socket does not exist", async () => {
  await assert.rejects(() => call("workspace.list", {}, "/nonexistent/herdr.sock"));
});

// herdr spawns plugin commands and blocks on child.wait() with no timeout or
// kill path, against a global cap of 32 in-flight plugin commands shared by
// every plugin. A call that connects but is never answered would hang forever
// and permanently consume one of those slots; in picker.js it would also leave
// the modal popup up with no key handler installed at all.
test("rejects when herdr accepts the connection but never answers", async () => {
  const { sock, server } = await silentServer();
  try {
    await assert.rejects(
      () => call("workspace.list", {}, sock, 150),
      /herdr did not answer workspace.list within/,
    );
  } finally {
    server.close();
  }
});

test("the default timeout is 5 seconds", () => {
  assert.equal(RPC_TIMEOUT_MS, 5000);
});
