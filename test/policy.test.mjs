// Read-only tokens (policy "ephemeral") and the stdio bridge: policy parsing, the tool list, refusals enforced by the
// server (not just hidden), the lower session cap, and newline-delimited JSON-RPC over bin/bosun-mcp-stdio.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.mjs';
import { EPHEMERAL_TOOLS } from '../src/tools.mjs';
import { startBosun, startPageServer, connect, TOKEN, TOKEN_B } from './helpers.mjs';

const BRIDGE = new URL('../bin/bosun-mcp-stdio.mjs', import.meta.url).pathname;
const GOOD = 'x'.repeat(24);
const TOKEN_E = 'test-token-eeeeeeeeeeeeeeee';

let pages, svc;
before(async () => {
  pages = await startPageServer();
  svc = await startBosun({
    MAX_SESSIONS: '4', BROWSER_TOKENS: `alice:${TOKEN},bob:${TOKEN_B},swarm:${TOKEN_E}`, BROWSER_TOKEN_POLICIES: 'swarm=ephemeral', SAVE_SHOTS: '1',
  });
});
after(async () => { await svc.stop(); await pages.close(); });

test('BROWSER_TOKEN_POLICIES: parsed per tenant, default full, typos and unknown policies refused', () => {
  const env = { BROWSER_TOKENS: `a:${GOOD}1,b:${GOOD}2` };
  assert.equal(loadConfig(env).policies.size, 0);
  const cfg = loadConfig({ ...env, BROWSER_TOKEN_POLICIES: ' b = ephemeral ' });
  assert.equal(cfg.policies.get('b'), 'ephemeral');
  assert.equal(cfg.policies.get('a'), undefined);
  assert.equal(loadConfig({ ...env, BROWSER_TOKEN_POLICIES: 'a=full,b=ephemeral' }).policies.get('a'), 'full');
  assert.equal(loadConfig({ BROWSER_TOKEN: GOOD, BROWSER_TOKEN_POLICIES: 'default=ephemeral' }).policies.get('default'), 'ephemeral');
  assert.throws(() => loadConfig({ ...env, BROWSER_TOKEN_POLICIES: 'c=ephemeral' }), /tenant "c", which has no token/);
  assert.throws(() => loadConfig({ ...env, BROWSER_TOKEN_POLICIES: 'b=readonly' }), /must be one of full, ephemeral/);
  assert.throws(() => loadConfig({ ...env, BROWSER_TOKEN_POLICIES: 'b' }), /<tenant>=<policy>/);
  assert.throws(() => loadConfig({ ...env, BROWSER_TOKEN_POLICIES: 'b=ephemeral,b=full' }), /twice/);
});

test('BROWSER_EPHEMERAL_MAX_SESSIONS: default 2, never above the per-tenant cap', () => {
  assert.equal(loadConfig({}).ephemeralMaxSessions, 2);
  assert.equal(loadConfig({ MAX_SESSIONS: '1' }).ephemeralMaxSessions, 1);
  assert.equal(loadConfig({ BROWSER_EPHEMERAL_MAX_SESSIONS: '3' }).ephemeralMaxSessions, 3);
  assert.throws(() => loadConfig({ BROWSER_EPHEMERAL_MAX_SESSIONS: '4' }), /between 1 and 3/);
  assert.throws(() => loadConfig({ BROWSER_EPHEMERAL_MAX_SESSIONS: '0' }), /between 1/);
});

test('an ephemeral token lists only the ephemeral tools; a full token lists everything', async () => {
  const e = await connect(svc, TOKEN_E);
  const f = await connect(svc, TOKEN);
  try {
    const names = (await e.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...EPHEMERAL_TOOLS].sort());
    assert.equal(e.getServerCapabilities()?.experimental?.mcpl, undefined);
    const full = (await f.listTools()).tools.map((t) => t.name);
    for (const n of ['request_human', 'handoff_wait', 'keepalive_set', 'meeting_join', ...EPHEMERAL_TOOLS]) assert.ok(full.includes(n), n);
  } finally { await e.close(); await f.close(); }
});

test('an ephemeral token is refused every other tool, whatever its arguments', async () => {
  const e = await connect(svc, TOKEN_E);
  try {
    const calls = {
      request_human: { session: 's1', reason: 'captcha' }, handoff_wait: { session: 's1' },
      keepalive_set: { profile: 'p', url: 'https://example.com', logged_in_check: { text: 'x' } }, keepalive_list: {}, keepalive_remove: { profile: 'p' },
      meeting_join: { url: 'https://meet.google.com/abc-defg-hij' }, meeting_status: {}, meeting_chat_read: { meeting_id: 'm' },
      meeting_chat_send: { meeting_id: 'm', text: 'hi' }, meeting_stop_recording: { meeting_id: 'm' }, meeting_leave: { meeting_id: 'm' },
      meeting_recording_delete: { meeting_id: 'm' },
    };
    for (const [name, args] of Object.entries(calls)) {
      for (const a of [args, {}, { bogus: 1 }]) {
        const r = await e.call(name, a);
        assert.ok(r.isError, name);
        assert.match(r.text, /not allowed for this token/, name);
      }
    }
    assert.deepEqual(svc.keepalive.list('swarm'), svc.keepalive.list('nobody')); // nothing was scheduled
  } finally { await e.close(); }
});

