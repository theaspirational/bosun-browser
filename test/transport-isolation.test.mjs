// One tenant's host allowlist must not change another tenant's networking. The flags that keep a proxied
// tenant inside its proxy (no QUIC, no non-proxied WebRTC UDP) are Chromium's, and Chromium takes them per browser
// process — so a tenant with an allowlist gets a browser of its own and the tenants without one keep a browser
// launched exactly the way upstream launches it.
//
// Built from a review probe: a UDP socket stands in for a STUN server, and an RTCPeerConnection in the
// page says whether the browser is willing to send UDP of its own. Both tenants are checked in the *same* service,
// with the allowlist in place, since that is the case that regressed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'dgram';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyWebrtcPolicy } from '../src/engines.mjs';
import { startBosun, connect, until, TOKEN, TOKEN_B } from './helpers.mjs';

let udp, stunPort, srv, base, svc;
before(async () => {
  udp = dgram.createSocket('udp4');
  udp.datagrams = 0;
  udp.on('message', () => { udp.datagrams++; });
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  stunPort = udp.address().port;
  srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>RTC</title><p>rtc</p>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  // alice may only reach the page server; bob has no allowlist at all.
  svc = await startBosun({ BROWSER_TENANT_ALLOW: `alice=127.0.0.1:${srv.address().port}` });
});
after(async () => {
  await svc.stop();
  udp.close();
  await new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); });
});

// Opens a session for one token, gathers ICE against the UDP listener and reports what the browser was willing to
// do. Returns the session's browser as well, to show which one it ran in.
async function gatherIce(token, open = {}) {
  const c = await connect(svc, token);
  try {
    const id = await c.open(open);
    assert.equal((await c.call('navigate', { session: id, url: base })).isError, false);
    const session = svc.manager.sessions.get(id);
    udp.datagrams = 0;
    const candidates = await session.page.evaluate(async (port) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
      pc.createDataChannel('probe');
      const seen = [];
      pc.onicecandidate = (e) => { if (e.candidate) seen.push(e.candidate.candidate); };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => setTimeout(r, 3000));
      pc.close();
      return seen;
    }, stunPort);
    return { datagrams: udp.datagrams, candidates, browser: session.browser, tmpDir: session.tmpDir, allowlisted: !!svc.manager.allowList(token === TOKEN ? 'alice' : 'bob') };
  } finally { await c.close(); }
}

test('a tenant without an allowlist keeps its transports while another tenant is proxied', async () => {
  // The positive control: bob is unrestricted, so the browser sends UDP and gathers a host candidate, exactly as
  // it does with no allowlist configured anywhere.
  const bob = await gatherIce(TOKEN_B);
  assert.equal(bob.allowlisted, false);
  // Camoufox gathers no UDP candidates of its own accord, so there is no positive control on that engine.
  if (process.env.ENGINE !== 'camoufox') assert.ok(bob.datagrams > 0, `bob's browser sent no UDP (${bob.datagrams} datagrams), so another tenant's allowlist changed his networking`);
  if (process.env.ENGINE !== 'camoufox') assert.ok(bob.candidates.some((c) => / udp /i.test(c)), `bob gathered no UDP candidate: ${JSON.stringify(bob.candidates)}`);

  // alice is proxied: her browser may not open UDP of its own, so nothing reaches the listener.
  const alice = await gatherIce(TOKEN);
  assert.equal(alice.allowlisted, true);
  assert.equal(alice.datagrams, 0, `a proxied tenant's browser sent UDP: ${JSON.stringify(alice.candidates)}`);

  // alice ran in a browser process of her own (a temp profile, gone with the session), which is what makes her flags
  // and profile preferences possible at all; bob's session, on chromium, is a context of the shared browser.
  assert.equal(alice.browser, null);
  assert.ok(alice.tmpDir);
  await until(() => !fs.existsSync(alice.tmpDir), 15000);
  if (bob.browser) assert.equal(svc.manager.browserP !== null, true);
});

// A persistent Chromium profile (profiles, patchright, meetings) ignores --force-webrtc-ip-handling-policy: only the
// profile preference holds it, which is why it is written before every proxied launch.
test('a proxied tenant\'s persistent profile sends no UDP of its own either', async () => {
  const alice = await gatherIce(TOKEN, { profile: 'rtc' });
  assert.equal(alice.allowlisted, true);
  assert.equal(alice.datagrams, 0, `a proxied tenant's profile sent UDP: ${JSON.stringify(alice.candidates)}`);
});

test('the WebRTC preference is set for a proxied launch and restored on an unproxied one, never touched otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-rtc-'));
  const file = path.join(dir, 'Default', 'Preferences');
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = (v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)); };
  try {
    write({ webrtc: { multiple_routes_enabled: true }, other: 1 });
    applyWebrtcPolicy(dir, true);
    assert.deepEqual(read(), { webrtc: { multiple_routes_enabled: true, ip_handling_policy: 'disable_non_proxied_udp' }, other: 1 });
    applyWebrtcPolicy(dir, false);
    assert.deepEqual(read(), { webrtc: { multiple_routes_enabled: true }, other: 1 });
    // A value Bosun replaced comes back.
    write({ webrtc: { ip_handling_policy: 'default_public_interface_only' } });
    applyWebrtcPolicy(dir, true);
    assert.equal(read().webrtc.ip_handling_policy, 'disable_non_proxied_udp');
    applyWebrtcPolicy(dir, false);
    assert.equal(read().webrtc.ip_handling_policy, 'default_public_interface_only');
    // A restriction Bosun did not set stays, both ways.
    write({ webrtc: { ip_handling_policy: 'disable_non_proxied_udp' } });
    applyWebrtcPolicy(dir, false);
    assert.equal(read().webrtc.ip_handling_policy, 'disable_non_proxied_udp');
    applyWebrtcPolicy(dir, true);
    applyWebrtcPolicy(dir, false);
    assert.equal(read().webrtc.ip_handling_policy, 'disable_non_proxied_udp');
    // A fresh profile directory gets the file created.
    fs.rmSync(path.join(dir, 'Default'), { recursive: true });
    applyWebrtcPolicy(dir, true);
    assert.equal(read().webrtc.ip_handling_policy, 'disable_non_proxied_udp');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
