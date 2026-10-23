// Environment -> validated configuration. Anything malformed or unsafe throws, so the service refuses to start.
import { isLoopbackHost, parsePolicies, parseTokens } from './auth.mjs';
import { parseTenantAllow } from './allow.mjs';
import { ENGINE_NAMES } from './engines.mjs';

function int(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(String(raw).trim())) throw new Error(`${name} must be a whole number (got "${raw}")`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// A 0/1 switch. Anything else stops the service rather than silently turning a feature on or off.
function flag(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (raw !== '0' && raw !== '1') throw new Error(`${name} must be 0 or 1 (got "${raw}")`);
  return raw === '1';
}

export function loadConfig(env = process.env) {
  const cfg = {
    dataDir: env.BROWSER_DATA || './data',
    headless: env.HEADLESS === '1',
    maxSessions: int(env, 'MAX_SESSIONS', 3, 1, 1000),
    idleTimeoutMs: int(env, 'IDLE_TIMEOUT_SEC', 900, 0, 7 * 86400) * 1000, // 0 = never reap idle sessions
    handoffTtlMs: int(env, 'HANDOFF_TTL_SEC', 900, 10, 86400) * 1000,
    saveShots: env.SAVE_SHOTS === '1',
    shotsPerSession: int(env, 'SHOTS_PER_SESSION', 20, 1, 1000),
    maxInflight: int(env, 'MAX_INFLIGHT', 8, 1, 1000), // concurrent tool calls per connection
    maxPagesPerSession: int(env, 'MAX_PAGES_PER_SESSION', 5, 1, 100),
    maxDomNodes: int(env, 'MAX_DOM_NODES', 60000, 100, 10_000_000),
    engine: env.ENGINE || 'chromium',
    camoufoxOs: env.CAMOUFOX_OS || null, // null: the host's OS
    keepalive: env.KEEPALIVE !== '0', // run scheduled keepalive visits (configured with keepalive_set)
    tz: env.TZ || 'Europe/Vienna', // local time for keepalive quiet_hours
    recordingRetentionDays: int(env, 'RECORDING_RETENTION_DAYS', 30, 1, 3650), // meeting recordings are deleted after this
    meetingOwner: (env.MEETING_OWNER || '').trim().slice(0, 60) || null, // named in the meeting announcement ("X's AI notetaker")
    tokens: parseTokens(env),
    // Features a deployment can switch off. FEATURES_MEETINGS=0: no meeting tools, handlers or recordings directory.
    // FEATURES_UPLOADS=0: no upload tools and no PUT endpoint.
    features: { meetings: flag(env, 'FEATURES_MEETINGS', true), uploads: flag(env, 'FEATURES_UPLOADS', true) },
    // Chromium's own sandbox. On by default: a renderer that runs untrusted web content must not sit directly on the
    // service user. 0 is an explicit, logged choice (see README > Chromium sandbox).
    chromiumSandbox: flag(env, 'CHROMIUM_SANDBOX', true),
    // Downloads a page starts. Off by default: nothing a page fetches is written to disk.
    downloads: flag(env, 'DOWNLOADS', false),
    engines: null, // engines a session may choose
    tenantAllow: null, // tenant -> host patterns (per-tenant host allowlist, BROWSER_TENANT_ALLOW)
    policies: null,
    ws: null,
    live: null,
  };
  if (!ENGINE_NAMES.includes(cfg.engine)) throw new Error(`ENGINE must be one of ${ENGINE_NAMES.join(', ')} (got "${cfg.engine}")`);
  try { new Intl.DateTimeFormat('en', { timeZone: cfg.tz }); } catch { throw new Error(`TZ must be an IANA time zone such as Europe/Vienna (got "${cfg.tz}")`); }
  if (cfg.camoufoxOs && !['macos', 'windows', 'linux'].includes(cfg.camoufoxOs)) throw new Error('CAMOUFOX_OS must be macos, windows or linux');
  // Engines a session may ask for: FEATURES_ENGINES (default: all of them), plus the configured default engine.
  const wanted = env.FEATURES_ENGINES ? list(env.FEATURES_ENGINES) : ENGINE_NAMES;
  for (const e of wanted) if (!ENGINE_NAMES.includes(e)) throw new Error(`FEATURES_ENGINES must be a comma list of ${ENGINE_NAMES.join(', ')} (got "${e}")`);
  cfg.engines = ENGINE_NAMES.filter((e) => e === cfg.engine || wanted.includes(e));
  cfg.tenantAllow = parseTenantAllow(env, cfg.tokens);
  // Disk budget for downloads (only when DOWNLOADS=1): per session, and across all sessions.
  cfg.downloadMaxMb = int(env, 'DOWNLOADS_MAX_MB', 100, 1, 1_000_000);
  cfg.downloadTotalMaxMb = int(env, 'DOWNLOADS_TOTAL_MAX_MB', Math.max(500, cfg.downloadMaxMb), cfg.downloadMaxMb, 10_000_000);
  // File uploads into pages: the largest file, what one tenant may hold at a time, how long a file is kept and how
  // long an upload URL stays valid. UPLOAD_BASE_URL: where tenants reach the MCP port, when the Host header they
  // connect with is not it (TLS in front, another name).
  cfg.uploadMaxBytes = int(env, 'UPLOAD_MAX_BYTES', 300 * 1024 * 1024, 1, 1024 ** 4);
  cfg.uploadQuotaBytes = int(env, 'UPLOAD_TENANT_QUOTA_BYTES', Math.max(1024 ** 3, cfg.uploadMaxBytes), cfg.uploadMaxBytes, 1024 ** 5);
  cfg.uploadTtlMs = int(env, 'UPLOAD_TTL_SEC', 3600, 10, 7 * 86400) * 1000;
  cfg.uploadUrlTtlMs = int(env, 'UPLOAD_URL_TTL_SEC', 900, 10, 86400) * 1000;
  cfg.uploadBaseUrl = null;
  if (env.UPLOAD_BASE_URL) {
    let u;
    try { u = new URL(env.UPLOAD_BASE_URL); } catch { throw new Error('UPLOAD_BASE_URL is not a valid URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('UPLOAD_BASE_URL must be http(s)');
    cfg.uploadBaseUrl = u.href.replace(/\/+$/, '');
  }
  cfg.maxSessionsPerTenant = int(env, 'MAX_SESSIONS_PER_TENANT', cfg.maxSessions, 1, cfg.maxSessions);
  cfg.policies = parsePolicies(env, cfg.tokens);
  // Session cap of each tenant with policy "ephemeral".
  cfg.ephemeralMaxSessions = int(env, 'BROWSER_EPHEMERAL_MAX_SESSIONS', Math.min(2, cfg.maxSessionsPerTenant), 1, cfg.maxSessionsPerTenant);

  if (env.WS_PORT !== undefined && env.WS_PORT !== '') {
    const host = env.WS_HOST || '127.0.0.1';
    cfg.ws = {
      host,
      port: int(env, 'WS_PORT', 0, 0, 65535),
      maxConnections: int(env, 'MAX_CONNECTIONS', 32, 1, 10000),
      allowedOrigins: list(env.WS_ALLOWED_ORIGINS),
      allowNoToken: false,
    };
    if (!cfg.tokens.length) {
      if (!isLoopbackHost(host)) throw new Error(`refusing to listen on ${host} without BROWSER_TOKEN (or BROWSER_TOKENS)`);
      if (env.ALLOW_NO_TOKEN !== '1') throw new Error('set BROWSER_TOKEN, or ALLOW_NO_TOKEN=1 for unauthenticated local development on loopback');
      cfg.ws.allowNoToken = true;
    }
  }

  if (env.LIVE_PORT !== undefined && env.LIVE_PORT !== '') {
    const host = env.LIVE_HOST || '127.0.0.1';
    const port = int(env, 'LIVE_PORT', 0, 0, 65535);
    const baseUrl = env.LIVE_BASE_URL || null; // null: derived from the bound address
    if (baseUrl) {
      let u;
      try { u = new URL(baseUrl); } catch { throw new Error('LIVE_BASE_URL is not a valid URL'); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('LIVE_BASE_URL must be http(s)');
    }
    cfg.live = { host, port, baseUrl };
  }
  return cfg;
}
