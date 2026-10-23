#!/usr/bin/env node
// Bosun as a stdio MCP server: pipes newline-delimited JSON-RPC between stdin/stdout and Bosun's WebSocket (one
// JSON-RPC message per WebSocket frame). Env: BOSUN_URL (ws:// or wss://), BOSUN_TOKEN (sent as Authorization:
// Bearer, never in the URL and never printed). Exit codes: 0 stdin ended, 1 connection failed or lost, 2 bad
// configuration, 3 authentication refused.
import WebSocket from 'ws';

const MAX_LINE = 2 * 1024 * 1024; // bytes; Bosun's maxPayload: a longer message would get the connection closed
const HANDSHAKE_MS = 15_000;
const MAX_PENDING = 8 * 1024 * 1024; // bytes read before the socket opens, or sent and not yet flushed

const die = (code, msg) => { process.stderr.write(`bosun-mcp-stdio: ${msg}\n`); process.exit(code); };
const warn = (msg) => process.stderr.write(`bosun-mcp-stdio: ${msg}\n`);

function bridgeTarget(env) {
  const raw = env.BOSUN_URL, token = env.BOSUN_TOKEN;
  if (!raw) throw new Error('BOSUN_URL is not set (e.g. ws://127.0.0.1:8002)');
  if (!token) throw new Error('BOSUN_TOKEN is not set');
  let u;
  try { u = new URL(raw); } catch { throw new Error('BOSUN_URL is not a valid URL'); }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error(`BOSUN_URL must be ws:// or wss:// (got ${u.protocol})`);
  if (u.username || u.password || u.searchParams.has('token')) throw new Error('BOSUN_URL must not carry credentials; put the token in BOSUN_TOKEN');
  return { url: u.href, token };
}

// Splits stdin on LF only (a CR before it is dropped), with the byte limit enforced while reading: an oversized
// record is discarded up to its LF instead of being buffered.
function lineReader(onLine) {
  let parts = [], size = 0, skipping = false;
  const record = (buf) => {
    if (skipping) { skipping = false; return; }
    if (size + buf.length > MAX_LINE) { parts = []; size = 0; warn('dropped a message over 2 MiB'); return; }
    let line = Buffer.concat([...parts, buf]);
    parts = []; size = 0;
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
    onLine(line.toString('utf8'));
  };
  return (chunk) => {
    let start = 0, nl;
    while ((nl = chunk.indexOf(0x0a, start)) !== -1) { record(chunk.subarray(start, nl)); start = nl + 1; }
    const rest = chunk.subarray(start);
    if (!rest.length || skipping) return;
    if (size + rest.length > MAX_LINE) { parts = []; size = 0; skipping = true; warn('dropped a message over 2 MiB'); return; }
    parts.push(Buffer.from(rest)); size += rest.length;
  };
}

function run(env = process.env) {
  let target;
  try { target = bridgeTarget(env); } catch (e) { die(2, e.message); }
  const ws = new WebSocket(target.url, { headers: { authorization: `Bearer ${target.token}` }, handshakeTimeout: HANDSHAKE_MS, maxPayload: 64 * 1024 * 1024 });
  let stdinEnded = false;
  const queue = []; // lines read before the socket opened
  let queued = 0, paused = false;

  ws.on('unexpected-response', (_req, res) => {
    const code = res.statusCode;
    res.resume();
    if (code === 401 || code === 403) die(3, `authentication refused by ${target.url} (HTTP ${code}): check BOSUN_TOKEN`);
    die(1, `${target.url} refused the connection (HTTP ${code})`);
  });
  ws.on('error', (e) => { if (!stdinEnded) die(1, `connection to ${target.url} failed: ${e.message}`); process.exit(0); });
  ws.on('close', (code) => {
    if (stdinEnded) process.exit(0);
    die(1, `connection to ${target.url} closed (${code})`);
  });

  // Server -> stdout: one line per frame. Re-serialized, so a frame can never span or split lines.
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { warn('dropped a frame that is not JSON'); return; }
    if (!process.stdout.write(`${JSON.stringify(msg)}\n`)) { ws.pause(); process.stdout.once('drain', () => ws.resume()); }
  });

  // stdin -> server: one frame per non-empty line. Only parseable JSON is forwarded.
  // Before open: queued up to MAX_PENDING. After: stdin pauses while the socket has MAX_PENDING unflushed.
  const send = (line) => {
    if (ws.readyState !== WebSocket.OPEN) {
      queued += Buffer.byteLength(line);
      if (queued > MAX_PENDING) die(1, 'more than 8 MiB of input before the connection opened');
      queue.push(line);
      return;
    }
    ws.send(line, () => { if (paused && ws.bufferedAmount < MAX_PENDING / 2) { paused = false; process.stdin.resume(); } });
    if (!paused && ws.bufferedAmount > MAX_PENDING) { paused = true; process.stdin.pause(); }
  };
  process.stdin.on('data', lineReader((line) => {
    if (!line.trim()) return;
    try { JSON.parse(line); } catch { warn('dropped a line that is not JSON'); return; }
    send(line);
  }));
  process.stdin.on('end', () => {
    stdinEnded = true;
    if (ws.readyState === WebSocket.OPEN) ws.close(1000); // else the open handler flushes the queue and closes
    setTimeout(() => { ws.terminate(); process.exit(0); }, 2000).unref();
  });
  ws.on('open', () => {
    for (const line of queue.splice(0)) send(line);
    queued = 0;
    if (stdinEnded) ws.close(1000);
  });
}

run();
