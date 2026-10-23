// Keepalive: schedule, lock handling, the visit itself (activity, check), events, persistence, close->reopen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { startBosun, connect, until, tmpDir, sleep } from './helpers.mjs';
import { nextRun, evaluateCheck, Keepalive, HISTORY } from '../src/keepalive.mjs';

// A site with a cookie login. /app shows the account when logged in, else redirects to /signin. The page reports
// pointer activity back to the server, so the test can see what the visit did.
function startSite() {
  const seen = { app: 0, move: 0, wheel: 0, click: 0, key: 0 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const cookie = req.headers.cookie || '';
    const html = (b, h = {}) => { res.writeHead(200, { 'content-type': 'text/html', ...h }); res.end(b); };
    if (u.pathname === '/do-login') return html('<title>ok</title>logged in', { 'set-cookie': 'sid=alice; Path=/; Max-Age=86400' });
    if (u.pathname === '/do-logout') return html('<title>bye</title>', { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
    if (u.pathname === '/t') { for (const k of Object.keys(seen)) if (u.searchParams.has(k)) seen[k] += Number(u.searchParams.get(k)); res.writeHead(204); return res.end(); }
    if (u.pathname === '/signin') return html('<title>Sign in</title><form><input name="user"><input type="password"></form>');
    if (u.pathname === '/slow') return; // never answers
    if (u.pathname === '/challenge') return html('<title>Just a moment...</title><p>Checking your browser</p>');
    if (u.pathname === '/app') {
      seen.app++;
      if (!cookie.includes('sid=alice')) { res.writeHead(302, { location: '/signin' }); return res.end(); }
      return html(`<title>App</title><nav><a href="/app/settings">Settings</a> <a href="/app/inbox">Inbox</a> <span id="who">Signed in as alice</span></nav>
        ${'<p>Lorem ipsum dolor sit amet, a long page to scroll through.</p>'.repeat(200)}
        <script>const n = { move: 0, wheel: 0, click: 0, key: 0 };
        addEventListener('mousemove', () => n.move++); addEventListener('wheel', () => n.wheel++);
        addEventListener('click', () => n.click++); addEventListener('keydown', () => n.key++);
        setInterval(() => { const q = Object.entries(n).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join('&'); if (q) { fetch('/t?' + q); for (const k in n) n[k] = 0; } }, 100);</script>`);
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((d) => { srv.close(d); srv.closeAllConnections(); }) })));
}

let site;
before(async () => { site = await startSite(); });
after(async () => { await site.close(); });

const FAST = { tickMs: 3_600_000, gapMs: [0, 0], activityMs: [1500, 2000] };
let seq = 0;
const rnd = () => { seq = (seq * 9301 + 49297) % 233280; return seq / 233280; };

async function withService(fn, { env = {}, keepalive = {}, dataDir } = {}) {
  const events = [];
  const svc = await startBosun({ KEEPALIVE: '0', ...(dataDir ? { BROWSER_DATA: dataDir } : {}), ...env }, { keepalive: { ...FAST, ...keepalive } });
  svc.events.on('needs-human', (e) => events.push(e));
  try { return await fn(svc, events); } finally { if (dataDir) { await svc.shutdown(); } else await svc.stop(); }
}

// Log the profile in once, as an agent would (with a human), and close it.
async function loggedInProfile(svc, profile = 'shop') {
  const c = await connect(svc);
  const s = await c.open({ profile });
  assert.equal((await c.call('navigate', { session: s, url: `${site.base}/do-login` })).isError, false);
  await c.call('session_close', { session: s });
  return c;
}

const due = (svc, profile = 'shop', tenant = 'alice') => { svc.keepalive.store.entries.get(`${tenant}/${profile}`).nextAt = Date.now() - 1000; };

test('nextRun: every_hours ± jitter, never closer than 15 min', () => {
  const t = Date.UTC(2026, 9, 19);
  assert.equal(nextRun(t, { everyHours: 12, jitterMin: 30 }, () => 0.5), t + 12 * 3_600_000);
  assert.equal(nextRun(t, { everyHours: 12, jitterMin: 30 }, () => 0), t + 12 * 3_600_000 - 30 * 60_000);
  assert.equal(nextRun(t, { everyHours: 12, jitterMin: 30 }, () => 1), t + 12 * 3_600_000 + 30 * 60_000);
  assert.equal(nextRun(t, { everyHours: 1, jitterMin: 0 }, Math.random), t + 3_600_000);
  const many = Array.from({ length: 500 }, () => nextRun(t, { everyHours: 6, jitterMin: 45 }) - t);
  assert.ok(many.every((d) => d >= 6 * 3_600_000 - 45 * 60_000 && d <= 6 * 3_600_000 + 45 * 60_000));
  assert.ok(new Set(many).size > 400); // spread, not all at the same minute
  assert.equal(nextRun(t, { everyHours: 1, jitterMin: 60 }, () => 0), t + 15 * 60_000); // floor
});

