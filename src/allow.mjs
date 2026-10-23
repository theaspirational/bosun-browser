// Per-tenant host allowlist (BROWSER_TENANT_ALLOW): which hosts a tenant may reach. The patterns are matched
// here; they are enforced in src/proxy.mjs, the per-tenant forward proxy that is the only way out of that tenant's
// browser (so every navigation, redirect hop, subresource, WebSocket and worker request is checked), and, for a
// clearer error before anything is opened, on `navigate` and `keepalive_set`. A tenant without an allowlist is
// unrestricted and gets no proxy (upstream behaviour).
import { TENANT_RE } from './auth.mjs';

// ws/wss are checked with the same rules: a WebSocket is a destination the page chooses just like any request.
const DEFAULT_PORT = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };

// One pattern: "*" (any host), "example.org" (that host, any port), "*.example.org" (any subdomain, any port),
// "example.org:8443" / "127.0.0.1:4848" / "[::1]:4848" (that host on that port only).
export function parseHostPattern(raw) {
  const p = String(raw).trim().toLowerCase();
  if (p === '*') return { any: true, host: '*', wild: false, port: null };
  let host = p, port = null;
  if (p.startsWith('[')) { // bracketed IPv6, optionally with a port
    const j = p.indexOf(']');
    if (j < 1) throw new Error(`host pattern "${raw}" has an unterminated "["`);
    host = p.slice(1, j);
    const rest = p.slice(j + 1);
    if (rest) {
      if (!/^:\d{1,5}$/.test(rest)) throw new Error(`host pattern "${raw}" has no valid port after "]"`);
      port = Number(rest.slice(1));
    }
  } else {
    const j = p.lastIndexOf(':');
    if (j >= 0 && !p.slice(0, j).includes(':')) { // exactly one colon: host:port (an IPv6 address needs brackets)
      if (!/^\d{1,5}$/.test(p.slice(j + 1))) throw new Error(`host pattern "${raw}" has no valid port after ":"`);
      host = p.slice(0, j);
      port = Number(p.slice(j + 1));
    }
  }
  host = host.replace(/\.$/, '');
  const wild = host.startsWith('*.');
  let bare = wild ? host.slice(2) : host;
  if (!bare || bare.includes('*') || /[^a-z0-9.:_-]/.test(bare)) throw new Error(`host pattern "${raw}" must be a host, *.host, host:port or "*"`);
  if (port !== null && (port < 1 || port > 65535)) throw new Error(`host pattern "${raw}" has a port outside 1-65535`);
  // The form a URL gives the same host (what allowsUrl compares against): ::1 for 0:0:0:0:0:0:0:1, ::ffff:7f00:1 for
  // ::ffff:127.0.0.1, 127.0.0.1 for 127.1.
  try { bare = new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}/`).hostname.replace(/^\[|\]$/g, ''); } catch {
    throw new Error(`host pattern "${raw}" is not a valid host`);
  }
  return { any: false, host: bare, wild, port };
}

const matchesHost = (p, host) => (p.wild ? host.endsWith(`.${p.host}`) : host === p.host);

// Does one of the patterns allow this http(s) or ws(s) URL? Anything unparseable, or of another scheme, is not
// allowed here (callers only ask about those schemes; `navigate` refuses the rest already).
export function allowsUrl(patterns, raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (!Object.hasOwn(DEFAULT_PORT, u.protocol)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const port = Number(u.port || DEFAULT_PORT[u.protocol]);
  return patterns.some((p) => p.any || (matchesHost(p, host) && (p.port === null || p.port === port)));
}

// What a denied request is logged as: scheme, host, port and path — never the query or the fragment.
export function blockedTarget(raw) {
  try { const u = new URL(raw); return u.origin + u.pathname; } catch { return '(unparseable URL)'; }
}

// BROWSER_TENANT_ALLOW='ops=*.example.org,127.0.0.1:4848; other=*' -> Map tenant -> patterns[]. Entries are
// separated by ";" (or newlines), hosts within an entry by ",". A named tenant must have a token (except "default",
// which is the tenant of the stdio transport), so a typo cannot leave the intended tenant unrestricted.
export function parseTenantAllow(env, tokens) {
  const out = new Map();
  const tenants = new Set(tokens.map((t) => t.tenant));
  for (const entry of String(env.BROWSER_TENANT_ALLOW || '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf('=');
    if (i < 1) throw new Error('BROWSER_TENANT_ALLOW entries must look like <tenant>=<host>,<host> and be separated by ";"');
    const tenant = entry.slice(0, i).trim();
    const hosts = entry.slice(i + 1).split(',').map((s) => s.trim()).filter(Boolean);
    if (!TENANT_RE.test(tenant)) throw new Error(`BROWSER_TENANT_ALLOW: tenant name "${tenant}" must match ${TENANT_RE}`);
    if (!tenants.has(tenant) && tenant !== 'default') throw new Error(`BROWSER_TENANT_ALLOW names tenant "${tenant}", which has no token`);
    if (out.has(tenant)) throw new Error(`BROWSER_TENANT_ALLOW names tenant "${tenant}" twice`);
    if (!hosts.length) throw new Error(`BROWSER_TENANT_ALLOW: tenant "${tenant}" names no host; remove the entry to leave the tenant unrestricted`);
    try {
      out.set(tenant, hosts.map(parseHostPattern));
    } catch (e) {
      throw new Error(`BROWSER_TENANT_ALLOW, tenant "${tenant}": ${e.message}`);
    }
  }
  return out;
}

// The patterns of a tenant, or null when it has none (unrestricted).
export const allowFor = (cfg, tenant) => cfg.tenantAllow?.get(tenant) ?? null;
