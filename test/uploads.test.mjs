// File uploads into pages: upload_create (one-time PUT URL on the MCP port, or base64), then upload into a file
// input (also hidden), a file chooser opened by a button, or a drop zone. Files stay with their tenant, respect the
// size cap and quota, expire, and are deleted with the session that used them and on every start.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Readable } from 'stream';
import { loadConfig } from '../src/config.mjs';
import { Uploads, safeName } from '../src/uploads.mjs';
import { startBosun, connect, tmpDir, until, ENGINE, TOKEN, TOKEN_B } from './helpers.mjs';

const TOKEN_E = 'test-token-eeeeeeeeeeeeeeee';
const MB = 1024 * 1024;

// The pages, and /recv, which takes a multipart POST and reports its size, the file names in it, and (small bodies)
// the body itself.
const PAGES = {
  '/form': `<title>Form</title><form method="post" enctype="multipart/form-data" action="/recv">
    <label for="f">Document</label><input type="file" id="f" name="f">
    <input type="file" id="m" name="m" multiple>
    <button id="go">send</button></form>`,
  '/hidden': `<title>Hidden</title><input type="file" id="h" style="display:none" multiple><button id="pick" onclick="document.getElementById('h').click()">Choose file</button><p id="out">none</p>
    <script>const h = document.getElementById('h'); h.onchange = () => { document.getElementById('out').textContent = 'got ' + [...h.files].map((f) => f.name + ':' + f.size).join(','); };</script>`,
  // A button whose input never enters the DOM: only the file chooser reaches it.
  '/chooser': `<title>Chooser</title><button id="pick">Upload</button><button id="one">Upload one</button><p id="out">none</p>
    <script>const pick = (multiple) => { const i = document.createElement('input'); i.type = 'file'; i.multiple = multiple;
      i.onchange = async () => { const parts = []; for (const f of i.files) parts.push(f.name + '=' + (await f.text()).slice(0, 40)); document.getElementById('out').textContent = 'got ' + parts.join(','); };
      i.click(); };
    document.getElementById('pick').onclick = () => pick(true); document.getElementById('one').onclick = () => pick(false);</script>`,
  // The button is disabled for 6 s, then opens the chooser a moment after the click.
  '/slow': `<title>Slow</title><button id="pick" disabled>Upload</button><p id="out">none</p>
    <script>setTimeout(() => { document.getElementById('pick').disabled = false; }, 6000);
    document.getElementById('pick').onclick = () => setTimeout(() => { const i = document.createElement('input'); i.type = 'file';
      i.onchange = () => { document.getElementById('out').textContent = 'got ' + i.files[0].name; }; i.click(); }, 300);</script>`,
  '/drop': `<title>Drop</title><div id="zone" style="width:300px;height:200px;border:1px dashed">Drop files here</div><div id="plain">not a zone</div><p id="out">none</p>
    <script>const z = document.getElementById('zone'); z.addEventListener('dragover', (e) => e.preventDefault());
    z.addEventListener('drop', async (e) => { e.preventDefault(); const parts = []; for (const f of e.dataTransfer.files) parts.push(f.name + '=' + (await f.text()).slice(0, 40)); document.getElementById('out').textContent = 'dropped ' + parts.join(','); });</script>`,
};
// The drop zone again, under a CSP that runs only the page's own (nonced) script.
PAGES['/drop-csp'] = PAGES['/drop'].replace('<script>', '<script nonce="n0nce">');
const HEADERS = { '/drop-csp': { 'content-security-policy': "script-src 'nonce-n0nce'" } };