test('keepalive_set validates, schedules the first visit a period ahead, and the tools are per tenant', async () => {
  await withService(async (svc) => {
    const c = await loggedInProfile(svc);
    const bad = [
      [{ profile: 'nope', url: `${site.base}/app`, logged_in_check: { text: 'x' } }, /no profile nope/],
      [{ profile: 'shop', url: 'file:///etc/passwd', logged_in_check: { text: 'x' } }, /http/],
      [{ profile: 'shop', url: `${site.base}/app`, logged_in_check: {} }, /logged_in_check needs/],
      [{ profile: 'shop', url: `${site.base}/app`, every_hours: 0, logged_in_check: { text: 'x' } }, /every_hours|>=1|too_small/i],
      [{ profile: 'shop', url: `${site.base}/app`, every_hours: 1, jitter_min: 31, logged_in_check: { text: 'x' } }, /jitter_min must be at most half/],
    ];
    for (const [args, re] of bad) assert.match((await c.call('keepalive_set', args)).text, re, JSON.stringify(args));
    const t0 = Date.now();
    const r = await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/app`, logged_in_check: { text: 'Signed in as' } });
    assert.equal(r.isError, false, r.text);
    const v = r.json();
    assert.deepEqual([v.every_hours, v.jitter_min, v.enabled, v.last], [12, 30, true, []]);
    const next = Date.parse(v.next_run) - t0;
    assert.ok(next >= 11.5 * 3_600_000 - 1000 && next <= 12.5 * 3_600_000 + 1000, String(next));
    // Another tenant sees nothing and can't remove it.
    const { TOKEN_B } = await import('./helpers.mjs');
    const b = await connect(svc, TOKEN_B);
    assert.deepEqual((await b.call('keepalive_list')).json(), []);
    assert.match((await b.call('keepalive_remove', { profile: 'shop' })).text, /no keepalive for profile shop/);
    assert.equal((await c.call('keepalive_list')).json().length, 1);
    assert.deepEqual((await c.call('keepalive_remove', { profile: 'shop' })).json(), { removed: 'shop' });
    assert.deepEqual((await c.call('keepalive_list')).json(), []);
    await b.close();
    await c.close();
  });
});

test('a visit: loads the page, moves the mouse and scrolls (no clicks, typing or navigation), checks, closes, records ok', async () => {
  await withService(async (svc, events) => {
    const c = await loggedInProfile(svc);
    await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/app`, logged_in_check: { text: 'Signed in as', selector: '#who', url_not_contains: '/signin' } });
    due(svc);
    const before = { ...site.seen };
    const used = svc.manager.used;
    const r = await svc.keepalive.tick();
    assert.equal(r.status, 'ok', JSON.stringify(r));
    await sleep(200);
    assert.equal(site.seen.app - before.app, 1); // one page load, no navigation
    assert.ok(site.seen.move - before.move >= 10, `moves ${site.seen.move - before.move}`);
    assert.ok(site.seen.wheel - before.wheel >= 1);
    assert.equal(site.seen.click - before.click, 0);
    assert.equal(site.seen.key - before.key, 0);
    assert.equal(svc.manager.used, used); // the session is closed again
    assert.equal(svc.manager.profilesInUse.size, 0);
    const [v] = (await c.call('keepalive_list')).json();
    assert.equal(v.last.length, 1);
    assert.equal(v.last[0].status, 'ok');
    assert.ok(v.last[0].duration_ms >= 1500);
    assert.ok(Date.parse(v.next_run) > Date.now() + 11 * 3_600_000);
    assert.deepEqual(events, []);
    // The agent can open the profile right away and is still logged in.
    const s = await c.open({ profile: 'shop' });
    await c.call('navigate', { session: s, url: `${site.base}/app` });
    assert.match((await c.call('read', { session: s, mode: 'text' })).text, /Signed in as alice/);
    await c.close();
  });
});

