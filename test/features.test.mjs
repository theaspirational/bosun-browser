// Fork: features that are off by default. Meetings (FEATURES_MEETINGS=0): the tools are not listed and their
// handlers are never wired, and no meeting machinery starts. Engines (FEATURES_ENGINES=chromium): a session can only
// pick chromium, unless the deployment enables more or sets ENGINE to another one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { loadConfig } from '../src/config.mjs';
import { CHROMIUM_ARGS, PROXY_ARGS, createEngines } from '../src/engines.mjs';
import { startBosun, startPageServer, connect, tmpDir } from './helpers.mjs';

const SERVER = new URL('../src/server.mjs', import.meta.url).pathname;

const MEETING_TOOLS = ['meeting_join', 'meeting_status', 'meeting_chat_read', 'meeting_chat_send', 'meeting_stop_recording', 'meeting_leave', 'meeting_recording_delete'];

test('FEATURES_MEETINGS defaults to off and is a 0/1 switch', () => {
  assert.equal(loadConfig({}).features.meetings, false);
  assert.equal(loadConfig({ FEATURES_MEETINGS: '0' }).features.meetings, false);
  assert.equal(loadConfig({ FEATURES_MEETINGS: '' }).features.meetings, false);
  assert.equal(loadConfig({ FEATURES_MEETINGS: '1' }).features.meetings, true);
  assert.throws(() => loadConfig({ FEATURES_MEETINGS: 'yes' }), /FEATURES_MEETINGS must be 0 or 1/);
});

test('FEATURES_ENGINES defaults to chromium only and always includes ENGINE', () => {
  assert.deepEqual(loadConfig({}).engines, ['chromium']);
  assert.deepEqual(loadConfig({ FEATURES_ENGINES: 'chromium' }).engines, ['chromium']);
  assert.deepEqual(loadConfig({ FEATURES_ENGINES: 'camoufox,patchright' }).engines, ['chromium', 'patchright', 'camoufox']);
  assert.deepEqual(loadConfig({ FEATURES_ENGINES: '' }).engines, ['chromium']);
  // An explicitly configured default engine is enabled by that choice.
  assert.deepEqual(loadConfig({ ENGINE: 'patchright' }).engines, ['chromium', 'patchright']);
  assert.throws(() => loadConfig({ FEATURES_ENGINES: 'webkit' }), /FEATURES_ENGINES must be a comma list of chromium, patchright, camoufox/);
});

test('with the fork defaults, meeting tools are absent and only chromium can be opened', async () => {
  const pages = await startPageServer();
  const svc = await startBosun({ FEATURES_MEETINGS: '0', FEATURES_ENGINES: 'chromium', ENGINE: 'chromium' });
  try {
    assert.equal(svc.meetings, null);
    assert.equal(svc.manager.meetings, undefined);
    assert.equal(fs.existsSync(path.join(svc.dataDir, 'recordings')), false); // no recordings directory is created
    const c = await connect(svc);
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const t of MEETING_TOOLS) assert.ok(!names.includes(t), t);
    assert.ok(names.includes('navigate') && names.includes('request_human') && names.includes('keepalive_set'));
    for (const t of MEETING_TOOLS) assert.equal((await c.call(t, {})).isError, true, t); // no handler at all
    // Engines: chromium works, the anti-detect engines are refused by the schema and by the session manager.
    const s = await c.open();
    assert.equal((await c.call('navigate', { session: s, url: `${pages.base}/` })).json().title, 'Home');
    assert.equal((await c.call('session_open', { engine: 'patchright' })).isError, true);
    assert.equal((await c.call('session_open', { engine: 'camoufox' })).isError, true);
    for (const engine of ['patchright', 'camoufox']) {
      await assert.rejects(svc.manager.open({ owner: 'direct', tenant: 'alice', engine }), /is not enabled on this service \(FEATURES_ENGINES\)/);
    }
    const open = (await c.listTools()).tools.find((t) => t.name === 'session_open');
    assert.match(JSON.stringify(open.inputSchema), /"enum":\["chromium"\]/);
    await c.close();
  } finally {
    await svc.stop();
    await pages.close();
  }
});

test('FEATURES_MEETINGS=1 wires the meeting tools again', async () => {
  const svc = await startBosun({ FEATURES_MEETINGS: '1' });
  try {
    assert.ok(svc.meetings);
    const c = await connect(svc);
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const t of MEETING_TOOLS) assert.ok(names.includes(t), t);
    await c.close();
  } finally { await svc.stop(); }
});

// --- Chromium's own sandbox (CHROMIUM_SANDBOX, on by default) ---

// The real chromium definition with a stand-in browser type, so the launch options can be inspected without a
// browser (and a sandbox failure can be simulated on a host where the sandbox works).
const withFakeChromium = (launch) => {
  const real = createEngines().get('chromium');
  return createEngines({ overrides: { chromium: { ...real, load: async () => ({ launch, executablePath: () => '/unused' }) } } });
};

test('CHROMIUM_SANDBOX defaults to on and is a 0/1 switch', () => {
  assert.equal(loadConfig({}).chromiumSandbox, true);
  assert.equal(loadConfig({ CHROMIUM_SANDBOX: '1' }).chromiumSandbox, true);
  assert.equal(loadConfig({ CHROMIUM_SANDBOX: '0' }).chromiumSandbox, false);
  assert.throws(() => loadConfig({ CHROMIUM_SANDBOX: 'off' }), /CHROMIUM_SANDBOX must be 0 or 1/);
});

