#!/usr/bin/env node
/**
 * Dumb HTTP/2 bidirectional pipe for Cursor gRPC.
 *
 * Bun's node:http2 is broken. This Node script acts as a transparent
 * HTTP/2 proxy: it opens a single bidirectional stream and ferries
 * raw bytes between the parent process (via stdin/stdout) and Cursor.
 *
 * Protocol (length-prefixed framing over stdin/stdout):
 *   [4 bytes big-endian length][payload]
 *
 * First message on stdin is JSON config:
 *   { "accessToken": "...", "url": "...", "path": "...",
 *     "clientVersion": "...", "contentType": "application/connect+proto" }
 *
 * After config, subsequent stdin messages are raw bytes to write to the H2 stream.
 * H2 response data is written to stdout using the same length-prefixed framing.
 */
import http2 from "node:http2";
import crypto from "node:crypto";

const DEFAULT_CLIENT_VERSION = "cli-2026.02.13-41ac335";
const DEFAULT_CONTENT_TYPE = "application/connect+proto";

/** Write one length-prefixed message to stdout. */
function writeMessage(data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  process.stdout.write(lenBuf);
  process.stdout.write(data);
}

// --- Buffered stdin reader ---

let stdinBuf = Buffer.alloc(0);
let stdinResolve = null;
let stdinEnded = false;

process.stdin.on("data", (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  if (stdinResolve) {
    const r = stdinResolve;
    stdinResolve = null;
    r();
  }
});

process.stdin.on("end", () => {
  stdinEnded = true;
  if (stdinResolve) {
    const r = stdinResolve;
    stdinResolve = null;
    r();
  }
});

function waitForData() {
  return new Promise((resolve) => { stdinResolve = resolve; });
}

async function readExact(n) {
  while (stdinBuf.length < n) {
    if (stdinEnded) return null;
    await waitForData();
  }
  const result = stdinBuf.subarray(0, n);
  stdinBuf = stdinBuf.subarray(n);
  return Buffer.from(result);
}

async function readMessage() {
  const lenBuf = await readExact(4);
  if (!lenBuf) return null;
  const len = lenBuf.readUInt32BE(0);
  if (len === 0) return Buffer.alloc(0);
  return readExact(len);
}

// --- Main ---

const configBuf = await readMessage();
if (!configBuf) process.exit(1);

const config = JSON.parse(configBuf.toString("utf8"));
const { accessToken, url, path: rpcPath, clientVersion, contentType } = config;
const resolvedContentType = contentType || DEFAULT_CONTENT_TYPE;
const useConnect = resolvedContentType.includes("connect");

const client = http2.connect(url || "https://api2.cursor.sh");

const timeout = setTimeout(() => {
  client.destroy();
  process.exit(1);
}, 120_000);

client.on("error", () => {
  clearTimeout(timeout);
  process.exit(1);
});

const headers = {
  ":method": "POST",
  ":path": rpcPath || "/agent.v1.AgentService/Run",
  "content-type": resolvedContentType,
  te: "trailers",
  authorization: `Bearer ${accessToken}`,
  "x-ghost-mode": "true",
  "x-cursor-client-version": clientVersion || DEFAULT_CLIENT_VERSION,
  "x-cursor-client-type": "cli",
  "x-request-id": crypto.randomUUID(),
};
if (useConnect) {
  headers["connect-protocol-version"] = "1";
}

const h2Stream = client.request(headers);

// Forward H2 response data → stdout (length-prefixed)
h2Stream.on("data", (chunk) => {
  writeMessage(chunk);
});

h2Stream.on("end", () => {
  clearTimeout(timeout);
  client.close();
  // Give stdout time to flush
  setTimeout(() => process.exit(0), 100);
});

h2Stream.on("error", () => {
  clearTimeout(timeout);
  client.close();
  process.exit(1);
});

// Forward stdin → H2 stream (after config message)
(async () => {
  while (true) {
    const msg = await readMessage();
    if (!msg || msg.length === 0) {
      // EOF or zero-length = half-close the request (needed for unary RPCs)
      if (!h2Stream.closed && !h2Stream.destroyed) {
        h2Stream.end();
      }
      break;
    }
    if (!h2Stream.closed && !h2Stream.destroyed) {
      h2Stream.write(msg);
    }
  }
})();