test('logged out: recorded, a needs-human event with profile/url/reason, nothing from the page, no retry', async () => {
  await withService(async (svc, events) => {
    const c = await loggedInProfile(svc);
    const s = await c.open({ profile: 'shop' });
    await c.call('navigate', { session: s, url: `${site.base}/do-logout` });
    await c.call('session_close', { session: s });
    await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/app`, logged_in_check: { url_not_contains: '/signin' } });
    due(svc);
    assert.equal((await svc.keepalive.tick()).status, 'logged_out');
    assert.deepEqual(events, [{ tenant: 'alice', profile: 'shop', url: `${site.base}/app`, kind: 'logged_out', reason: 'url contains url_not_contains' }]);
    const [v] = (await c.call('keepalive_list')).json();
    assert.equal(v.last[0].status, 'logged_out');
    assert.ok(!JSON.stringify(v).includes('Sign in')); // no page content kept
    assert.equal(await svc.keepalive.tick(), null); // not due again until the next period
    assert.ok(Date.parse(v.next_run) > Date.now() + 11 * 3_600_000);
    // The text check reports the same way.
    await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/app`, logged_in_check: { text: 'Signed in as' } });
    due(svc);
    assert.deepEqual(await svc.keepalive.tick(), { status: 'logged_out', reason: 'text not found' });
    await c.close();
  });
});

test('a bot check is reported as needs-human too', async () => {
  await withService(async (svc, events) => {
    const c = await loggedInProfile(svc);
    await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/challenge`, logged_in_check: { text: 'Signed in as' } });
    due(svc);
    assert.equal((await svc.keepalive.tick()).status, 'bot_check');
    assert.equal(events[0].kind, 'bot_check');
    await c.close();
  });
});

test('skipped while an agent has the profile open (next visit a period later), postponed at the session limit', async () => {
  await withService(async (svc) => {
    const c = await loggedInProfile(svc);
    await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/app`, logged_in_check: { text: 'Signed in as' } });
    const s = await c.open({ profile: 'shop' });
    due(svc);
    assert.deepEqual(await svc.keepalive.tick(), { skipped: 'profile in use' });
    let [v] = (await c.call('keepalive_list')).json();
    assert.equal(v.last_skip.reason, 'profile in use');
    assert.deepEqual(v.last, []);
    assert.ok(Date.parse(v.next_run) > Date.now() + 11 * 3_600_000);
    await c.call('session_close', { session: s });
    // Session limit: MAX_SESSIONS_PER_TENANT=2 here; one ephemeral session leaves only the slot kept for agents.
    const e = await c.open();
    due(svc);
    assert.deepEqual(await svc.keepalive.tick(), { skipped: 'session limit reached' });
    [v] = (await c.call('keepalive_list')).json();
    const wait = Date.parse(v.next_run) - Date.now();
    assert.ok(wait >= 9 * 60_000 && wait <= 21 * 60_000, String(wait));
    await c.call('session_close', { session: e });
    await c.close();
  }, { env: { MAX_SESSIONS_PER_TENANT: '2' } });
});

test('an agent opening the profile during a visit takes it over at once', async () => {
  await withService(async (svc) => {
    const c = await loggedInProfile(svc);
    await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/app`, logged_in_check: { text: 'Signed in as' } });
    due(svc);
    const visit = svc.keepalive.tick();
    await until(() => svc.manager.profilesInUse.has('alice/shop') && svc.keepalive.current?.session);
    await sleep(500); // mid-activity
    const t0 = Date.now();
    const s = await c.open({ profile: 'shop' });
    assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`); // not the rest of the 30 s activity
    assert.deepEqual(await visit, { status: 'aborted' });
    const [v] = (await c.call('keepalive_list')).json();
    assert.equal(v.last_skip.reason, 'taken over by an agent');
    assert.deepEqual(v.last, []);
    await c.call('navigate', { session: s, url: `${site.base}/app` });
    assert.match((await c.call('read', { session: s, mode: 'text' })).text, /Signed in as alice/);
    await c.close();
  }, { keepalive: { activityMs: [30_000, 30_000] } });
});

test('visits are spread: one at a time, gapMs apart', async () => {
  await withService(async (svc) => {
    const c = await loggedInProfile(svc, 'a');
    (await loggedInProfile(svc, 'b')).close();
    for (const p of ['a', 'b']) await c.call('keepalive_set', { profile: p, url: `${site.base}/app`, logged_in_check: { text: 'Signed in as' } });
    due(svc, 'a'); due(svc, 'b');
    const first = svc.keepalive.tick();
    assert.equal(await svc.keepalive.tick(), null); // one is running
    assert.equal((await first).status, 'ok');
    assert.equal(await svc.keepalive.tick(), null); // gap
    svc.keepalive.notBefore = 0;
    assert.equal((await svc.keepalive.tick()).status, 'ok');
    await c.close();
  }, { keepalive: { gapMs: [3_600_000, 3_600_000] } });
});

