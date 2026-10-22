// Fork: one tenant's host allowlist must not change another tenant's networking. The flags that keep a proxied
// tenant inside its proxy (no QUIC, no non-proxied WebRTC UDP) are Chromium's, and Chromium takes them per browser
// process — so a tenant with an allowlist gets a browser of its own and the tenants without one keep a browser
// launched exactly the way upstream launches it.
//
// Built from the round-3 review's probe: a UDP socket stands in for a STUN server, and an RTCPeerConnection in the
// page says whether the browser is willing to send UDP of its own. Both tenants are checked in the *same* service,
// with the allowlist in place, since that is the case that regressed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'dgram';
import http from 'http';
import { startBosun, connect, TOKEN, TOKEN_B } from './helpers.mjs';

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
async function gatherIce(token) {
  const c = await connect(svc, token);
  try {
    const id = await c.open();
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
    return { datagrams: udp.datagrams, candidates, browser: session.browser, allowlisted: !!svc.manager.allowList(token === TOKEN ? 'alice' : 'bob') };
  } finally { await c.close(); }
}

test('a tenant without an allowlist keeps its transports while another tenant is proxied', async () => {
  // The positive control: bob is unrestricted, so the browser sends UDP and gathers a host candidate, exactly as
  // it does with no allowlist configured anywhere.
  const bob = await gatherIce(TOKEN_B);
  assert.equal(bob.allowlisted, false);
  assert.ok(bob.datagrams > 0, `bob's browser sent no UDP (${bob.datagrams} datagrams), so another tenant's allowlist changed his networking`);
  assert.ok(bob.candidates.some((c) => / udp /i.test(c)), `bob gathered no UDP candidate: ${JSON.stringify(bob.candidates)}`);

  // alice is proxied: her browser may not open UDP of its own, so nothing reaches the listener.
  const alice = await gatherIce(TOKEN);
  assert.equal(alice.allowlisted, true);
  assert.equal(alice.datagrams, 0, `a proxied tenant's browser sent UDP: ${JSON.stringify(alice.candidates)}`);

  // They ran in different browsers, which is what makes the two sets of flags possible at all.
  assert.ok(alice.browser && bob.browser && alice.browser !== bob.browser, 'both tenants shared one browser');
  assert.deepEqual([...svc.manager.browsers.keys()].sort(), ['', 'alice']);
});
