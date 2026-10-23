// What a page may write to disk. Downloads are refused unless DOWNLOADS=1; with downloads on, a session keeps
// at most DOWNLOADS_MAX_MB and the service DOWNLOADS_TOTAL_MAX_MB, so a page cannot fill the volume. Built from the
// review's probe (an attachment link that saved 65 kB unasked), driven through the real MCP tools.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { loadConfig } from '../src/config.mjs';
import { startBosun, connect, until, tmpDir, TOKEN } from './helpers.mjs';

const MB = 1024 * 1024;

// A page with an attachment link; /dl?kb= serves that many kibibytes as an attachment.
const server = () => http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/dl') {
    const kb = Number(u.searchParams.get('kb') || 64);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=probe.bin', 'content-length': String(kb * 1024) });
    return res.end(Buffer.alloc(kb * 1024));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<title>Downloads</title><a id="small" href="/dl?kb=64&secret=shh">small</a> <a id="mb" href="/dl?kb=1024">mb</a> <a id="chunk" href="/dl?kb=700">chunk</a>');
});

let srv, base, logs, origError;
before(async () => {
  srv = server();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  logs = [];
  origError = console.error;
  console.error = (...a) => { logs.push(a.join(' ')); };
});
after(async () => {
  console.error = origError;
  await new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); });
});

const budgetLogs = () => logs.filter((l) => l.includes('(download budget)'));

// Clicks a download link through the MCP tools and returns the Download object. Not awaiting failure() here: a
// download the budget deleted has no artifact left to ask.
// A refused download is either cancelled while it runs or, if it was quicker than that (Firefox), deleted: either way
// nothing of it stays on disk.
async function refusedAndGone(d) {
  const failure = String(await d.failure().catch((e) => e.message)); // a deleted artifact cannot be asked any more
  let kept = false;
  try { const p = await d.path(); kept = !!p && fs.existsSync(p); } catch {}
  return /canceled|cancelled/.test(failure) || !kept;
}

async function grab(svc, c, id, selector) {
  const page = svc.manager.sessions.get(id).page;
  const wait = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  const r = await c.call('click', { session: id, selector });
  assert.equal(r.isError, false, r.text);
  const d = await wait;
  assert.ok(d, `no download for ${selector}`);
  return d;
}

test('DOWNLOADS defaults to off and the budget is validated', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.downloads, false);
  assert.equal(cfg.downloadMaxMb, 100);
  assert.equal(cfg.downloadTotalMaxMb, 500);
  assert.equal(loadConfig({ DOWNLOADS: '1' }).downloads, true);
  assert.throws(() => loadConfig({ DOWNLOADS: 'yes' }), /DOWNLOADS must be 0 or 1/);
  assert.equal(loadConfig({ DOWNLOADS_MAX_MB: '2000' }).downloadTotalMaxMb, 2000); // never below the per-session cap
  assert.throws(() => loadConfig({ DOWNLOADS_MAX_MB: '10', DOWNLOADS_TOTAL_MAX_MB: '5' }), /DOWNLOADS_TOTAL_MAX_MB must be between 10/);
  assert.throws(() => loadConfig({ DOWNLOADS_MAX_MB: '0' }), /between 1/);
});

test('by default a page cannot write a download to disk at all', async () => {
  const svc = await startBosun();
  try {
    const c = await connect(svc, TOKEN);
    const id = await c.open();
    await c.call('navigate', { session: id, url: `${base}/` });
    const d = await grab(svc, c, id, '#small');
    assert.match(String(await d.failure()), /acceptDownloads/); // the context refused it
    await assert.rejects(d.path(), /acceptDownloads/);
    assert.equal(svc.manager.sessions.get(id).dlBytes, 0);
    assert.equal(svc.manager.dlBytes, 0);
    await c.close();
  } finally { await svc.stop(); }
});