test('configuration and results survive a restart; the file is private', async () => {
  const dataDir = tmpDir();
  try {
    await withService(async (svc) => {
      const c = await loggedInProfile(svc);
      await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/app`, every_hours: 6, jitter_min: 10, logged_in_check: { text: 'Signed in as' } });
      due(svc);
      assert.equal((await svc.keepalive.tick()).status, 'ok');
      await c.close();
    }, { dataDir });
    const file = path.join(dataDir, 'keepalive.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('Lorem'));
    await withService(async (svc) => {
      const c = await connect(svc);
      const [v] = (await c.call('keepalive_list')).json();
      assert.deepEqual([v.profile, v.every_hours, v.jitter_min, v.logged_in_check, v.last[0].status], ['shop', 6, 10, { text: 'Signed in as' }, 'ok']);
      due(svc);
      assert.equal((await svc.keepalive.tick()).status, 'ok'); // and it keeps running after the restart
      assert.equal((await c.call('keepalive_list')).json()[0].last.length, 2);
      await c.close();
    }, { dataDir });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('history is bounded', async () => {
  await withService(async (svc) => {
    const c = await loggedInProfile(svc);
    await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/signin`, logged_in_check: { text: 'x' } });
    const e = svc.keepalive.store.entries.get('alice/shop');
    e.history = Array.from({ length: HISTORY }, (_, i) => ({ at: i, status: 'ok', durationMs: 1 }));
    due(svc);
    assert.equal((await svc.keepalive.tick()).status, 'logged_out');
    assert.equal(e.history.length, HISTORY);
    await c.close();
  });
});

test('a profile used headful is never visited headless; it is visited with its recorded engine', { skip: process.env.TEST_HEADFUL === '1' && 'needs a headless service' }, async () => {
  await withService(async (svc) => {
    const c = await loggedInProfile(svc);
    await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/app`, logged_in_check: { text: 'Signed in as' } });
    const metaFile = path.join(svc.dataDir, 'profiles', 'alice', 'shop', 'bosun-profile.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    assert.equal(meta.headless, true);
    assert.equal(meta.engine, svc.cfg.engine);
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, headless: false }));
    due(svc);
    const r = await svc.keepalive.tick();
    assert.equal(r.status, 'error');
    assert.match(r.reason, /used headful; keepalive will not open it headless/);
    assert.equal(svc.manager.used, 0); // never opened
    await c.close();
  });
});

test('evaluateCheck: each condition, all must hold', async () => {
  const page = (url, visible) => ({
    url: () => url,
    locator: (sel) => ({ first: () => ({ waitFor: async () => { if (!visible.includes(sel)) throw new Error('timeout'); } }) }),
    getByText: (t) => ({ first: () => ({ waitFor: async () => { if (!visible.includes(t)) throw new Error('timeout'); } }) }),
  });
  assert.deepEqual(await evaluateCheck(page('https://x/app', ['#who', 'Hi']), { selector: '#who', text: 'Hi', url_not_contains: 'login' }), { ok: true });
  assert.deepEqual(await evaluateCheck(page('https://x/login?next=app', ['#who']), { url_not_contains: 'login', selector: '#who' }), { ok: false, reason: 'url contains url_not_contains' });
  assert.deepEqual(await evaluateCheck(page('https://x/app', []), { selector: '#who' }), { ok: false, reason: 'selector not visible' });
  assert.deepEqual(await evaluateCheck(page('https://x/app', ['#who']), { selector: '#who', text: 'Hi' }), { ok: false, reason: 'text not found' });
});

test('closing a profile session and opening it again at once works (incl. after a dropped connection)', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    for (let i = 0; i < 2; i++) {
      const s = await c.open({ profile: 'again' });
      await c.call('session_close', { session: s });
    }
    await c.open({ profile: 'again' });
    await c.close(); // the connection drops; its session is still closing
    const c2 = await connect(svc);
    const r = await c2.call('session_open', { profile: 'again' });
    assert.equal(r.isError, false, r.text);
    await c2.close();
  });
});

test('the store refuses a corrupt file instead of silently dropping schedules', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'keepalive.json'), '{oops');
  assert.throws(() => new Keepalive({ cfg: { dataDir: dir }, manager: {} }), /keepalive: cannot read/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an open waiting for a closing profile closes itself if its connection drops meanwhile', async () => {
  await withService(async (svc) => {
    const m = svc.manager;
    let release;
    m.profilesInUse.add('alice/w');
    m.closingProfiles.set('alice/w', new Promise((r) => { release = r; }));
    const c = await connect(svc);
    const p = c.call('session_open', { profile: 'w' });
    await sleep(200);
    await c.close(); // gone while the open waits
    await sleep(200);
    m.profilesInUse.delete('alice/w');
    m.closingProfiles.delete('alice/w');
    release();
    await p;
    await until(() => m.pendingOpens.size === 0 && m.disposals.size === 0);
    assert.equal(m.sessions.size, 0);
    assert.equal(m.used, 0);
    assert.ok(!m.profilesInUse.has('alice/w'));
  });
});

test('shutdown during a visit stuck in navigation is quick', async () => {
  await withService(async (svc) => {
    const c = await loggedInProfile(svc);
    await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/slow`, logged_in_check: { text: 'x' } });
    due(svc);
    const visit = svc.keepalive.tick();
    await until(() => svc.keepalive.current?.session);
    await sleep(300);
    const t0 = Date.now();
    await c.close();
    await svc.shutdown();
    assert.ok(Date.now() - t0 < 15_000, `shutdown took ${Date.now() - t0} ms`);
    assert.equal((await visit).status, 'aborted');
    assert.equal(svc.manager.sessions.size, 0);
  });
});

