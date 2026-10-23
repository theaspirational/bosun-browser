// Service assembly: config -> live view, session manager, transports; idempotent bounded shutdown.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.mjs';
import { policyOf } from './auth.mjs';
import { createLiveView } from './liveview.mjs';
import { SessionManager } from './sessions.mjs';
import { startWsServer } from './wsserver.mjs';
import { buildServer, wall } from './tools.mjs';
import { Keepalive } from './keepalive.mjs';
import { EventBus } from './events.mjs';
import { Meetings } from './meetings/index.mjs';
import { Uploads } from './uploads.mjs';

export async function startService(cfg, { engines, keepalive: kaOpts = {}, meetings: mOpts = {} } = {}) {
  let live = null;
  if (cfg.live) {
    live = createLiveView({ port: cfg.live.port, host: cfg.live.host, baseUrl: cfg.live.baseUrl, ttlMs: cfg.handoffTtlMs });
    await live.listen();
  }
  const manager = new SessionManager(cfg, { live, engines });
  // The default engine (package and browser binary) must be installed; others are checked when a session asks.
  try { await manager.engines.check(cfg.engine, cfg); } catch (e) { await live?.close(); throw e; }
  const events = manager.events = new EventBus();
  let keepalive;
  try {
    keepalive = manager.keepalive = new Keepalive({ cfg, manager, wall, emit: (e) => events.needsHuman(e), onWatch: (e) => events.watchChanged(e), ...kaOpts });
    // FEATURES_MEETINGS=0 switches meetings off: no tools, no handlers, no recordings directory.
    if (cfg.features.meetings) manager.meetings = new Meetings({ cfg, manager, bus: events, ...mOpts });
    // FEATURES_UPLOADS=0: no upload tools, no PUT endpoint, no uploads directory.
    if (cfg.features.uploads) manager.uploads = new Uploads(cfg);
  } catch (e) { await live?.close(); throw e; }
  if (cfg.keepalive) keepalive.start();
  const ws = cfg.ws ? await startWsServer({ cfg, manager }) : null;

  let closing = null;
  const shutdown = () => (closing ??= (async () => {
    // Stop admission first, then tear down handoffs and sessions (each close is deadline-bounded).
    manager.closing = true;
    await Promise.allSettled([keepalive.stop(), manager.meetings?.stop()]);
    await Promise.allSettled([ws?.close(), live?.close()]);
    await manager.closeAll();
    await manager.uploads?.close();
  })());
  return { cfg, live, manager, ws, keepalive, events, meetings: manager.meetings ?? null, uploads: manager.uploads ?? null, shutdown };
}

// The one rejection from inside the browser driver that no caller can catch and that must not end the service:
// Playwright's Firefox driver (camoufox) asserts in FFPage._onWebSocketOpened when a worker opens a WebSocket. It
// belongs to one session's browser, so it is logged and the service keeps serving every other session. Everything
// else, including an error thrown by our own code inside a Playwright event, still ends the process.
const DRIVER_FRAME = /[\\/](?:playwright|patchright)-core[\\/]/;
export const isDriverRejection = (e) => {
  if (!(e instanceof Error) || e.message !== 'Assertion error') return false;
  // Whole lines, so an install path with parentheses in it cannot cut a frame short.
  const [, assertAt = '', caller = ''] = String(e.stack).split('\n');
  return /^\s+at assert \(.*\)$/.test(assertAt) && DRIVER_FRAME.test(assertAt)
    && /^\s+at FFPage\._onWebSocket\w+ \(.*\)$/.test(caller) && DRIVER_FRAME.test(caller);
};

// Installed once per process. Anything that is not that driver rejection ends the process, as Node does by default.
let guarded = false;
export function guardDriverRejections(log = (...a) => console.error(...a)) {
  if (guarded) return;
  guarded = true;
  process.on('unhandledRejection', (e) => {
    if (!isDriverRejection(e)) throw e;
    log(`bosun: browser driver error, ignored (Playwright Firefox driver, worker WebSocket): ${String(e.stack).split('\n').slice(0, 4).join(' | ')}`);
  });
}

export async function main(env = process.env) {
  const cfg = loadConfig(env);
  guardDriverRejections();
  // Never silent: an unsandboxed browser is said out loud at every start.
  if (!cfg.chromiumSandbox && cfg.engine !== 'camoufox') {
    console.error('bosun: WARNING — CHROMIUM_SANDBOX=0: the browser runs without its own sandbox, so a renderer that is compromised by a page lands directly on this user');
  }
  const svc = await startService(cfg);
  const exit = (code) => {
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    svc.shutdown().then(() => process.exit(code), () => process.exit(1));
  };
  process.on('SIGINT', () => exit(0));
  process.on('SIGTERM', () => exit(0));

  if (svc.ws) {
    console.error(`bosun: MCP over WebSocket on ${cfg.ws.host}:${svc.ws.port}${cfg.ws.allowNoToken ? ' (NO AUTH — local development)' : ''}`);
  } else {
    process.stdin.on('close', () => exit(0));
    await buildServer({ manager: svc.manager, owner: 'stdio', tenant: 'default', cfg, policy: policyOf(cfg, 'default') }).connect(new StdioServerTransport());
  }
  if (svc.live) console.error(`bosun: live view on ${cfg.live.host}:${svc.live.port}`);
  return svc;
}