test('an ephemeral token cannot open a profile; ephemeral sessions work and leave nothing on disk', async () => {
  const e = await connect(svc, TOKEN_E);
  try {
    for (const profile of ['work', 'x']) {
      const r = await e.call('session_open', { profile });
      assert.ok(r.isError);
      assert.match(r.text, /profiles are not allowed for this token/);
    }
    assert.equal(fs.existsSync(path.join(svc.dataDir, 'profiles', 'swarm')), false);
    // Enforced below the tool layer too.
    await assert.rejects(svc.manager.open({ owner: 'direct', tenant: 'swarm', profile: 'work' }), /profiles are not allowed/);
    await assert.rejects(svc.manager.open({ owner: 'direct', tenant: 'swarm', media: { args: [], env: {} } }), /not allowed for this token/);

    const id = await e.open();
    let r = await e.call('navigate', { session: id, url: `${pages.base}/` });
    assert.ok(!r.isError, r.text);
    r = await e.call('read', { session: id, mode: 'text' });
    assert.match(r.text, /Hello Bosun/);
    r = await e.call('click', { session: id, text: 'next' });
    assert.match(r.text, /Second/);
    r = await e.call('screenshot', { session: id });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /not saved to disk/); // SAVE_SHOTS=1 is ignored for ephemeral tokens
    assert.equal(fs.existsSync(path.join(svc.dataDir, 'shots', 'swarm')), false);
    r = await e.call('sessions');
    assert.equal(r.json()[0].profile, 'ephemeral');
    r = await e.call('session_close', { session: id });
    assert.ok(!r.isError, r.text);
  } finally { await e.close(); }
});

test('an ephemeral tenant has the lower session cap; its sessions close with the connection', async () => {
  const e = await connect(svc, TOKEN_E);
  const e2 = await connect(svc, TOKEN_E);
  try {
    await e.open();
    await e2.open();
    const r = await e.call('session_open');
    assert.ok(r.isError);
    assert.match(r.text, /session limit 2 for this tenant/);
    await e2.close();
    await new Promise((res) => setTimeout(res, 300));
    let n;
    for (let i = 0; i < 100 && (n = svc.manager.tenantUse.get('swarm')) !== 1; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(n, 1);
    await e.open(); // the closed connection's slot is free again
  } finally { await e.close(); }
});

// ---- stdio bridge ----

function bridge(env) {
  const p = spawn(process.execPath, [BRIDGE], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  p.stderr.on('data', (d) => { stderr += d; });
  const lines = [];
  const waiters = [];
  readline.createInterface({ input: p.stdout }).on('line', (l) => { lines.push(l); while (waiters.length) waiters.shift()(); });
  const exited = new Promise((res) => p.on('exit', (code) => res(code)));
  return {
    p, exited, lines, stderr: () => stderr,
    send: (msg) => p.stdin.write(typeof msg === 'string' ? `${msg}\n` : `${JSON.stringify(msg)}\n`),
    // The response to request id.
    async reply(id, ms = 20000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = lines.map((l) => JSON.parse(l)).find((m) => m.id === id);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`no reply to ${id}; stderr: ${stderr}`);
        await new Promise((res) => { waiters.push(res); setTimeout(res, 100); });
      }
    },
  };
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };

test('bridge: newline-delimited JSON-RPC to one WebSocket frame each, both ways', async () => {
  const b = bridge({ BOSUN_URL: svc.wsUrl, BOSUN_TOKEN: TOKEN_E });
  try {
    b.send(INIT);
    const init = await b.reply(1);
    assert.equal(init.result.serverInfo.name, 'bosun');
    b.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    b.send('');            // blank lines are skipped
    b.send('not json {');  // dropped, connection stays up
    b.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await b.reply(2);
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [...EPHEMERAL_TOOLS].sort());
    b.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_open', arguments: { profile: 'work' } } });
    const refused = await b.reply(3);
    assert.ok(refused.result.isError);
    assert.match(refused.result.content[0].text, /profiles are not allowed for this token/);
    // Two requests in one write: two frames, two replies.
    b.p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'sessions', arguments: {} } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' })}\n`);
    assert.deepEqual(JSON.parse((await b.reply(4)).result.content[0].text), []);
    assert.deepEqual((await b.reply(5)).result, {});
    for (const l of b.lines) JSON.parse(l); // every stdout line is one whole message
    assert.match(b.stderr(), /dropped a line that is not JSON/);
    assert.ok(!b.stderr().includes(TOKEN_E));
    b.p.stdin.end();
    assert.equal(await b.exited, 0);
  } finally { b.p.kill(); }
});