test('with downloads on, one that would pass the per-session budget is deleted again', async () => {
  const svc = await startBosun({ DOWNLOADS: '1', DOWNLOADS_MAX_MB: '1', DOWNLOADS_TOTAL_MAX_MB: '10' });
  try {
    logs.length = 0;
    const c = await connect(svc, TOKEN);
    const id = await c.open();
    await c.call('navigate', { session: id, url: `${base}/` });
    const first = await grab(svc, c, id, '#chunk'); // 700 KiB, inside the budget
    assert.equal(await first.failure(), null);
    await until(() => svc.manager.sessions.get(id).dlBytes === 700 * 1024, 10000);
    assert.equal(svc.manager.dlBytes, 700 * 1024);
    assert.deepEqual(budgetLogs(), []);
    await grab(svc, c, id, '#chunk'); // 1400 KiB together: over the 1 MB budget
    await until(() => budgetLogs()[0], 10000);
    assert.equal(budgetLogs()[0], `bosun: tenant alice: deleted over-budget download of ${base}/dl (download budget)`);
    assert.equal(svc.manager.sessions.get(id).dlBytes, 700 * 1024, 'only what is kept is counted');
    assert.equal(svc.manager.dlBytes, 700 * 1024);
    await c.close();
  } finally { await svc.stop(); }
});

test('a session that used up its budget has the next download refused before it is written', async () => {
  const svc = await startBosun({ DOWNLOADS: '1', DOWNLOADS_MAX_MB: '1', DOWNLOADS_TOTAL_MAX_MB: '10' });
  try {
    logs.length = 0;
    const c = await connect(svc, TOKEN);
    const id = await c.open();
    await c.call('navigate', { session: id, url: `${base}/` });
    const full = await grab(svc, c, id, '#mb'); // exactly 1 MB: the budget is used up
    assert.equal(await full.failure(), null);
    await until(() => svc.manager.sessions.get(id).dlBytes === MB, 10000);
    const next = await grab(svc, c, id, '#small');
    await until(() => budgetLogs()[0], 10000);
    assert.equal(budgetLogs()[0], `bosun: tenant alice: refused download of ${base}/dl (download budget)`);
    assert.ok(await refusedAndGone(next));
    assert.equal(svc.manager.sessions.get(id).dlBytes, MB);
    assert.ok(!logs.some((l) => l.includes('shh')), logs.join('\n')); // the query is never logged
    await c.close();
  } finally { await svc.stop(); }
});

test('the service-wide budget is shared by the sessions and released when one closes', async () => {
  const svc = await startBosun({ DOWNLOADS: '1', DOWNLOADS_MAX_MB: '1', DOWNLOADS_TOTAL_MAX_MB: '1' });
  try {
    logs.length = 0;
    const c = await connect(svc, TOKEN);
    const a = await c.open();
    await c.call('navigate', { session: a, url: `${base}/` });
    await grab(svc, c, a, '#mb'); // uses the whole service budget
    await until(() => svc.manager.dlBytes === MB, 10000);
    const b = await c.open();
    await c.call('navigate', { session: b, url: `${base}/` });
    const refused = await grab(svc, c, b, '#small');
    await until(() => budgetLogs()[0], 10000);
    assert.ok(await refusedAndGone(refused));
    assert.equal(svc.manager.sessions.get(b).dlBytes, 0);
    // Closing the first session takes its downloads with it, so the budget frees up again.
    await c.call('session_close', { session: a });
    assert.equal(svc.manager.dlBytes, 0);
    await c.close();
  } finally { await svc.stop(); }
});

test('a download that finishes after its session closed is not counted against the service budget', async () => {
  const svc = await startBosun({ DOWNLOADS: '1' });
  try {
    const c = await connect(svc, TOKEN);
    const id = await c.open();
    const s = svc.manager.sessions.get(id);
    const file = path.join(tmpDir(), 'late.bin');
    fs.writeFileSync(file, Buffer.alloc(MB));
    let finish;
    const late = { url: () => `${base}/dl?kb=1024`, path: () => new Promise((r) => { finish = r; }), cancel: async () => {}, delete: async () => {} };
    const counted = svc.manager.onDownload(s, late);
    await c.call('session_close', { session: id });
    finish(file); // the download completes only now, after the session (and its share of the budget) is gone
    await counted;
    assert.equal(s.dlBytes, 0);
    assert.equal(svc.manager.dlBytes, 0);
    await c.close();
  } finally { await svc.stop(); }
});