test('the engine launches Chromium with its sandbox, and refuses downloads by default', async () => {
  const real = createEngines().get('chromium');
  const launchedWith = async (cfg, proxy) => { let o; await real.launchShared({ launch: async (x) => { o = x; return { on() {} }; } }, cfg, proxy); return o; };
  assert.equal((await launchedWith(loadConfig({}))).chromiumSandbox, true);
  assert.equal((await launchedWith(loadConfig({ CHROMIUM_SANDBOX: '0' }))).chromiumSandbox, false);
  const tenantProxy = { server: 'http://127.0.0.1:1', username: 'bosun', password: 'p', bypass: '<-loopback>' };
  // The browser of tenants that are not proxied is launched exactly as upstream launches it — including when some
  // *other* tenant has an allowlist, which is why the flags come from the proxy and not from the configuration.
  for (const cfg of [loadConfig({}), loadConfig({ BROWSER_TOKEN: 'x'.repeat(24), BROWSER_TENANT_ALLOW: 'default=example.org' })]) {
    const plain = await launchedWith(cfg);
    assert.equal(plain.proxy, undefined);
    assert.deepEqual(plain.args, CHROMIUM_ARGS);
  }
  // A browser launched for a proxied tenant gets that proxy, and the flags that keep traffic inside it: no QUIC,
  // and WebRTC may not open UDP of its own.
  const proxied = await launchedWith(loadConfig({}), tenantProxy);
  assert.deepEqual(proxied.proxy, tenantProxy);
  assert.deepEqual(proxied.args, [...CHROMIUM_ARGS, ...PROXY_ARGS]);
  assert.ok(PROXY_ARGS.includes('--disable-quic'));
  assert.ok(PROXY_ARGS.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  let ctxOpts;
  const shared = async () => ({ newContext: async (o) => { ctxOpts = o; return {}; } });
  await real.open({}, { cfg: loadConfig({}), dir: null, locale: 'de-AT', timezone: 'Europe/Vienna', shared });
  assert.equal(ctxOpts.acceptDownloads, false);
  assert.equal(ctxOpts.proxy, undefined);
  // A context gets the tenant's proxy options, and <-loopback> so even loopback goes through them.
  const proxy = { server: 'http://127.0.0.1:1', username: 'bosun', password: 'p', bypass: '<-loopback>' };
  await real.open({}, { cfg: loadConfig({}), dir: null, locale: 'de-AT', timezone: 'Europe/Vienna', shared, proxy });
  assert.deepEqual(ctxOpts.proxy, proxy);
  await real.open({}, { cfg: loadConfig({ DOWNLOADS: '1' }), dir: null, locale: 'de-AT', timezone: 'Europe/Vienna', shared });
  assert.equal(ctxOpts.acceptDownloads, true);
});

test('a sandbox that cannot start stops the service with what the operator has to do', async () => {
  const sandboxFails = withFakeChromium(async () => { throw new Error("Chromium sandboxing failed!\nTo avoid the sandboxing issue, do either of the following:"); });
  await assert.rejects(sandboxFails.check('chromium', loadConfig({ HEADLESS: '1' })), (e) => {
    assert.match(e.message, /engine chromium: Chromium could not start with its own sandbox/);
    assert.match(e.message, /apparmor_restrict_unprivileged_userns=0/);
    assert.match(e.message, /CHROME_DEVEL_SANDBOX/);
    assert.match(e.message, /CHROMIUM_SANDBOX=0/); // the only way out, and it is explicit
    return true;
  });
  // With the sandbox switched off there is no preflight launch at all.
  let launched = false;
  const off = withFakeChromium(async () => { launched = true; return { close: async () => {} }; });
  await off.check('chromium', loadConfig({ HEADLESS: '1', CHROMIUM_SANDBOX: '0' }));
  assert.equal(launched, false);
  // With it on, the preflight launches once (sandboxed) and closes again.
  let opts = null, closed = false;
  const on = withFakeChromium(async (o) => { opts = o; return { close: async () => { closed = true; } }; });
  await on.check('chromium', loadConfig({ HEADLESS: '1' }));
  assert.equal(opts.chromiumSandbox, true);
  assert.equal(closed, true);
});

test('with the sandbox on, the service either runs sandboxed or refuses to start', async () => {
  // This host may not allow unprivileged user namespaces (containers often do not), which is exactly the case that
  // must fail loudly rather than fall back.
  let svc = null;
  try {
    svc = await startBosun({ CHROMIUM_SANDBOX: '1' });
  } catch (e) {
    assert.match(e.message, /Chromium could not start with its own sandbox/);
    assert.match(e.message, /CHROMIUM_SANDBOX=0/);
    return;
  }
  try {
    const c = await connect(svc);
    await c.open(); // a real session on the shared browser
    const renderers = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\n').filter((l) => l.includes('--type=renderer') && l.includes('chrome'));
    assert.ok(renderers.length, 'no renderer process found');
    for (const r of renderers) assert.ok(!r.includes('--no-sandbox'), r.slice(0, 200));
    await c.close();
  } finally { await svc.stop(); }
});

test('CHROMIUM_SANDBOX=0 is said out loud at every start', async () => {
  const err = await new Promise((resolve) => {
    const p = spawn(process.execPath, [SERVER], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || '', BROWSER_DATA: tmpDir(), HEADLESS: '1', WS_PORT: '0', BROWSER_TOKEN: 'x'.repeat(24), CHROMIUM_SANDBOX: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const done = () => { clearTimeout(t); resolve(out); };
    p.stderr.on('data', (d) => { out += d; if (/MCP over WebSocket/.test(out)) p.kill('SIGTERM'); });
    p.on('exit', done);
    const t = setTimeout(() => p.kill('SIGKILL'), 30000);
  });
  assert.match(err, /WARNING — CHROMIUM_SANDBOX=0: the browser runs without its own sandbox/);
  assert.match(err, /MCP over WebSocket/);
});