test('bridge: a refused token exits 3 with a clear line and never prints the token', async () => {
  const bad = 'wrong-token-wrong-token-wrong';
  const b = bridge({ BOSUN_URL: svc.wsUrl, BOSUN_TOKEN: bad });
  assert.equal(await b.exited, 3);
  assert.match(b.stderr(), /authentication refused .*HTTP 401.*BOSUN_TOKEN/);
  assert.ok(!b.stderr().includes(bad));
  assert.equal(b.lines.length, 0);
});

test('bridge: missing or unsafe configuration exits 2', async () => {
  for (const [env, re] of [
    [{ BOSUN_TOKEN: TOKEN_E }, /BOSUN_URL is not set/],
    [{ BOSUN_URL: svc.wsUrl }, /BOSUN_TOKEN is not set/],
    [{ BOSUN_URL: svc.wsUrl.replace('ws:', 'http:'), BOSUN_TOKEN: TOKEN_E }, /must be ws:\/\/ or wss:\/\//],
    [{ BOSUN_URL: `${svc.wsUrl}/?token=${TOKEN_E}`, BOSUN_TOKEN: TOKEN_E }, /must not carry credentials/],
  ]) {
    const b = bridge(env);
    assert.equal(await b.exited, 2, re.source);
    assert.match(b.stderr(), re);
    assert.ok(!b.stderr().includes(TOKEN_E));
  }
});

test('bridge: exits 1 when the server goes away', async () => {
  const b = bridge({ BOSUN_URL: 'ws://127.0.0.1:1', BOSUN_TOKEN: TOKEN_E });
  assert.equal(await b.exited, 1);
  assert.match(b.stderr(), /connection to ws:\/\/127\.0\.0\.1:1\/ failed/);
});

test('an ephemeral token may use the default engine only', async () => {
  const e = await connect(svc, TOKEN_E);
  try {
    const other = ['chromium', 'patchright', 'camoufox'].find((n) => n !== svc.cfg.engine);
    const r = await e.call('session_open', { engine: other });
    assert.ok(r.isError);
    assert.match(r.text, new RegExp(`engine ${other} is not allowed for this token`));
    await assert.rejects(svc.manager.open({ owner: 'direct', tenant: 'swarm', engine: other }), /not allowed for this token/);
    const id = await e.open({ engine: svc.cfg.engine });
    await e.call('session_close', { session: id });
  } finally { await e.close(); }
});

test('bridge: LF-only framing, CRLF accepted, oversized records dropped without buffering them whole', async () => {
  const b = bridge({ BOSUN_URL: svc.wsUrl, BOSUN_TOKEN: TOKEN_E });
  try {
    b.send(INIT);
    await b.reply(1);
    // A bare CR inside a record does not split it: this record is not JSON as a whole, so it is dropped.
    b.p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' })}\r${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' })}\n`);
    b.p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'ping' })}\r\n`); // CRLF is fine
    assert.deepEqual((await b.reply(12)).result, {});
    // 3 MiB without a newline, in chunks, then a newline and a normal request.
    const chunk = 'x'.repeat(256 * 1024);
    for (let i = 0; i < 12; i++) b.p.stdin.write(chunk);
    b.p.stdin.write(`\n${JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'ping' })}\n`);
    assert.deepEqual((await b.reply(13)).result, {});
    assert.ok(!b.lines.some((l) => [10, 11].includes(JSON.parse(l).id)));
    assert.match(b.stderr(), /dropped a line that is not JSON/);
    assert.match(b.stderr(), /dropped a message over 2 MiB/);
    b.p.stdin.end();
    assert.equal(await b.exited, 0);
  } finally { b.p.kill(); }
});

test('bridge: a server that never completes the handshake times out; stdin EOF before that exits 0', async () => {
  const net = await import('net');
  const socks = [];
  const srv = net.createServer((s) => socks.push(s)); // accepts TCP, never answers the upgrade
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${srv.address().port}`;
  try {
    const eof = bridge({ BOSUN_URL: url, BOSUN_TOKEN: TOKEN_E });
    eof.p.stdin.end();
    assert.equal(await eof.exited, 0);
    // Input piling up before the handshake is bounded.
    const flood = bridge({ BOSUN_URL: url, BOSUN_TOKEN: TOKEN_E });
    const rec = `${JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { pad: 'y'.repeat(512 * 1024) } })}\n`;
    flood.p.stdin.on('error', () => {});
    for (let i = 0; i < 20; i++) flood.p.stdin.write(rec);
    assert.equal(await flood.exited, 1);
    assert.match(flood.stderr(), /more than 8 MiB of input before the connection opened/);
    const t0 = Date.now();
    const hung = bridge({ BOSUN_URL: url, BOSUN_TOKEN: TOKEN_E });
    assert.equal(await hung.exited, 1);
    assert.ok(Date.now() - t0 < 20000);
    assert.match(hung.stderr(), /failed/);
  } finally { for (const s of socks) s.destroy(); srv.close(); }
});
