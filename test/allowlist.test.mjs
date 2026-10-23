// The per-tenant host allowlist (BROWSER_TENANT_ALLOW). Pattern parsing and matching, enforcement on navigate and on
// keepalive_set, and enforcement on the requests a page makes by itself (through the tenant's forward proxy),
// including a navigation the page starts. A tenant without an allowlist is unrestricted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { allowsUrl, parseHostPattern, parseTenantAllow } from '../src/allow.mjs';
import { startBosun, startPageServer, connect, until, TOKEN, TOKEN_B } from './helpers.mjs';

const GOOD = 'x'.repeat(24);
const TOKENS = { BROWSER_TOKENS: `a:${GOOD}1,b:${GOOD}2` };
const tokens = [{ tenant: 'a', token: `${GOOD}1` }, { tenant: 'b', token: `${GOOD}2` }];
const patterns = (spec) => parseTenantAllow({ BROWSER_TENANT_ALLOW: `a=${spec}` }, tokens).get('a');

test('BROWSER_TENANT_ALLOW: parsed per tenant, ";" between tenants, "," between hosts', () => {
  assert.equal(loadConfig(TOKENS).tenantAllow.size, 0);
  const cfg = loadConfig({ ...TOKENS, BROWSER_TENANT_ALLOW: ' a = *.example.org , 127.0.0.1:4848 ; b=* ' });
  assert.deepEqual(cfg.tenantAllow.get('a'), [
    { any: false, host: 'example.org', wild: true, port: null },
    { any: false, host: '127.0.0.1', wild: false, port: 4848 },
  ]);
  assert.deepEqual(cfg.tenantAllow.get('b'), [{ any: true, host: '*', wild: false, port: null }]);
  assert.equal(cfg.tenantAllow.get('c'), undefined);
  // The tenant of the stdio transport needs no token; anything else must have one.
  assert.equal(loadConfig({ BROWSER_TENANT_ALLOW: 'default=example.org' }).tenantAllow.get('default').length, 1);
  assert.throws(() => loadConfig({ ...TOKENS, BROWSER_TENANT_ALLOW: 'c=example.org' }), /names tenant "c", which has no token/);
  assert.throws(() => loadConfig({ ...TOKENS, BROWSER_TENANT_ALLOW: 'a=example.org;a=other.example.org' }), /names tenant "a" twice/);
  assert.throws(() => loadConfig({ ...TOKENS, BROWSER_TENANT_ALLOW: 'a=' }), /names no host/);
  assert.throws(() => loadConfig({ ...TOKENS, BROWSER_TENANT_ALLOW: 'example.org' }), /<tenant>=<host>/);
  assert.throws(() => loadConfig({ ...TOKENS, BROWSER_TENANT_ALLOW: 'Bad Tenant=example.org' }), /tenant name/);
});

test('host patterns: host, *.host, host:port, bracketed IPv6, "*"', () => {
  assert.deepEqual(parseHostPattern('Example.ORG.'), { any: false, host: 'example.org', wild: false, port: null });
  assert.deepEqual(parseHostPattern('*.example.org'), { any: false, host: 'example.org', wild: true, port: null });
  assert.deepEqual(parseHostPattern('127.0.0.1:4848'), { any: false, host: '127.0.0.1', wild: false, port: 4848 });
  assert.deepEqual(parseHostPattern('[::1]:4848'), { any: false, host: '::1', wild: false, port: 4848 });
  assert.deepEqual(parseHostPattern('[::1]'), { any: false, host: '::1', wild: false, port: null });
  assert.equal(parseHostPattern('*').any, true);
  for (const bad of ['', 'example.org:', 'example.org:abc', 'example.org:99999', '[::1', 'ex*mple.org', 'http://example.org', 'example.org/path']) {
    assert.throws(() => parseHostPattern(bad), /host pattern/, bad);
  }
});

test('address patterns match however the address is written', () => {
  for (const [pattern, url] of [['[0:0:0:0:0:0:0:1]:4848', 'http://[::1]:4848/'], ['[::ffff:127.0.0.1]:4848', 'http://[::ffff:7f00:1]:4848/'], ['127.1:4848', 'http://127.0.0.1:4848/'], ['[::1]', 'ws://[0::1]/']]) {
    assert.equal(allowsUrl([parseHostPattern(pattern)], url), true, `${pattern} vs ${url}`);
  }
  assert.throws(() => parseHostPattern('[::1::2]:80'), /not a valid host/);
});

