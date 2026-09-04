import net from "node:net";
import crypto from "node:crypto";

/**
 * herdr spawns plugin commands and blocks on `child.wait()` with no timeout
 * and no kill path, against a global cap of 32 in-flight plugin commands
 * shared by every installed plugin. A call that connects but is never answered
 * must therefore give up on its own, or it hangs forever and permanently
 * consumes one of those slots — and in picker.js it would leave the modal
 * popup on screen with no key handler installed.
 */
export const RPC_TIMEOUT_MS = 5000;

/**
 * One request, one response, one connection. herdr speaks newline-delimited
 * JSON; a response may arrive split across chunks, so buffer to the newline.
 *
 * @param {string} method
 * @param {object} [params]
 * @param {string} [socketPath] defaults to HERDR_SOCKET_PATH
 * @param {number} [timeoutMs] give up if herdr does not answer in this long
 * @returns {Promise<object>} the `result` object
 */
export function call(
  method,
  params = {},
  socketPath = process.env.HERDR_SOCKET_PATH,
  timeoutMs = RPC_TIMEOUT_MS,
) {
  return new Promise((resolve, reject) => {
    if (!socketPath) {
      reject(new Error("HERDR_SOCKET_PATH is not set"));
      return;
    }
    const id = `project-filter:${crypto.randomUUID()}`;
    const conn = net.createConnection(socketPath);
    let buf = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      // destroy(), not end(). end() half-closes and waits for the peer to close
      // its side; herdr holds the connection open, so the socket kept the event
      // loop alive until the timeout below fired. A caller that had its answer
      // still took timeoutMs to exit — which for the picker meant a session-modal
      // popup lingering seconds after the screen was restored. One request, one
      // response, one connection: once the response is in, the socket is done.
      conn.destroy();
      fn(value);
    };

    conn.setTimeout(timeoutMs, () => {
      finish(reject, new Error(`herdr did not answer ${method} within ${timeoutMs}ms`));
    });
    conn.on("connect", () => conn.write(JSON.stringify({ id, method, params }) + "\n"));
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let message;
      try {
        message = JSON.parse(buf.slice(0, nl));
      } catch (err) {
        finish(reject, new Error(`herdr sent malformed JSON: ${err.message}`));
        return;
      }
      if (message.error) {
        const err = new Error(message.error.message ?? "herdr returned an error");
        err.code = message.error.code;
        finish(reject, err);
        return;
      }
      finish(resolve, message.result);
    });
    conn.on("error", (err) => finish(reject, err));
    conn.on("close", () =>
      finish(reject, new Error(`herdr closed the connection before answering ${method}`)),
    );
  });
}
