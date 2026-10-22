// Fork: the host allowlist as the per-tenant forward proxy enforces it (src/proxy.mjs) — the layer where the
// browser's own semantics stay intact. Built from both review rounds' probes: two loopback servers, only the first
// one allowed, everything driven through the real MCP tools.
//
// What each case is about: a redirect chain cannot leave the allowlist (the hop is never sent), neither a page's
// nor a *worker's* WebSocket can, a host that is allowed loads as itself (so another allowed origin cannot read
// the first one's storage), and a name that resolves into a private address is refused unless the allowlist names
// that address too (DNS rebinding).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import zlib from 'zlib';
import { WebSocketServer } from 'ws';
import { isPrivateAddress, parseAuthority, resolveTarget } from '../src/proxy.mjs';
import { parseHostPattern } from '../src/allow.mjs';
import { startBosun, connect, until, TOKEN, TOKEN_B } from './helpers.mjs';

// The server a tenant may reach. ?to= and ?code= drive its redirects; /ws opens a WebSocket where ?to= says, in the
// page or in a Blob worker; /fetch fetches ?to=.
function allowedServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    srv.hits.push(u.pathname);
    const html = (body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };
    if (u.pathname === '/redirect') { res.writeHead(Number(u.searchParams.get('code') || 302), { location: u.searchParams.get('to') }); return res.end(); }
    if (u.pathname === '/hop1') { res.writeHead(302, { location: '/hop2', 'set-cookie': 'hop=1; Path=/' }); return res.end(); }
    if (u.pathname === '/hop2') { res.writeHead(302, { location: '/deep/landed' }); return res.end(); }
    if (u.pathname === '/deep/landed') {
      return html('<html><head><title>Landed</title></head><body><p>cookie=' + (req.headers.cookie || 'none') + '</p>'
        + '<img src="pixel.png" onload="document.title=\'img-ok\'" onerror="document.title=\'img-fail\'"></body></html>');
    }
    if (u.pathname === '/deep/pixel.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex'));
    }
    if (u.pathname === '/gzip') { // the proxy streams plain HTTP: a compressed body must arrive intact
      const gz = zlib.gzipSync(Buffer.from('<html><head><title>Gzipped</title></head><body><p>gzip ok Grüße 日本語</p></body></html>', 'utf8'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-length': String(gz.length) });
      return res.end(gz);
    }
    if (u.pathname === '/img') return html(`<title>Img</title><img src="${u.searchParams.get('to')}" onload="document.title='img-ok'" onerror="document.title='img-fail'">`);
    if (u.pathname === '/fetch') {
      return html(`<title>Fetch</title><p id="out">pending</p><script>
        fetch(new URL(location.href).searchParams.get('to'), { mode: 'no-cors' })
          .then(() => { document.getElementById('out').textContent = 'fetch returned'; },
                () => { document.getElementById('out').textContent = 'fetch failed'; });
      </script>`);
    }
    if (u.pathname === '/ws') {
      return html(`<title>WS</title><p id="out">pending</p><script>
        const to = new URL(location.href).searchParams.get('to');
        const worker = new URL(location.href).searchParams.get('worker') === '1';
        const say = (t) => { document.getElementById('out').textContent = t; };
        if (!worker) {
          const w = new WebSocket(to);
          w.onmessage = (e) => say('ws message ' + e.data);
          w.onclose = (e) => say('ws closed ' + e.code);
          w.onerror = () => say('ws error');
        } else {
          const code = 'const w = new WebSocket(' + JSON.stringify(to) + ');'
            + 'w.onmessage = (e) => postMessage("ws message " + e.data);'
            + 'w.onclose = (e) => postMessage("ws closed " + e.code);'
            + 'w.onerror = () => postMessage("ws error");';
          const u2 = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
          const wk = new Worker(u2);
          wk.onmessage = (e) => say('worker ' + e.data);
        }
      </script>`);
    }
    if (u.pathname === '/store') { // reads and writes this origin's own localStorage
      return html(`<title>Store</title><p id="out"></p><script>
        const set = new URL(location.href).searchParams.get('set');
        if (set) localStorage.setItem('originSecret', set);
        document.getElementById('out').textContent = 'stolen=' + localStorage.getItem('originSecret') + ';origin=' + location.origin;
      </script>`);
    }
    html('<title>Allowed</title><p>allowed</p>');
  });
  srv.hits = [];
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws) => { srv.hits.push('WEBSOCKET'); ws.send('from-allowed'); });
  return srv;
}

