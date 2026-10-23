// Per-tenant forward proxy: where a tenant's host allowlist (BROWSER_TENANT_ALLOW) is enforced.
//
// A tenant that has an allowlist gets one of these, and its browser contexts are launched with Playwright's proxy
// option pointing at it, so the proxy is the browser's only way out. Everything the browser would send arrives here
// as a plain request or a CONNECT — navigations and every redirect hop of them, subresources, fetch/XHR, page and
// worker WebSockets, service-worker fetches, prefetches — and each one is checked against the allowlist before a
// byte leaves the host. Nothing is fulfilled, rewritten or buffered here and TLS is tunnelled rather than
// intercepted, so the browser keeps its own semantics: origins, CORS, cookies and the URL bar are exactly what the
// network said they are.
//
// Hostnames are resolved here, once, and the connection goes to that address. The browser never resolves a proxied
// name itself, so the address the decision was made about is the address that gets used (no DNS rebinding). A name
// that resolves into loopback or a private range is only followed if the allowlist names that address as well.
//
// The listener is on loopback with a random Basic-auth password, so no other local process can use it as an open
// proxy into the tenant's hosts. Denials are logged as host:port, never a path or a query.
import crypto from 'crypto';
import dns from 'dns';
import http from 'http';
import net from 'net';
import { allowsUrl } from './allow.mjs';

const MAX_LOGGED = 50; // distinct denied targets logged per tenant
const MAX_CONNECTIONS = 256; // sockets the browser may hold open through one tenant proxy
const CONNECT_TIMEOUT_MS = 15_000;
const CLOSE_DEADLINE_MS = 5_000; // close(): open tunnels are destroyed, and nothing waits longer than this
const RECENT_DENIALS = 64; // denials kept with their time, so navigate can tell a refusal from a network error
// Headers that belong to one hop and must not be forwarded.
const HOP_BY_HOP = ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const AUTH_REALM = 'Proxy-Authenticate: Basic realm="bosun"';

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const bracketed = (ip) => (net.isIPv6(ip) ? `[${ip}]` : ip);

// "host:port", "[::1]:port" or a bare host -> {host, port}; null if that is not a usable authority.
export function parseAuthority(raw, defaultPort) {
  const s = String(raw || '').trim();
  let host, port;
  if (s.startsWith('[')) {
    const i = s.indexOf(']');
    if (i < 2) return null;
    host = s.slice(1, i);
    if (!net.isIPv6(host.replace(/%.*$/, ''))) return null;
    const rest = s.slice(i + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    port = rest ? Number(rest.slice(1)) : defaultPort;
  } else {
    const i = s.lastIndexOf(':');
    if (i > 0) { host = s.slice(0, i); port = Number(s.slice(i + 1)); } else if (i < 0) { host = s; port = defaultPort; } else return null;
    if (!/^[a-z0-9._-]+$/i.test(host)) return null; // a name or an IPv4 address; IPv6 has to be bracketed
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: host.replace(/\.$/, '').toLowerCase(), port };
}

// Addresses that an allowlist has to name as an address, not as a name: loopback, private, link-local, CGNAT,
// benchmarking, IETF protocol assignments, multicast and the unspecified address, and the IPv6 forms that embed or
// translate to IPv4 (NAT64 64:ff9b::/96 and 64:ff9b:1::/48, 6to4 2002::/16). A name resolving to one of these is
// what DNS rebinding looks like.
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
      || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && c === 0);
  }
  const s = String(ip).toLowerCase().replace(/%.*$/, '');
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('::ffff:')) return net.isIPv4(s.slice(7)) ? isPrivateAddress(s.slice(7)) : true;
  return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || /^64:ff9b:/.test(s) || /^2002:/.test(s);
}

const resolve = (host) => dns.promises.lookup(host, { verbatim: true }).then((r) => r.address);

// What this connection may do: {ip, host, port} to go ahead, or {denied: <reason>}.
export async function resolveTarget(allow, host, port, lookup = resolve) {
  if (!allowsUrl(allow, `http://${bracketed(host)}:${port}`)) return { denied: 'not in the host allowlist' };
  if (net.isIP(host)) return { ip: host, host, port };
  let ip;
  try { ip = await lookup(host); } catch { return { denied: 'could not be resolved' }; }
  if (!net.isIP(ip)) return { denied: 'could not be resolved' };
  // Resolved into a private range: only follow it if the allowlist names that address itself.
  if (isPrivateAddress(ip) && !allowsUrl(allow, `http://${bracketed(ip)}:${port}`)) return { denied: 'resolves into a private address the allowlist does not name' };
  return { ip, host, port };
}