let pages, base, svc, received;
before(async () => {
  received = [];
  pages = http.createServer((req, res) => {
    if (req.url === '/recv' && req.method === 'POST') {
      let size = 0, carry = '', small = [];
      const names = new Set();
      req.on('data', (d) => {
        size += d.length;
        if (size <= MB) small.push(d);
        const s = carry + d.toString('latin1');
        for (const m of s.matchAll(/filename="([^"]*)"/g)) names.add(m[1]);
        carry = s.slice(-300);
      });
      req.on('end', () => {
        const r = { size, names: [...names], body: size <= MB ? Buffer.concat(small).toString('latin1') : null };
        received.push(r);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<title>Received</title><p id="r">received ${size} bytes: ${r.names.join(',')}</p>`);
      });
      return;
    }
    const body = PAGES[req.url];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html', ...HEADERS[req.url] });
    res.end(body || 'not found');
  });
  await new Promise((r) => pages.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${pages.address().port}`;
  svc = await startBosun({ BROWSER_TOKENS: `alice:${TOKEN},bob:${TOKEN_B},swarm:${TOKEN_E}`, BROWSER_TOKEN_POLICIES: 'swarm=ephemeral', UPLOAD_MAX_BYTES: String(250 * MB) });
});
after(async () => {
  await svc.stop();
  await new Promise((r) => { pages.closeAllConnections(); pages.close(() => r()); });
});

// PUT a body (Buffer or Readable) to a URL; resolves {status, json}. headers: extra request headers.
function put(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'PUT', headers: { ...(Buffer.isBuffer(body) ? { 'content-length': body.length } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (d) => { t += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json, text: t }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    if (Buffer.isBuffer(body)) req.end(body);
    else body.on('error', reject).pipe(req);
  });
}

// upload_create + PUT; returns the file_id.
async function send(c, filename, content) {
  const r = await c.call('upload_create', { filename });
  assert.equal(r.isError, false, r.text);
  const u = r.json();
  const p = await put(u.put_url, content);
  assert.equal(p.status, 201, p.text);
  assert.equal(p.json.file_id, u.file_id);
  return u.file_id;
}

const fileDirs = (tenant) => { try { return fs.readdirSync(path.join(svc.dataDir, 'uploads', tenant)); } catch { return []; } };

test('config: defaults, limits and switches', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.features.uploads, true);
  assert.equal(cfg.uploadMaxBytes, 300 * MB);
  assert.equal(cfg.uploadQuotaBytes, 1024 * MB);
  assert.equal(cfg.uploadTtlMs, 3600_000);
  assert.equal(cfg.uploadUrlTtlMs, 900_000);
  assert.equal(cfg.uploadBaseUrl, null);
  assert.equal(loadConfig({ FEATURES_UPLOADS: '0' }).features.uploads, false);
  assert.equal(loadConfig({ UPLOAD_MAX_BYTES: String(2048 * MB) }).uploadQuotaBytes, 2048 * MB); // never below the file cap
  assert.throws(() => loadConfig({ UPLOAD_MAX_BYTES: '100', UPLOAD_TENANT_QUOTA_BYTES: '50' }), /UPLOAD_TENANT_QUOTA_BYTES must be between 100/);
  assert.equal(loadConfig({ UPLOAD_BASE_URL: 'https://bosun.example.org/' }).uploadBaseUrl, 'https://bosun.example.org');
  assert.throws(() => loadConfig({ UPLOAD_BASE_URL: 'ftp://x' }), /must be http/);
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\Users\\x\\Bericht März.pdf'), 'Bericht März.pdf');
  assert.throws(() => safeName('..'), /must name a file/);
  assert.throws(() => safeName('dir/'), /must name a file/);
});

test('PUT then upload into a file input; the form posts the file', async () => {
  const c = await connect(svc, TOKEN);
  const id = await c.open();
  await c.call('navigate', { session: id, url: `${base}/form` });
  const r0 = await c.call('upload_create', { filename: 'hello.txt', size_bytes: 13 });
  const u = r0.json();
  assert.match(u.put_url, /^http:\/\/127\.0\.0\.1:\d+\/upload\/f[0-9a-f]{16}\?t=/); // the Host the client connected with
  assert.match(u.curl, /^curl -sS --fail-with-body -T 'hello.txt' 'http:\/\/127\.0\.0\.1:\d+\/upload\//);
  assert.equal(u.valid_min, 15);
  // Expect: 100-continue, as curl sends it for larger files.
  const p = await put(u.put_url, Buffer.from('hello upload\n'), { expect: '100-continue' });
  assert.equal(p.status, 201, p.text);
  assert.equal(p.json.size, 13);
  assert.equal((await put(u.put_url, Buffer.from('again'))).status, 404); // one-time
  const st = fs.statSync(path.join(svc.dataDir, 'uploads', 'alice', u.file_id, 'hello.txt'));
  assert.equal(st.mode & 0o777, 0o600);
  const r = await c.call('upload', { session: id, selector: '#f', file_id: u.file_id });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json().method, 'input');
  assert.deepEqual(r.json().input_files, ['hello.txt']);
  await c.call('click', { session: id, selector: '#go' });
  await until(() => received.length > 0);
  const got = received.pop();
  assert.deepEqual(got.names.filter(Boolean), ['hello.txt']);
  assert.match(got.body, /hello upload/);
  // By its label too (role+name of the label points at the input).
  await c.call('navigate', { session: id, url: `${base}/form` });
  const r2 = await c.call('upload', { session: id, text: 'Document', file_id: u.file_id });
  assert.equal(r2.isError, false, r2.text);
  assert.deepEqual(r2.json().input_files, ['hello.txt']);
  await c.close();
});

test('a hidden input, a button that opens the chooser, several files, and a single-file chooser refusing two', async () => {
  const c = await connect(svc, TOKEN);
  const id = await c.open();
  const a = await send(c, 'a.txt', Buffer.from('alpha'));
  const b = await send(c, 'b.txt', Buffer.from('bravo'));
  await c.call('navigate', { session: id, url: `${base}/hidden` });
  const r = await c.call('upload', { session: id, selector: '#h', files: [a, b] });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json().method, 'input');
  assert.equal((await c.call('read', { session: id, mode: 'text', selector: '#out' })).text.split('\n\n')[1], 'got a.txt:5,b.txt:5');
  // The visible button: clicked, and the chooser it opens answered.
  await c.call('navigate', { session: id, url: `${base}/hidden` });
  const r2 = await c.call('upload', { session: id, role: 'button', name: 'Choose file', file_id: a });
  assert.equal(r2.isError, false, r2.text);
  assert.equal(r2.json().method, 'chooser');
  await until(async () => /got a\.txt:5/.test((await c.call('read', { session: id, mode: 'text', selector: '#out' })).text));
  // An input that is never in the DOM.
  await c.call('navigate', { session: id, url: `${base}/chooser` });
  const r3 = await c.call('upload', { session: id, selector: '#pick', files: [a, b] });
  assert.equal(r3.isError, false, r3.text);
  assert.equal(r3.json().method, 'chooser');
  await until(async () => /got a\.txt=alpha,b\.txt=bravo/.test((await c.call('read', { session: id, mode: 'text', selector: '#out' })).text));
  const r4 = await c.call('upload', { session: id, selector: '#one', files: [a, b] });
  assert.equal(r4.isError, true);
  assert.match(r4.text, /takes one file/);
  // Two files into a single-file input.
  await c.call('navigate', { session: id, url: `${base}/form` });
  const r5 = await c.call('upload', { session: id, selector: '#f', files: [a, b] });
  assert.match(r5.text, /takes one file/);
  const r6 = await c.call('upload', { session: id, selector: '#m', files: [a, b] });
  assert.deepEqual(r6.json().input_files, ['a.txt', 'b.txt']);
  await c.close();
});

test('a drop zone without an input gets a synthetic drop; a plain element says it took nothing', async () => {
  const c = await connect(svc, TOKEN);
  const id = await c.open();
  const r0 = await c.call('upload_create', { filename: 'notes.md', content_base64: Buffer.from('# dropped').toString('base64') });
  assert.equal(r0.isError, false, r0.text);
  const f = r0.json().file_id;
  await c.call('navigate', { session: id, url: `${base}/drop` });
  const r = await c.call('upload', { session: id, selector: '#zone', file_id: f, method: 'drop' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json().method, 'drop');
  assert.equal(r.json().accepted, true);
  await until(async () => /dropped notes\.md=# dropped/.test((await c.call('read', { session: id, mode: 'text', selector: '#out' })).text));
  const r2 = await c.call('upload', { session: id, selector: '#plain', file_id: f, method: 'drop' });
  assert.equal(r2.json().accepted, false);
  // auto: no input, no chooser after the click -> the drop.
  await c.call('navigate', { session: id, url: `${base}/drop` });
  const r3 = await c.call('upload', { session: id, selector: '#zone', file_id: f });
  assert.equal(r3.json().method, 'drop');
  assert.equal(r3.json().accepted, true);
  // A strict CSP: Chromium drops from Bosun's own world; camoufox needs a page script, which the CSP refuses, and says so.
  await c.call('navigate', { session: id, url: `${base}/drop-csp` });
  const r4 = await c.call('upload', { session: id, selector: '#zone', file_id: f, method: 'drop' });
  assert.equal(r4.isError, false, r4.text);
  if (ENGINE === 'camoufox') assert.match(r4.json().note, /Content-Security-Policy blocked/);
  else await until(async () => /dropped notes\.md=# dropped/.test((await c.call('read', { session: id, mode: 'text', selector: '#out' })).text));
  // method input on something that isn't one.
  assert.match((await c.call('upload', { session: id, selector: '#zone', file_id: f, method: 'input' })).text, /not a file input/);
  await c.close();
});

test('a chooser button that becomes clickable late, and opens its chooser after the click', async () => {
  const c = await connect(svc, TOKEN);
  const id = await c.open();
  const f = (await c.call('upload_create', { filename: 'late.txt', content_base64: Buffer.from('late').toString('base64') })).json().file_id;
  await c.call('navigate', { session: id, url: `${base}/slow` });
  const r = await c.call('upload', { session: id, selector: '#pick', file_id: f });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json().method, 'chooser');
  await until(async () => /got late\.txt/.test((await c.call('read', { session: id, mode: 'text', selector: '#out' })).text));
  await c.close();
});

test('base64 shortcut: up to 1 MB, refused above and when it is not base64', async () => {
  const c = await connect(svc, TOKEN);
  const ok = await c.call('upload_create', { filename: 'one.bin', content_base64: Buffer.alloc(MB, 7).toString('base64') });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(ok.json().size, MB);
  const big = await c.call('upload_create', { filename: 'two.bin', content_base64: Buffer.alloc(MB + 3).toString('base64') });
  assert.equal(big.isError, true);
  for (const bad of ['not base64!', 'a==', '==', 'YQ=', 'YQ==YQ==']) assert.match((await c.call('upload_create', { filename: 'x.bin', content_base64: bad })).text, /not base64/, bad);
  assert.equal((await c.call('upload_create', { filename: 'y.bin', content_base64: 'YQ' })).json().size, 1); // padding may be left out
  await c.close();
});

test('too big: over UPLOAD_MAX_BYTES or the tenant quota is refused, with or without Content-Length, and nothing stays', async () => {
  const s2 = await startBosun({ UPLOAD_MAX_BYTES: '1000', UPLOAD_TENANT_QUOTA_BYTES: '1500' });
  try {
    const c = await connect(s2, TOKEN);
    assert.match((await c.call('upload_create', { filename: 'x', size_bytes: 1001 })).text, /larger than the upload limit/);
    const u1 = (await c.call('upload_create', { filename: 'x' })).json();
    const p1 = await put(u1.put_url, Buffer.alloc(1001));
    assert.equal(p1.status, 413);
    assert.match(p1.json.error, /UPLOAD_MAX_BYTES/);
    // Chunked, no length: refused once the 1001st byte arrives.
    const u2 = (await c.call('upload_create', { filename: 'y' })).json();
    const p2 = await put(u2.put_url, Readable.from([Buffer.alloc(600), Buffer.alloc(600)]));
    assert.ok(p2.status === 413 || p2.status === 0, JSON.stringify(p2)); // 413, or the socket closed while writing
    // size_bytes is binding.
    const u3 = (await c.call('upload_create', { filename: 'z', size_bytes: 10 })).json();
    assert.equal((await put(u3.put_url, Buffer.alloc(11))).status, 400);
    const u3b = (await c.call('upload_create', { filename: 'z', size_bytes: 10 })).json();
    const p3b = await put(u3b.put_url, Readable.from([Buffer.alloc(5)]));
    assert.equal(p3b.status, 400);
    assert.match(p3b.json.error, /received 5/);
    // Quota: 800 + 800 > 1500.
    const u4 = (await c.call('upload_create', { filename: 'a' })).json();
    assert.equal((await put(u4.put_url, Buffer.alloc(800))).status, 201);
    const u5 = (await c.call('upload_create', { filename: 'b' })).json();
    const p5 = await put(u5.put_url, Buffer.alloc(800));
    assert.equal(p5.status, 413);
    assert.match(p5.json.error, /quota/);
    assert.match((await c.call('upload_create', { filename: 'c', size_bytes: 800 })).text, /quota/);
    // Expect: 100-continue with a Content-Length over the cap: 413 before any byte of the body is sent.
    const u6 = (await c.call('upload_create', { filename: 'e' })).json();
    const early = await new Promise((resolve) => {
      let continued = false;
      const req = http.request(u6.put_url, { method: 'PUT', headers: { 'content-length': '5000', expect: '100-continue' } }, (res) => { res.resume(); resolve({ status: res.statusCode, continued }); });
      req.on('continue', () => { continued = true; req.end(Buffer.alloc(5000)); });
      req.on('error', () => resolve({ status: 0, continued }));
      req.flushHeaders();
    });
    assert.deepEqual(early, { status: 413, continued: false });
    await until(() => s2.uploads.used('alice') === 800);
    const dirs = fs.readdirSync(path.join(s2.dataDir, 'uploads', 'alice'));
    assert.deepEqual(dirs, [u4.file_id]); // refused uploads left nothing behind
    await c.close();
  } finally { await s2.stop(); }
});

test("files never cross tenants: another tenant's file_id and PUT header are refused; ephemeral tokens can't upload", async () => {
  const a = await connect(svc, TOKEN);
  const b = await connect(svc, TOKEN_B);
  const e = await connect(svc, TOKEN_E);
  const f = await send(a, 'secret.txt', Buffer.from('alice only'));
  const sb = await b.open();
  await b.call('navigate', { session: sb, url: `${base}/form` });
  const r = await b.call('upload', { session: sb, selector: '#f', file_id: f });
  assert.equal(r.isError, true);
  assert.match(r.text, /no uploaded file/);
  // The same message as for an id that never existed.
  assert.equal(r.text.replace(f, 'X'), (await b.call('upload', { session: sb, selector: '#f', file_id: 'f0000000000000000' })).text.replace('f0000000000000000', 'X'));
  // A PUT URL of alice's with bob's (or a bad) token in the header.
  const u = (await a.call('upload_create', { filename: 'x.txt' })).json();
  assert.equal((await put(u.put_url, Buffer.from('x'), { authorization: `Bearer ${TOKEN_B}` })).status, 403);
  assert.equal((await put(u.put_url, Buffer.from('x'), { authorization: 'Bearer nope-nope-nope-nope' })).status, 403);
  assert.equal((await put(u.put_url, Buffer.from('x'), { authorization: `Bearer ${TOKEN}` })).status, 201); // own token: fine
  // The tenant's own token instead of the URL's secret; nothing at all is 401.
  const u3 = (await a.call('upload_create', { filename: 'h.txt' })).json();
  const bare = u3.put_url.replace(/\?t=.*/, '');
  assert.equal((await put(bare, Buffer.from('h'))).status, 401);
  assert.equal((await put(bare, Buffer.from('h'), { authorization: `Bearer ${TOKEN_B}` })).status, 403);
  const p3 = await put(bare, Buffer.from('h'), { authorization: `Bearer ${TOKEN}` });
  assert.equal(p3.status, 201, p3.text);
  assert.equal((await put(bare, Buffer.from('h'), { authorization: `Bearer ${TOKEN}` })).status, 404); // still once
  // A wrong secret, a malformed id.
  assert.equal((await put(u.put_url.replace(/t=.*/, 't=wrong'), Buffer.from('x'))).status, 404);
  assert.equal((await put(u.put_url.replace(/\/upload\/[^?]+/, '/upload/..%2f..%2fetc'), Buffer.from('x'))).status, 404);
  // Ephemeral: not listed, refused by the server.
  const names = (await e.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes('upload') && !names.includes('upload_create'));
  assert.match((await e.call('upload_create', { filename: 'x' })).text, /not allowed for this token/);
  // A full token's PUT URL can't be used with an ephemeral token in the header.
  const u2 = (await a.call('upload_create', { filename: 'y.txt' })).json();
  assert.equal((await put(u2.put_url, Buffer.from('y'), { authorization: `Bearer ${TOKEN_E}` })).status, 403);
  await Promise.all([a.close(), b.close(), e.close()]);
});

test('caps: files a tenant holds (base64 and empty ones too), and PUTs streaming at once', async () => {
  const c = await connect(svc, TOKEN_B);
  const made = [];
  for (;;) {
    const r = await c.call('upload_create', { filename: 'empty.txt', content_base64: '' });
    if (r.isError) { assert.match(r.text, /holds 50 uploads/); break; }
    made.push(r.json().file_id);
    assert.ok(made.length <= 50);
  }
  assert.equal(made.length, 50);
  for (const id of made) await svc.uploads.remove(svc.uploads.files.get(id));
  // Four slow PUTs stream; the fifth is told to retry, and its URL still works afterwards.
  const urls = [];
  for (let i = 0; i < 5; i++) urls.push((await c.call('upload_create', { filename: `s${i}` })).json().put_url);
  const reqs = urls.slice(0, 4).map((u) => { const r = http.request(u, { method: 'PUT', headers: { 'content-length': '10' } }); r.on('error', () => {}); r.write('12345'); return r; });
  await until(() => svc.uploads.count('bob', 'receiving') === 4);
  assert.equal((await put(urls[4], Buffer.from('x'))).status, 429);
  for (const r of reqs) r.end('67890');
  await until(() => svc.uploads.count('bob', 'ready') === 4);
  assert.equal((await put(urls[4], Buffer.from('x'))).status, 201);
  for (const f of [...svc.uploads.files.values()].filter((x) => x.tenant === 'bob')) await svc.uploads.remove(f);
  await c.close();
});

test('a file that cannot be deleted keeps its quota and slot until a retry succeeds; the service caps files in all', async () => {
  const dir = tmpDir();
  const up = new Uploads({ ...loadConfig({}), dataDir: dir });
  const origError = console.error;
  console.error = () => {};
  try {
    const f = await up.create('alice', { filename: 'stuck.txt', content: Buffer.from('12345') });
    fs.chmodSync(path.join(dir, 'uploads', 'alice'), 0o500); // its directory can't be removed now
    await up.remove(f);
    assert.equal(up.used('alice'), 5);
    assert.equal(up.count('alice'), 1);
    fs.chmodSync(path.join(dir, 'uploads', 'alice'), 0o700);
    up.sweep();
    await until(() => up.count('alice') === 0);
    assert.equal(up.used('alice'), 0);
    for (let i = 0; i < 500; i++) await up.create(`t${i % 10}`, { filename: 'e', content: Buffer.alloc(0) });
    await assert.rejects(up.create('t99', { filename: 'e', content: Buffer.alloc(0) }), /service holds 500 uploads/);
  } finally {
    console.error = origError;
    await up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('expiry: an unused PUT URL and an unused file expire; cleanup with the session and on start', async () => {
  const c = await connect(svc, TOKEN);
  const u = (await c.call('upload_create', { filename: 'late.txt' })).json();
  svc.uploads.files.get(u.file_id).urlExpiresAt = Date.now() - 1;
  assert.equal((await put(u.put_url, Buffer.from('x'))).status, 404);
  const f = await send(c, 'old.txt', Buffer.from('old'));
  svc.uploads.files.get(f).expiresAt = Date.now() - 1;
  svc.uploads.sweep();
  await until(() => !fileDirs('alice').includes(f));
  const id = await c.open();
  await c.call('navigate', { session: id, url: `${base}/form` });
  assert.match((await c.call('upload', { session: id, selector: '#f', file_id: f })).text, /no uploaded file/);
  // Used in a session: deleted when that session closes, not before.
  const g = await send(c, 'used.txt', Buffer.from('used'));
  assert.equal((await c.call('upload', { session: id, selector: '#f', file_id: g })).isError, false);
  assert.ok(fileDirs('alice').includes(g));
  await c.call('session_close', { session: id });
  await until(() => !fileDirs('alice').includes(g));
  // Used in two sessions: kept until the second one closes too.
  const h = await send(c, 'twice.txt', Buffer.from('twice'));
  const s1 = await c.open(), s2 = await c.open();
  for (const s of [s1, s2]) {
    await c.call('navigate', { session: s, url: `${base}/form` });
    assert.equal((await c.call('upload', { session: s, selector: '#f', file_id: h })).isError, false);
  }
  await c.call('session_close', { session: s1 });
  await until(() => svc.manager.disposals.size === 0);
  assert.ok(fileDirs('alice').includes(h));
  await c.call('session_close', { session: s2 });
  await until(() => !fileDirs('alice').includes(h));
  await c.close();
  // On start: whatever an earlier process left is deleted.
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'uploads', 'alice', 'f0123456789abcdef'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads', 'alice', 'f0123456789abcdef', 'left.txt'), 'x');
  const up = new Uploads({ ...loadConfig({}), dataDir: dir });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'uploads')), []);
  await up.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('FEATURES_UPLOADS=0: no tools, no PUT endpoint, no uploads directory', async () => {
  const s2 = await startBosun({ FEATURES_UPLOADS: '0' });
  try {
    assert.equal(s2.uploads, null);
    assert.equal(fs.existsSync(path.join(s2.dataDir, 'uploads')), false);
    const c = await connect(s2, TOKEN);
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('upload') && !names.includes('upload_create'));
    assert.equal((await put(`http://127.0.0.1:${s2.ws.port}/upload/f0123456789abcdef?t=x`, Buffer.from('x'))).status, 426);
    await c.close();
  } finally { await s2.stop(); }
});

test('a 200 MB file streams to disk without the service holding it in memory, and the page posts all of it', async () => {
  const c = await connect(svc, TOKEN);
  const u = (await c.call('upload_create', { filename: 'big.bin', size_bytes: 200 * MB })).json();
  const chunk = crypto.randomBytes(64 * 1024);
  let n = 0;
  const body = new Readable({ read() { this.push(n++ < (200 * MB) / chunk.length ? chunk : null); } });
  global.gc?.();
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  const p = await put(u.put_url, body, { 'content-length': String(200 * MB) });
  clearInterval(sample);
  assert.equal(p.status, 201, p.text);
  assert.equal(p.json.size, 200 * MB);
  assert.ok(peak - rss0 < 64 * MB, `RSS grew by ${Math.round((peak - rss0) / MB)} MB during a 200 MB upload`);
  assert.equal(fs.statSync(path.join(svc.dataDir, 'uploads', 'alice', u.file_id, 'big.bin')).size, 200 * MB);
  const id = await c.open();
  await c.call('navigate', { session: id, url: `${base}/form` });
  const r = await c.call('upload', { session: id, selector: '#f', file_id: u.file_id });
  assert.equal(r.isError, false, r.text);
  await c.call('click', { session: id, selector: '#go' });
  const got = await until(() => received.find((x) => x.size > 200 * MB), 120_000, 200);
  assert.deepEqual(got.names.filter(Boolean), ['big.bin']);
  await c.close();
});