test('allowsUrl: host and port, subdomains only under *., no scheme but http(s)', () => {
  const p = patterns('*.example.org,example.net,127.0.0.1:4848');
  for (const u of ['https://a.example.org/x?y=1', 'http://a.b.example.org:8080/', 'https://A.Example.ORG./',
    'https://example.net/', 'http://example.net:8080/', 'http://127.0.0.1:4848/page']) assert.ok(allowsUrl(p, u), u);
  for (const u of ['https://example.org/', 'https://evil-example.org/', 'https://a.example.org.evil.test/',
    'https://example.net.evil.test/', 'http://127.0.0.1:4849/', 'http://127.0.0.2:4848/',
    'http://[::1]:4848/', 'file:///etc/passwd', 'data:text/html,x', 'not a url']) assert.ok(!allowsUrl(p, u), u);
  // Credentials in the URL don't change the host that is checked.
  assert.ok(!allowsUrl(p, 'https://a.example.org@evil.test/'));
  assert.ok(allowsUrl(p, 'https://user:pw@a.example.org/'));
  assert.ok(allowsUrl(patterns('*'), 'http://anything.test:1234/'));
  assert.ok(!allowsUrl(patterns('*'), 'file:///etc/passwd'));
});

let pages, other, svc;
before(async () => {
  pages = await startPageServer();
  other = await startPageServer();
  // alice may only reach the first page server; bob has no allowlist (upstream behaviour).
  svc = await startBosun({ BROWSER_TENANT_ALLOW: `alice=127.0.0.1:${new URL(pages.base).port}` });
});
after(async () => { await svc.stop(); await pages.close(); await other.close(); });

test('navigate: the allowlist is enforced, and named in the tool description', async () => {
  const c = await connect(svc, TOKEN);
  try {
    const s = await c.open();
    assert.equal((await c.call('navigate', { session: s, url: `${pages.base}/` })).json().title, 'Home');
    const denied = await c.call('navigate', { session: s, url: `${other.base}/second?secret=shh` });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /is not in the host allowlist of this token \(BROWSER_TENANT_ALLOW\)/);
    assert.ok(!denied.text.includes('shh'), denied.text);
    // Still on the page it was allowed to open.
    assert.match((await c.call('read', { session: s, mode: 'text' })).text, new RegExp(`url: ${pages.base}/`));
    const nav = (await c.listTools()).tools.find((t) => t.name === 'navigate');
    assert.match(nav.description, new RegExp(`may only reach: 127\\.0\\.0\\.1:${new URL(pages.base).port}`));
  } finally { await c.close(); }
});

test('a tenant without an allowlist reaches any host (upstream behaviour)', async () => {
  const c = await connect(svc, TOKEN_B);
  try {
    const s = await c.open();
    assert.equal((await c.call('navigate', { session: s, url: `${other.base}/second` })).json().title, 'Second');
    const nav = (await c.listTools()).tools.find((t) => t.name === 'navigate');
    assert.equal(nav.description, 'Go to a URL (http/https only).');
  } finally { await c.close(); }
});

test('a navigation the page starts by itself cannot leave the allowlist', async () => {
  const logs = [];
  const orig = console.error;
  console.error = (...a) => { logs.push(a.join(' ')); };
  const c = await connect(svc, TOKEN);
  try {
    const s = await c.open();
    const go = `${pages.base}/go?to=${encodeURIComponent(`${other.base}/second`)}`;
    const n = await c.call('navigate', { session: s, url: go });
    assert.equal(n.isError, false, n.text);
    // The browser follows its own navigation; the tenant's proxy is what refuses it, so the host never answers.
    const line = await until(() => logs.find((l) => l.includes(': blocked ')), 5000);
    assert.equal(line, `bosun: tenant alice: blocked 127.0.0.1:${new URL(other.base).port} — not in the host allowlist`);
    assert.ok(!logs.some((l) => l.includes('/second')), logs.join('\n')); // host:port only
    const r = await c.call('read', { session: s, mode: 'text' });
    assert.ok(!r.text.includes('second page'), r.text);
  } finally {
    console.error = orig;
    await c.close();
  }
});

test('keepalive_set refuses a URL outside the allowlist', async () => {
  const c = await connect(svc, TOKEN);
  try {
    await c.open({ profile: 'work' }); // a profile must exist before a schedule can name it
    const r = await c.call('keepalive_set', { profile: 'work', url: `${other.base}/`, logged_in_check: { text: 'x' } });
    assert.equal(r.isError, true);
    assert.match(r.text, /is not in the host allowlist of this token/);
    const ok = await c.call('keepalive_set', { profile: 'work', url: `${pages.base}/`, logged_in_check: { text: 'Hello Bosun' } });
    assert.equal(ok.isError, false, ok.text);
  } finally { await c.close(); }
});