// Starts the proxy for one tenant. Returns Playwright proxy options plus close() and the counters tests look at.
// log is called, not captured: tests replace console.error after the proxy is already running.
export async function startTenantProxy({ tenant, allow, host = '127.0.0.1', log = (...a) => console.error(...a), lookup = resolve }) {
  const username = 'bosun';
  const password = crypto.randomBytes(24).toString('base64url');
  const expected = digest(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  const logged = new Set();
  const stats = { allowed: 0, denied: 0 };
  const recent = []; // [{at, target}] of the latest denials, newest last
  const sockets = new Set(); // every client and upstream socket, so close() can end tunnels too
  const agent = new http.Agent({ keepAlive: true }); // this proxy's own upstream pool for plain http://, closed with it
  let closing = false; // set by close(): nothing new is started, whatever was awaiting when it came
  const track = (sock) => {
    if (sockets.has(sock)) return sock; // a pooled upstream socket is handed to request after request
    sockets.add(sock);
    sock.once('close', () => sockets.delete(sock));
    return sock;
  };

  const authenticated = (req) => {
    const presented = digest(req.headers['proxy-authorization'] || '');
    return crypto.timingSafeEqual(presented, expected);
  };
  const deny = (what, port, reason) => {
    stats.denied++;
    const at = `${bracketed(what)}:${port}`;
    recent.push({ at: Date.now(), target: at });
    if (recent.length > RECENT_DENIALS) recent.shift();
    if (logged.has(at) || logged.size >= MAX_LOGGED) return;
    logged.add(at);
    log(`bosun: tenant ${tenant}: blocked ${at} — ${reason}`);
    if (logged.size === MAX_LOGGED) log(`bosun: tenant ${tenant}: further blocked targets are not logged`);
  };
  // Connects to the address the decision was made about; the name only travels in the request (and in SNI, which
  // the browser sets inside the tunnel).
  const dial = (t) => new Promise((resolve_, reject) => {
    const sock = track(net.connect({ host: t.ip, port: t.port }));
    sock.setTimeout(CONNECT_TIMEOUT_MS, () => sock.destroy(new Error('timeout')));
    sock.once('connect', () => { sock.setTimeout(0); resolve_(sock); });
    sock.once('error', reject);
  });

  // Both halves of a tunnel live and die together, so neither side can leave a socket behind.
  const tunnel = (client, upstream) => {
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.pipe(client);
    client.pipe(upstream);
  };

  const srv = http.createServer();
  srv.maxConnections = MAX_CONNECTIONS;
  srv.on('connection', track);
  srv.on('clientError', (_e, sock) => sock.destroy());

  // Plain http:// requests, in absolute form. Streamed both ways: nothing is held in memory here.
  srv.on('request', async (req, res) => {
    const end = (code, text) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...(code === 407 ? { 'proxy-authenticate': 'Basic realm="bosun"' } : {}) }); res.end(`${text}\n`); };
    if (!authenticated(req)) return end(407, 'proxy authentication required');
    if (!/^http:\/\//i.test(req.url || '')) return end(400, 'this is a forward proxy; only absolute http:// requests and CONNECT are served');
    let u;
    try { u = new URL(req.url); } catch { return end(400, 'malformed request target'); }
    const authority = parseAuthority(u.host, 80);
    if (!authority) return end(400, 'malformed request target');
    const target = await resolveTarget(allow, authority.host, authority.port, lookup);
    if (closing || res.destroyed || req.socket.destroyed) return res.destroy(); // closed or gone while resolving
    if (target.denied) {
      deny(authority.host, authority.port, target.denied);
      return end(403, `${bracketed(authority.host)}:${authority.port} ${target.denied}`);
    }
    stats.allowed++;
    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    const out = http.request({ host: target.ip, port: target.port, path: `${u.pathname}${u.search}`, method: req.method, headers, setHost: false, agent }, (up) => {
      res.writeHead(up.statusCode, up.statusMessage, up.headers);
      up.pipe(res);
    });
    out.on('socket', track);
    out.setTimeout(CONNECT_TIMEOUT_MS, () => out.destroy(new Error('timeout')));
    out.on('error', () => { if (!res.headersSent) end(502, 'upstream failed'); else res.destroy(); });
    res.on('close', () => out.destroy());
    req.pipe(out);
  });

  // CONNECT: TLS, and the way Chromium tunnels every WebSocket (page, worker and service worker alike). A plain
  // TCP tunnel to the address resolved above — no certificate, no interception.
  srv.on('connect', async (req, sock, head) => {
    sock.on('error', () => {});
    const refuse = (line, text) => { try { sock.end(`HTTP/1.1 ${line}\r\nContent-Length: ${Buffer.byteLength(text)}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${text}`); } catch {} };
    if (!authenticated(req)) return refuse(`407 Proxy Authentication Required\r\n${AUTH_REALM}`, 'proxy authentication required');
    const authority = parseAuthority(req.url, 443);
    if (!authority) return refuse('400 Bad Request', 'malformed CONNECT target');
    const target = await resolveTarget(allow, authority.host, authority.port, lookup);
    if (closing || sock.destroyed) return sock.destroy(); // closed or gone while resolving
    if (target.denied) {
      deny(authority.host, authority.port, target.denied);
      return refuse('403 Forbidden', `${bracketed(authority.host)}:${authority.port} ${target.denied}`);
    }
    let up;
    try { up = await dial(target); } catch { return refuse('502 Bad Gateway', 'upstream failed'); }
    stats.allowed++;
    if (closing || sock.destroyed) { sock.destroy(); return up.destroy(); }
    sock.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: bosun\r\n\r\n');
    if (head?.length) up.write(head);
    tunnel(sock, up);
  });

  // An Upgrade sent to the proxy in absolute form (how Firefox-based engines tunnel plain ws://). The request line
  // and headers are replayed to the target; from there on it is a tunnel like CONNECT.
  srv.on('upgrade', async (req, sock, head) => {
    sock.on('error', () => {});
    const refuse = (line, text) => { try { sock.end(`HTTP/1.1 ${line}\r\nContent-Length: ${Buffer.byteLength(text)}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${text}`); } catch {} };
    if (!authenticated(req)) return refuse(`407 Proxy Authentication Required\r\n${AUTH_REALM}`, 'proxy authentication required');
    if (!/^http:\/\//i.test(req.url || '')) return refuse('400 Bad Request', 'only absolute http:// targets are proxied');
    let u;
    try { u = new URL(req.url); } catch { return refuse('400 Bad Request', 'malformed request target'); }
    const authority = parseAuthority(u.host, 80);
    if (!authority) return refuse('400 Bad Request', 'malformed request target');
    const target = await resolveTarget(allow, authority.host, authority.port, lookup);
    if (closing || sock.destroyed) return sock.destroy(); // closed or gone while resolving
    if (target.denied) {
      deny(authority.host, authority.port, target.denied);
      return refuse('403 Forbidden', `${bracketed(authority.host)}:${authority.port} ${target.denied}`);
    }
    let up;
    try { up = await dial(target); } catch { return refuse('502 Bad Gateway', 'upstream failed'); }
    stats.allowed++;
    if (closing || sock.destroyed) { sock.destroy(); return up.destroy(); }
    const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!/^proxy-/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    tunnel(sock, up);
  });

  await new Promise((ok, no) => { srv.once('error', no); srv.listen(0, host, () => { srv.off('error', no); ok(); }); });
  const port = srv.address().port;
  return {
    // Playwright proxy options. bypass "<-loopback>" removes Chromium's built-in exception for localhost and
    // 127.0.0.1, so even those go through the allowlist.
    server: `http://${host}:${port}`,
    username,
    password,
    bypass: '<-loopback>',
    port,
    stats,
    // host:port targets refused since time t (ms), oldest first.
    deniedSince(t) { return recent.filter((d) => d.at >= t).map((d) => d.target); },
    // Stops listening and ends every connection, tunnels included; never waits longer than CLOSE_DEADLINE_MS.
    async close() {
      closing = true;
      const closed = new Promise((r) => srv.close(() => r()));
      agent.destroy();
      srv.closeAllConnections?.();
      for (const sock of sockets) sock.destroy();
      let timer;
      await Promise.race([closed, new Promise((r) => { timer = setTimeout(r, CLOSE_DEADLINE_MS); timer.unref?.(); })]);
      clearTimeout(timer);
    },
  };
}