test('failures are stored as categories, never as browser error text', async () => {
  await withService(async (svc) => {
    const c = await loggedInProfile(svc);
    await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/app`, logged_in_check: { text: 'Signed in as' } });
    svc.keepalive.wall = async () => { throw new Error('evaluate: Error: SECRET-4711 from the page'); };
    due(svc);
    assert.deepEqual(await svc.keepalive.tick(), { status: 'error', reason: 'activity failed' });
    await c.call('keepalive_set', { profile: 'shop', url: 'http://127.0.0.1:1/app', logged_in_check: { text: 'x' } });
    svc.keepalive.wall = async () => null;
    due(svc);
    const r = await svc.keepalive.tick();
    assert.equal(r.status, 'error');
    assert.match(r.reason, /^navigation failed( \((net::ERR|NS_ERROR)_[A-Z_]+\))?$/);
    const list = JSON.stringify((await c.call('keepalive_list')).json());
    assert.ok(!list.includes('SECRET-4711'));
    assert.ok(!fs.readFileSync(path.join(svc.dataDir, 'keepalive.json'), 'utf8').includes('SECRET-4711'));
    await c.close();
  });
});

test('keepalive_set while a visit runs: the result lands on the entry and the next visit is a period later', async () => {
  await withService(async (svc) => {
    const c = await loggedInProfile(svc);
    await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/app`, logged_in_check: { text: 'Signed in as' } });
    due(svc);
    const visit = svc.keepalive.tick();
    await until(() => svc.keepalive.current?.session);
    await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/app?v=2`, logged_in_check: { text: 'Signed in as' } }); // same schedule
    assert.equal((await visit).status, 'ok');
    const [v] = (await c.call('keepalive_list')).json();
    assert.equal(v.url, `${site.base}/app?v=2`);
    assert.equal(v.last.length, 1);
    assert.ok(Date.parse(v.next_run) > Date.now() + 11 * 3_600_000);
    svc.keepalive.notBefore = 0;
    assert.equal(await svc.keepalive.tick(), null);
    await c.close();
  });
});

test('a failed save still raises the event, is reported, and is retried', async () => {
  await withService(async (svc, events) => {
    const c = await loggedInProfile(svc);
    await c.call('keepalive_set', { profile: 'shop', url: `${site.base}/app`, logged_in_check: { text: 'nope' } });
    const store = svc.keepalive.store;
    const file = store.file;
    store.file = path.join(svc.dataDir, 'missing-dir', 'keepalive.json');
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      due(svc);
      assert.equal((await svc.keepalive.tick()).status, 'logged_out');
    } finally { console.error = orig; }
    assert.equal(events.length, 1);
    assert.match(errors.join('\n'), /bosun keepalive: cannot save .*ENOENT/);
    assert.equal(store.dirty, true);
    store.file = file;
    await svc.keepalive.tick(); // retries the save
    assert.equal(store.dirty, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries[0].history.at(-1).status, 'logged_out');
    await c.close();
  });
});
