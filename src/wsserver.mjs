// MCP over WebSocket: authenticate in the HTTP upgrade (before any WebSocket or MCP server exists), one MCP server
// per connection, the connection is the owner of the sessions it opens (closed again when it disconnects). The same
// port takes the one-time upload PUTs (uploads.mjs), so a tenant reaches them wherever it reaches MCP.
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createAuthenticator, policyOf, tokenFromRequest } from './auth.mjs';
import { buildServer } from './tools.mjs';

const MAX_PAYLOAD = 2 * 1024 * 1024; // a 1 MiB file as base64 (upload_create content_base64) fits
const HEARTBEAT_MS = 30_000;
const MAX_OPEN_REQUESTS = 64; // requests (of any method) received and not yet answered
const MAX_BUFFERED = 8 * 1024 * 1024; // bytes queued to a client that doesn't read

// MCP Transport over a ws socket. send() settles from the socket's write callback and rejects on a closed socket.
// A client that keeps too many requests open or stops reading its responses is disconnected.
export class WsTransport {
  constructor(ws, { maxOpenRequests = MAX_OPEN_REQUESTS, maxBuffered = MAX_BUFFERED } = {}) {
    this.ws = ws;
    this.closed = false;
    this.open = 0;
    this.maxOpenRequests = maxOpenRequests;
    this.maxBuffered = maxBuffered;
    ws.on('message', (d) => {
      let msg;
      try { msg = JSON.parse(d); } catch (e) { this.onerror?.(e); return; }
      if (msg && typeof msg.method === 'string' && msg.id !== undefined && ++this.open > this.maxOpenRequests) {
        this.onerror?.(new Error('too many open requests'));
        return this.ws.terminate();
      }
      if (msg?.method === 'notifications/cancelled') this.open = Math.max(0, this.open - 1); // no response follows
      this.onmessage?.(msg);
    });
    ws.on('error', (e) => this.onerror?.(e));
    ws.on('close', () => this.fireClose());
  }
  async start() {}
  send(msg) {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) return reject(new Error('websocket is not open'));
      if (msg && msg.id !== undefined && ('result' in msg || 'error' in msg)) this.open = Math.max(0, this.open - 1);
      if (this.ws.bufferedAmount > this.maxBuffered) {
        this.ws.terminate();
        return reject(new Error('client is not reading; disconnected'));
      }
      this.ws.send(JSON.stringify(msg), (e) => (e ? reject(e) : resolve()));
    });
  }
  async close() { try { this.ws.close(); } catch {} this.fireClose(); }
  fireClose() { if (this.closed) return; this.closed = true; this.onclose?.(); }
}

function reject(sock, code, text) {
  try { sock.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
  sock.destroy();
}

export async function startWsServer({ cfg, manager }) {
  const { host, port, maxConnections, allowedOrigins, allowNoToken } = cfg.ws;
  const auth = createAuthenticator(cfg.tokens);
  const conns = new Set();
  let seq = 0;

  const uploads = manager.uploads;
  const authTenant = (req) => {
    if (!req.headers.authorization) return null;
    return (allowNoToken ? 'default' : auth(tokenFromRequest(req, new URLSearchParams()))) || false;
  };
  const srv = http.createServer(async (req, res) => {
    try {
      if (uploads && await uploads.handle(req, res, { authTenant, policyOf: (t) => policyOf(cfg, t) })) return;
    } catch {
      return res.destroy();
    }
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('WebSocket only');
  });
  // An upload may take longer than Node's 5-minute request limit; uploads.mjs bounds each PUT itself (idle, total).
  srv.requestTimeout = 0;
  // Expect: 100-continue is answered by uploads.mjs once the size and credentials are checked, not by Node at once.
  srv.on('checkContinue', (req, res) => srv.emit('request', req, res));
  srv.on('clientError', (_e, sock) => sock.destroy());
  srv.on('error', (e) => console.error(`bosun ws: ${e.message}`));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  wss.on('error', () => {});

  srv.on('upgrade', (req, sock, head) => {
    sock.on('error', () => {});
    try {
      const [, q = ''] = String(req.url).split('?');
      const query = new URLSearchParams(q);
      // Browsers always send Origin; other clients don't. A browser page may only connect from an allowed origin.
      if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return reject(sock, 403, 'Forbidden');
      const tenant = allowNoToken ? 'default' : auth(tokenFromRequest(req, query));
      if (!tenant) return reject(sock, 401, 'Unauthorized');
      if (conns.size >= maxConnections) return reject(sock, 503, 'Service Unavailable');
      wss.handleUpgrade(req, sock, head, (ws) => onConnection(ws, tenant, uploadBase(req)));
    } catch {
      reject(sock, 400, 'Bad Request');
    }
  });

  // Where this client reaches the port: UPLOAD_BASE_URL, else the Host it connected with (a tenant behind a proxy
  // device knows the port by its own address). Only ever shown to that same client.
  const uploadBase = (req) => {
    if (cfg.uploadBaseUrl) return cfg.uploadBaseUrl;
    const h = String(req.headers.host || '');
    return /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/.test(h) ? `http://${h}` : null;
  };

  function onConnection(ws, tenant, base) {
    ws.on('error', () => {});
    conns.add(ws);
    const owner = `c${++seq}-${crypto.randomBytes(4).toString('hex')}`;
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const hb = setInterval(() => { if (!alive) return ws.terminate(); alive = false; try { ws.ping(); } catch {} }, HEARTBEAT_MS);
    hb.unref();
    const server = buildServer({ manager, owner, tenant, cfg, policy: policyOf(cfg, tenant), conn: { inflight: 0 }, uploadBase: base });
    ws.on('close', () => {
      clearInterval(hb);
      conns.delete(ws);
      manager.disposeOwner(owner).catch(() => {}); // lease ends with the connection
      server.close().catch(() => {});
    });
    server.connect(new WsTransport(ws)).catch(() => ws.terminate());
  }

  await new Promise((resolve, rej) => { srv.once('error', rej); srv.listen(port, host, () => { srv.off('error', rej); resolve(); }); });

  return {
    port: srv.address().port,
    connections: conns,
    async close() {
      for (const ws of conns) ws.terminate();
      await new Promise((r) => { srv.close(() => r()); srv.closeAllConnections?.(); });
    },
  };
}