// The server it may not reach. It records every request and WebSocket that got through, and it serves the same
// storage-reading page, so a cross-origin redirect to it would be visible if it ran under the first origin.
function deniedServer() {
  const srv = http.createServer((req, res) => {
    srv.hits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>DENIED</title><p id="out">private</p><script>
      document.getElementById('out').textContent = 'stolen=' + localStorage.getItem('originSecret') + ';origin=' + location.origin;
    </script>`);
  });
  srv.hits = [];
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws) => { srv.hits.push('WEBSOCKET'); ws.send('from-denied'); });
  return srv;
}

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const close = (srv) => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); });
const wsOf = (base) => base.replace('http:', 'ws:');

let denied, deniedBase, allowed, base, svc, bothSvc, nameSvc, logs, origError;
before(async () => {
  denied = deniedServer();
  deniedBase = await listen(denied);
  allowed = allowedServer();
  base = await listen(allowed);
  const port = new URL(base).port;
  svc = await startBosun({ BROWSER_TENANT_ALLOW: `alice=127.0.0.1:${port}` });
  // A tenant that may reach both servers: for the cross-origin case.
  bothSvc = await startBosun({ BROWSER_TENANT_ALLOW: `alice=127.0.0.1:${port},127.0.0.1:${new URL(deniedBase).port}` });
  // A tenant whose allowlist names a *name* that resolves into loopback: for the rebinding guard.
  nameSvc = await startBosun({ BROWSER_TENANT_ALLOW: `alice=localhost:${port}` });
  logs = [];
  origError = console.error;
  console.error = (...a) => { logs.push(a.join(' ')); };
});
after(async () => {
  console.error = origError;
  await svc.stop();
  await bothSvc.stop();
  await nameSvc.stop();
  await close(allowed);
  await close(denied);
});

const denials = () => logs.filter((l) => l.includes(': blocked '));
const read = (c, s) => c.call('read', { session: s, mode: 'text' }).then((r) => r.text);
// What the page put into #out, whatever the surrounding read output is.
const outcome = async (c, s) => /(?:worker )?ws (?:message|closed|error)[^\n]*|img-(?:ok|fail)|stolen=[^\n]*/.exec(await read(c, s))?.[0];
// The proxy logs one line per target, so a second attempt at the same host:port is not logged again: its counter is
// what says a connection was refused.
const refusals = async (service = svc) => (await service.manager.tenantProxy('alice')).stats.denied;
const deniedPort = () => new URL(deniedBase).port;
const deniedLine = () => `bosun: tenant alice: blocked 127.0.0.1:${deniedPort()} — not in the host allowlist`;

test('proxy pieces on their own: authority parsing, private addresses, the rebinding rule', async () => {
  assert.deepEqual(parseAuthority('example.org:8443', 80), { host: 'example.org', port: 8443 });
  assert.deepEqual(parseAuthority('Example.ORG.', 80), { host: 'example.org', port: 80 });
  assert.deepEqual(parseAuthority('[::1]:4848', 443), { host: '::1', port: 4848 });
  assert.deepEqual(parseAuthority('[::1]', 443), { host: '::1', port: 443 });
  for (const bad of ['', ':443', 'example.org:0', 'example.org:70000', 'example.org:x', '[::1', 'example.org/path', '::1', 'a b:80', '[nonsense]:80']) {
    assert.equal(parseAuthority(bad, 80), null, bad);
  }
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946']) assert.ok(!isPrivateAddress(ip), ip);

  const allow = [parseHostPattern('app.example.org'), parseHostPattern('127.0.0.1:4848')];
  const publicIp = async () => '93.184.216.34';
  const privateIp = async () => '10.0.0.5';
  assert.deepEqual(await resolveTarget(allow, 'app.example.org', 443, publicIp), { ip: '93.184.216.34', host: 'app.example.org', port: 443 });
  assert.deepEqual(await resolveTarget(allow, 'other.example.org', 443, publicIp), { denied: 'not in the host allowlist' });
  // A name in the allowlist that resolves into a private range: only if the allowlist names that address too.
  assert.deepEqual(await resolveTarget(allow, 'app.example.org', 443, privateIp), { denied: 'resolves into a private address the allowlist does not name' });
  assert.deepEqual(await resolveTarget([parseHostPattern('app.example.org'), parseHostPattern('10.0.0.5:443')], 'app.example.org', 443, privateIp), { ip: '10.0.0.5', host: 'app.example.org', port: 443 });
  // An address in the allowlist is used as given, with no lookup at all.
  assert.deepEqual(await resolveTarget(allow, '127.0.0.1', 4848, () => { throw new Error('must not resolve'); }), { ip: '127.0.0.1', host: '127.0.0.1', port: 4848 });
  assert.deepEqual(await resolveTarget(allow, 'app.example.org', 443, async () => { throw new Error('nxdomain'); }), { denied: 'could not be resolved' });
});

test('navigate: refused before anything is opened, and the allowed hosts are named in the tool description', async () => {
  const c = await connect(svc, TOKEN);
  try {
    const s = await c.open();
    denied.hits.length = 0;
    assert.equal((await c.call('navigate', { session: s, url: `${base}/` })).json().title, 'Allowed');
    const r = await c.call('navigate', { session: s, url: `${deniedBase}/second?secret=shh` });
    assert.equal(r.isError, true);
    assert.match(r.text, /is not in the host allowlist of this token \(BROWSER_TENANT_ALLOW\)/);
    assert.ok(!r.text.includes('shh'), r.text);
    assert.deepEqual(denied.hits, []);
    const nav = (await c.listTools()).tools.find((t) => t.name === 'navigate');
    assert.match(nav.description, new RegExp(`may only reach: 127\\.0\\.0\\.1:${new URL(base).port}`));
  } finally { await c.close(); }
});

test('a redirect out of the allowlist never reaches the host (301/302/303/307/308)', async () => {
  const c = await connect(svc, TOKEN);
  try {
    const s = await c.open();
    for (const code of [301, 302, 303, 307, 308]) {
      denied.hits.length = 0;
      const before = await refusals();
      const to = `${deniedBase}/via-redirect-${code}?secret=shh`;
      const r = await c.call('navigate', { session: s, url: `${base}/redirect?code=${code}&to=${encodeURIComponent(to)}` });
      assert.equal(r.isError, false, `${code}: ${r.text}`);
      // The browser followed the redirect itself, so the tab is where the redirect pointed — but the proxy
      // refused it, so the status is the proxy's and the host never saw the request.
      assert.equal(r.json().status, 403, `${code}: ${r.text}`);
      assert.equal(r.json().url, to, code);
      assert.equal(r.json().refused, 'host allowlist', code);
      assert.deepEqual(denied.hits, [], `${code}: the hop reached the host outside the allowlist`);
      assert.ok(await refusals() > before, `${code}: the proxy did not refuse anything`);
      await until(() => denials().includes(deniedLine()), 5000);
      assert.ok(!logs.some((l) => l.includes('shh') || l.includes('via-redirect')), logs.join('\n'));
      assert.ok(!(await read(c, s)).includes('private'), 'the denied host\'s content reached the page');
    }
  } finally { await c.close(); }
});

test('an allowed redirect chain is followed by the browser, with its own URL and cookies', async () => {
  const c = await connect(svc, TOKEN);
  try {
    const before = denials().length; // nothing here is refused; the log must stay as it was
    allowed.hits.length = 0;
    const s = await c.open();
    const r = await c.call('navigate', { session: s, url: `${base}/hop1` });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json().status, 200);
    assert.equal(r.json().url, `${base}/deep/landed`); // the tab is where it really landed
    assert.equal(r.json().refused, undefined);
    assert.deepEqual(allowed.hits, ['/hop1', '/hop2', '/deep/landed', '/deep/pixel.png']);
    assert.match(await read(c, s), /cookie=hop=1/);
    assert.equal(await until(() => outcome(c, s), 5000), 'img-ok'); // relative to the real URL, natively
    assert.equal(denials().length, before);
  } finally { await c.close(); }
});

test('a subresource, and a subresource redirect, cannot leave the allowlist', async () => {
  const c = await connect(svc, TOKEN);
  try {
    const s = await c.open();
    for (const to of [`${deniedBase}/leaked-image?secret=shh`, `${base}/redirect?to=${encodeURIComponent(`${deniedBase}/leaked-image?secret=shh`)}`]) {
      denied.hits.length = 0;
      const before = await refusals();
      await c.call('navigate', { session: s, url: `${base}/img?to=${encodeURIComponent(to)}` });
      assert.equal(await until(() => outcome(c, s), 5000), 'img-fail');
      assert.deepEqual(denied.hits, []);
      assert.ok(await refusals() > before, 'the proxy did not refuse the subresource');
      await until(() => denials().includes(deniedLine()), 5000);
      assert.ok(!logs.some((l) => l.includes('shh')), logs.join('\n'));
    }
    // A fetch the page makes gets the proxy's refusal (an opaque response to it), and the host sees nothing.
    denied.hits.length = 0;
    const before = await refusals();
    await c.call('navigate', { session: s, url: `${base}/fetch?to=${encodeURIComponent(`${deniedBase}/exfiltrate?data=secret`)}` });
    assert.equal((await c.call('wait_for', { session: s, text: 'fetch returned', timeoutMs: 10000 })).isError, false);
    assert.deepEqual(denied.hits, []);
    assert.ok(await refusals() > before);
    assert.ok(!logs.some((l) => l.includes('data=secret')), logs.join('\n'));
  } finally { await c.close(); }
});

for (const worker of [false, true]) {
  test(`a WebSocket from ${worker ? 'a Blob worker' : 'the page'} is allowed only where the allowlist allows it`, async () => {
    const c = await connect(svc, TOKEN);
    try {
      const s = await c.open();
      const open = async (target) => {
        await c.call('navigate', { session: s, url: `${base}/ws?worker=${worker ? '1' : '0'}&to=${encodeURIComponent(target)}` });
        return until(() => outcome(c, s), 10000);
      };
      allowed.hits.length = 0;
      assert.equal(await open(`${wsOf(base)}/sock`), `${worker ? 'worker ' : ''}ws message from-allowed`);
      assert.ok(allowed.hits.includes('WEBSOCKET'));
      denied.hits.length = 0;
      const before = await refusals();
      const got = await open(`${wsOf(deniedBase)}/sock?secret=shh`);
      assert.match(got, /ws (error|closed)/, got);
      assert.deepEqual(denied.hits, [], 'the WebSocket reached a host outside the allowlist');
      assert.ok(await refusals() > before, 'the proxy did not refuse the WebSocket');
      await until(() => denials().includes(deniedLine()), 5000);
      assert.ok(!logs.some((l) => l.includes('shh')), logs.join('\n'));
    } finally { await c.close(); }
  });
}

test('another allowed origin loads as itself: it cannot read the first origin\'s storage', async () => {
  const c = await connect(bothSvc, TOKEN);
  try {
    const s = await c.open();
    // Seed the first origin's localStorage, then reach the second one directly and through a redirect.
    await c.call('navigate', { session: s, url: `${base}/store?set=A-only-probe-secret` });
    assert.match(await read(c, s), new RegExp(`stolen=A-only-probe-secret;origin=${base}`));
    const expected = new RegExp(`stolen=null;origin=${deniedBase}`);
    await c.call('navigate', { session: s, url: `${deniedBase}/direct` });
    assert.match(await read(c, s), expected, 'direct');
    const r = await c.call('navigate', { session: s, url: `${base}/redirect?to=${encodeURIComponent(`${deniedBase}/via-redirect`)}` });
    assert.equal(r.json().url, `${deniedBase}/via-redirect`);
    assert.match(await read(c, s), expected, 'through a redirect: the other origin must not run as the first one');
  } finally { await c.close(); }
});

test('a name that resolves into a private address is refused unless the allowlist names the address', async () => {
  const c = await connect(nameSvc, TOKEN);
  try {
    const s = await c.open();
    // "localhost" is in this tenant's allowlist, so navigate lets it through; the proxy resolves it to loopback,
    // which the allowlist does not name, and refuses — this is what DNS rebinding runs into.
    const r = await c.call('navigate', { session: s, url: `${base.replace('127.0.0.1', 'localhost')}/` });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json().status, 403, r.text);
    assert.ok(!(await read(c, s)).includes('allowed'), 'the page behind the private address was served');
    assert.equal(await refusals(nameSvc), 1);
    const line = await until(() => denials().find((l) => l.includes('localhost:')), 5000);
    assert.match(line, /^bosun: tenant alice: blocked localhost:\d+ — resolves into a private address the allowlist does not name$/);
    // The address form is not in this allowlist either, so it is refused one step earlier.
    const direct = await c.call('navigate', { session: s, url: `${base}/` });
    assert.equal(direct.isError, true);
    assert.match(direct.text, /is not in the host allowlist of this token/);
  } finally { await c.close(); }
});

test('a compressed response is streamed through unchanged', async () => {
  const c = await connect(svc, TOKEN);
  try {
    const s = await c.open();
    const r = await c.call('navigate', { session: s, url: `${base}/gzip` });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json().title, 'Gzipped');
    assert.match(await read(c, s), /gzip ok Grüße 日本語/);
  } finally { await c.close(); }
});

test('a tenant without an allowlist gets no proxy and keeps upstream behaviour', async () => {
  const c = await connect(svc, TOKEN_B);
  try {
    const s = await c.open();
    denied.hits.length = 0;
    assert.equal(await svc.manager.tenantProxy('bob'), null);
    const r = await c.call('navigate', { session: s, url: `${deniedBase}/anywhere` });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json().status, 200);
    assert.deepEqual(denied.hits, ['/anywhere']);
    await c.call('navigate', { session: s, url: `${base}/ws?worker=1&to=${encodeURIComponent(`${wsOf(deniedBase)}/sock`)}` });
    assert.equal(await until(() => outcome(c, s), 10000), 'worker ws message from-denied');
    const nav = (await c.listTools()).tools.find((t) => t.name === 'navigate');
    assert.equal(nav.description, 'Go to a URL (http/https only).');
  } finally { await c.close(); }
});

test('the proxy is not an open proxy: it needs its own credentials', async () => {
  const proxy = await svc.manager.tenantProxy('alice');
  const direct = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: `${base}/` }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve('error'));
    req.end();
  });
  assert.equal(direct, 407);
});
