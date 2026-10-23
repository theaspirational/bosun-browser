// What credential masking does NOT cover, pinned down so the documentation cannot drift from the behaviour.
// Masking works on the fields themselves — their current values, and the values Bosun saw in them. A page that moves
// what the human typed somewhere else (into ordinary text, a hidden field it reads later, its own storage) is not
// caught by it, on any engine: the scans share the page's DOM even where they run in an isolated world.
//
// These tests assert the limits as they are. If one of them starts failing because upstream masks more, that is good
// news — update README > Handoff and docs/SECURITY-REVIEW-0.7.0.md (finding H2) with it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { sensitiveValues } from '../src/redact.mjs';
import { startBosun, connect, TOKEN } from './helpers.mjs';

const SECRET = 'Mirror-probe-secret';

const server = () => http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  // "submit" does what a login page does with a password: it takes the value out of the field and clears it.
  res.end(`<title>Login</title><form onsubmit="return false">
    <input id="pw" type="password" name="password">
    <button id="go" onclick="document.getElementById('out').textContent = document.getElementById('pw').value; document.getElementById('pw').value = '';">submit</button>
    <p id="out"></p>
  </form>`);
});

let srv, base, svc;
before(async () => {
  srv = server();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  svc = await startBosun();
});
after(async () => {
  await svc.stop();
  await new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); });
});

test('a value still in a credential field is masked', async () => {
  const c = await connect(svc, TOKEN);
  try {
    const id = await c.open();
    await c.call('navigate', { session: id, url: base });
    await c.call('type', { session: id, selector: '#pw', value: SECRET });
    assert.deepEqual(await sensitiveValues(svc.manager.sessions.get(id).page), [SECRET]);
    const r = await c.call('read', { session: id });
    assert.ok(!r.text.includes(SECRET), r.text);
    assert.match(r.text, /\[masked\]/);
  } finally { await c.close(); }
});

test('a value the page copied into ordinary text is NOT masked — no engine prevents that', async () => {
  const c = await connect(svc, TOKEN);
  try {
    const id = await c.open();
    await c.call('navigate', { session: id, url: base });
    await c.call('type', { session: id, selector: '#pw', value: SECRET });
    await c.call('click', { session: id, selector: '#go' }); // the page takes the value and empties the field
    // Nothing is in a credential field any more, so there is nothing left for masking to recognise...
    assert.deepEqual(await sensitiveValues(svc.manager.sessions.get(id).page), []);
    // ... and the copy is plain page text the agent reads.
    assert.ok((await c.call('read', { session: id, mode: 'text' })).text.includes(SECRET));
    assert.ok((await c.call('read', { session: id })).text.includes(SECRET));
  } finally { await c.close(); }
});
