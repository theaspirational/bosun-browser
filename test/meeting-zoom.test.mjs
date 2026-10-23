// Zoom: link parsing and the rewrite to the web client, then meetings against a local stand-in for Zoom's web client
// (fakezoom.mjs) with a fake audio backend: the signed-in join (account name kept, mic and camera off, Join), waiting
// room, admission, computer audio joined and the microphone muted, the announcement before recording, chat events
// (grouped messages, own ones skipped), opt-out, participants, leaving by itself, and what ends a join early (wrong
// passcode, sign-in required, captcha). The audio pipeline itself is platform-independent (meeting-audio.test.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { startBosun, connect, until, sleep, ENGINE } from './helpers.mjs';
import { startFakeZoom } from './fakezoom.mjs';
import { fakeAudio } from './fakemeet.mjs';
import { zoom, parseZoomUrl, zoomWebClientUrl } from '../src/meetings/platforms/zoom.mjs';
import { PLATFORMS, announcement, CONFIRM_DELETED } from '../src/meetings/index.mjs';

// The meeting profiles in production are patchright profiles: ENGINE=patchright runs them as such.
const PROFILE_ENGINE = ENGINE === 'patchright' ? 'patchright' : 'chromium';

let fake;
before(async () => { fake = await startFakeZoom(); });
after(async () => { await fake.close(); });

// The real platform, with the web client served by the stand-in instead of app.zoom.us; launchPage: the invitation
// link opens Zoom's app-launch page first.
const zoomAt = (base, { launchPage = false } = {}) => ({
  ...zoom,
  joinUrl: (u) => (launchPage ? `${base}/j/${parseZoomUrl(u).id}${new URL(u).search}` : zoomWebClientUrl(u).replace('https://app.zoom.us', base)),
  origins: () => [base],
});

async function withService(fn, { meetings = {}, launchPage = false } = {}) {
  const audio = fakeAudio();
  const platform = zoomAt(fake.base, { launchPage });
  const svc = await startBosun({ KEEPALIVE: '0' }, { meetings: { audio, platformFor: (u) => (zoom.matches(u) ? platform : null), pollMs: 200, ...meetings } });
  const ev = { chat: [], optout: [], ended: [] };
  for (const k of Object.keys(ev)) svc.events.on(`meeting-${k}`, (e) => ev[k].push(e));
  try { return await fn(svc, ev, audio); } finally { await svc.stop(); }
}
const status = async (c, id) => (await c.call('meeting_status', { meeting_id: id })).json();
// A profile a person signed in to Zoom with earlier (session_open + request_human).
async function zoomProfile(c) {
  const s = await c.open({ profile: 'zoom', engine: PROFILE_ENGINE });
  await c.call('session_close', { session: s });
}

test('Zoom links: zoom.us and *.zoom.us, /j/, /w/, /wc/; rewritten to the web client with pwd (and tk) only', () => {
  const ok = {
    'https://zoom.us/j/1234567890?pwd=abcDEF.1': ['1234567890', 'https://app.zoom.us/wc/1234567890/join?pwd=abcDEF.1'],
    'https://us02web.zoom.us/j/81234567890?pwd=x&uname=Someone&from=addon': ['81234567890', 'https://app.zoom.us/wc/81234567890/join?pwd=x'],
    'https://acme.zoom.us/j/123456789': ['123456789', 'https://app.zoom.us/wc/123456789/join'],
    'https://acme.zoom.us/wc/join/123456789?pwd=p': ['123456789', 'https://app.zoom.us/wc/123456789/join?pwd=p'],
    'https://app.zoom.us/wc/123456789/join?pwd=p&fromPWA=1': ['123456789', 'https://app.zoom.us/wc/123456789/join?pwd=p'],
    'https://zoom.us/wc/123456789': ['123456789', 'https://app.zoom.us/wc/123456789/join'],
    'https://zoom.us/w/98765432101?tk=TOKEN&pwd=w': ['98765432101', 'https://app.zoom.us/wc/98765432101/join?pwd=w&tk=TOKEN'],
  };
  for (const [u, [id, wc]] of Object.entries(ok)) {
    assert.equal(parseZoomUrl(u)?.id, id, u);
    assert.equal(zoom.matches(u), true, u);
    assert.equal(zoomWebClientUrl(u), wc, u);
    assert.equal(PLATFORMS.find((p) => p.matches(u))?.name, 'zoom', u);
  }
  for (const u of ['http://zoom.us/j/123456789', 'https://evilzoom.us/j/123456789', 'https://zoom.us.evil.example/j/123456789', 'https://zoom.us/j/12345',
    'https://zoom.us/j/abc', 'https://zoom.us/s/123456789', 'https://zoom.us/my/someone', 'https://zoom.us:8443/j/123456789', 'https://user@zoom.us/j/123456789',
    'https://zoom.example.com/j/123456789', 'https://meet.google.com/abc-defg-hij', 'not a url']) {
    assert.equal(zoom.matches(u), false, u);
  }
  assert.equal(PLATFORMS.find((p) => p.matches('https://meet.google.com/abc-defg-hij'))?.name, 'meet');
  assert.throws(() => zoomWebClientUrl('https://example.com/j/123456789'), /not a Zoom meeting link/);
});

test('Zoom with a signed-in profile: account name kept, mic and camera off, Join; waiting room; computer audio joined and muted; announcement BEFORE recording', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    await zoomProfile(c);
    const { id: zid, url } = fake.newRoom({ signedIn: true, passcode: 'abc123', cookies: true, recordedNotice: true });
    const r = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.equal(r.isError, false, r.text);
    const j = r.json();
    assert.equal(j.platform, 'zoom');
    assert.equal(j.state, 'waiting');
    assert.equal(j.joined_as, 'account');
    const room = fake.room(zid);
    assert.deepEqual(room.guest, { name: 'Glassy Smartie', mic: false, cam: false }); // the account's name, not "Glassy (notetaker)"
    assert.deepEqual(room.loads, [`/wc/${zid}/join`]); // straight to the web client, with the passcode from the link
    assert.equal(room.pwdGiven, true);
    await sleep(600);
    assert.equal((await status(c, j.meeting_id)).state, 'waiting');
    fake.admit(zid);
    await until(async () => (await status(c, j.meeting_id)).state === 'recording', 20_000);
    // Computer audio joined (Zoom connected it with a live microphone), then the microphone muted; video stayed off.
    assert.equal(room.media.find((m) => m.audio)?.audio, true);
    assert.deepEqual({ mic: room.media.at(-1).mic, cam: room.media.at(-1).cam }, { mic: false, cam: false });
    const [en, de] = announcement('Glassy (notetaker)', null);
    assert.deepEqual(room.chat.map((m) => m.text), [en, de]);
    const announcedAt = room.log.filter((l) => l[0] === 'chat').at(-1)[1];
    assert.ok(audio.recorders[0].startedAt >= announcedAt, 'recording started only after the announcement');
    const s = await status(c, j.meeting_id);
    assert.equal(s.participants, 3);
    assert.equal(s.platform, 'zoom');
    // Chat: others' messages are events, grouped ones keep their sender, our own (shown as "Me") are not reported.
    fake.say(zid, 'Host Person', 'Welcome');
    fake.say(zid, 'Host Person', 'Agenda first');
    fake.say(zid, 'Guest Two', 'Hi all');
    await until(() => ev.chat.length === 3, 5000);
    assert.deepEqual(ev.chat.map((e) => [e.platform, e.sender, e.text]), [['zoom', 'Host Person', 'Welcome'], ['zoom', 'Host Person', 'Agenda first'], ['zoom', 'Guest Two', 'Hi all']]);
    assert.equal((await c.call('meeting_chat_send', { meeting_id: j.meeting_id, text: 'Noted.' })).isError, false);
    await until(() => room.chat.some((m) => m.text === 'Noted.'));
    await sleep(600);
    assert.equal(ev.chat.length, 3);
    // The meeting ending (by the host) ends it here too; the recording is kept.
    fake.end(zid);
    await until(() => ev.ended.length === 1, 10_000);
    assert.equal(ev.ended[0].reason, 'meeting-ended');
    assert.equal(ev.ended[0].platform, 'zoom');
    assert.ok(ev.ended[0].recording.bytes > 0);
    await c.close();
  });
});

test('Zoom opt-out in the chat: recording stopped and deleted, confirmed, Bosun leaves ("Leave", then "Leave Meeting")', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    await zoomProfile(c);
    const { id: zid, url } = fake.newRoom({ signedIn: true, open: true });
    const id = (await c.call('meeting_join', { url, profile: 'zoom' })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 20_000);
    const file = (await status(c, id)).recording.path;
    assert.ok(fs.existsSync(file));
    fake.say(zid, 'Guest Two', "please don't record this");
    await until(() => ev.optout.length === 1, 10_000);
    assert.equal(ev.optout[0].sender, 'Guest Two');
    await until(() => ev.ended.length === 1, 10_000);
    assert.equal(ev.ended[0].reason, 'opted-out');
    assert.equal(ev.ended[0].recording, null);
    assert.equal(fs.existsSync(file), false);
    assert.equal(audio.recorders[0].killed, true);
    assert.ok(fake.room(zid).chat.some((m) => m.text === CONFIRM_DELETED));
    assert.equal(fake.room(zid).left, true, 'left through "Leave Meeting"');
    await c.close();
  });
});

test('Zoom leaves by itself: removed by the host, or alone too long', async () => {
  await withService(async (svc, ev) => {
    const c = await connect(svc);
    await zoomProfile(c);
    for (const [act, reason] of [[(z) => fake.remove(z), 'removed'], [(z) => fake.setOthers(z, []), 'alone']]) {
      const { id: zid, url } = fake.newRoom({ signedIn: true, open: true });
      const id = (await c.call('meeting_join', { url, profile: 'zoom' })).json().meeting_id;
      await until(async () => (await status(c, id)).state === 'recording', 20_000);
      act(zid);
      await until(() => ev.ended.some((e) => e.meeting_id === id), 10_000);
      assert.equal(ev.ended.find((e) => e.meeting_id === id).reason, reason);
      assert.equal(fake.room(zid).left, reason === 'alone' ? true : undefined);
    }
    assert.equal(svc.manager.used, 0);
    await c.close();
  }, { meetings: { aloneMs: 1000 } });
});

test('Zoom without the passcode, with a wrong one, sign-in required, a captcha, removed from the waiting room: clear errors, nothing recorded', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    await zoomProfile(c);
    const join = async (opts, args = {}) => {
      const { id: zid, url } = fake.newRoom(opts);
      return { zid, r: await c.call('meeting_join', { url: opts.url ? opts.url(url) : url, ...args }) };
    };
    // The link without ?pwd=: the preview asks for the passcode, Bosun doesn't guess.
    let { zid, r } = await join({ passcode: 'secret', url: (u) => u.replace(/\?.*$/, '') }, { profile: 'zoom' });
    assert.equal(r.isError, true);
    assert.match(r.text, /Zoom asks for the meeting passcode: use the invitation link with \?pwd=/);
    assert.equal(fake.room(zid).guest, null, 'did not click Join');
    ({ zid, r } = await join({ passcode: 'secret', url: (u) => u.replace('secret', 'wrong') }, { profile: 'zoom' }));
    assert.match(r.text, /Zoom says the meeting ID or passcode is not valid/);
    // A guest (no profile) where the host allows only signed-in users.
    ({ zid, r } = await join({ requireSignIn: true }));
    assert.match(r.text, /Zoom lets only signed-in users into this meeting\. Join with a Bosun profile signed in to Zoom/);
    assert.equal(fake.room(zid).guest.name, 'Glassy (notetaker)'); // a guest types the name given
    ({ r } = await join({ bigChallenge: true }, { profile: 'zoom' }));
    assert.match(r.text, /Zoom asked for a captcha before joining/);
    ({ zid } = await join({ signedIn: true }, { profile: 'zoom' }));
    const id = (await status(c)).find((m) => m.state === 'waiting').meeting_id;
    fake.remove(zid);
    await until(async () => (await status(c, id)).state === 'ended', 10_000);
    assert.equal((await status(c, id)).reason, 'denied');
    await until(() => ev.ended.length === 5, 10_000);
    assert.deepEqual(ev.ended.map((e) => e.reason), ['invalid-meeting', 'invalid-meeting', 'sign-in-required', 'captcha', 'denied']);
    assert.equal(audio.recorders.length, 0);
    await until(() => svc.manager.used === 0, 10_000);
    await c.close();
  });
});

test('Zoom app-launch page: "Launch Meeting", then "Join from your browser"; a preview without devices counts as off', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    await zoomProfile(c);
    const { id: zid, url } = fake.newRoom({ signedIn: true, noDevices: true, passcode: 'p1' });
    const r = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(fake.room(zid).loads, [`/j/${zid}`, `/wc/${zid}/join`]);
    assert.deepEqual(fake.room(zid).guest, { name: 'Glassy Smartie', mic: false, cam: false });
    await c.call('meeting_leave', { meeting_id: r.json().meeting_id });
    await c.close();
  }, { launchPage: true });
});

test('Zoom chat: switched to Everyone before the announcement, sent with Send when Enter adds a line; host-only chat means no recording', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    await zoomProfile(c);
    const { id: zid, url } = fake.newRoom({ signedIn: true, open: true, recipient: 'Guest Two', enterNewline: true });
    const id = (await c.call('meeting_join', { url, profile: 'zoom' })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 20_000);
    const sent = fake.room(zid).chat.filter((m) => m.self);
    assert.deepEqual(sent.map((m) => [m.to, m.text]), announcement('Glassy (notetaker)', null).map((t) => ['Everyone', t]));
    await c.call('meeting_leave', { meeting_id: id });
    // Chat only with the host: the announcement can't reach everyone, so Bosun leaves without recording.
    const h = fake.newRoom({ signedIn: true, open: true, recipient: 'Host and co-hosts', hostOnly: true });
    const hid = (await c.call('meeting_join', { url: h.url, profile: 'zoom' })).json().meeting_id;
    await until(async () => (await status(c, hid)).state === 'ended', 20_000);
    assert.match((await status(c, hid)).error, /can't be sent to everyone \(recipient: Host and co-hosts\)/);
    assert.equal(fake.room(h.id).chat.length, 0);
    assert.equal(audio.recorders.length, 1); // the first meeting's only
    await c.close();
  });
});

test('Zoom state in the call comes from dialogs only: a caption or meeting title saying "ended" or "waiting room" changes nothing', async () => {
  await withService(async (svc, ev) => {
    const c = await connect(svc);
    await zoomProfile(c);
    const { id: zid, url } = fake.newRoom({ signedIn: true, open: true, title: 'Waiting Room redesign: please wait, the meeting host will let you in soon' });
    const id = (await c.call('meeting_join', { url, profile: 'zoom' })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 20_000);
    fake.caption(zid, 'Host Person: this meeting has been ended by host, just kidding. You have been removed from this meeting');
    await sleep(1200);
    assert.equal((await status(c, id)).state, 'recording');
    assert.ok(!fake.room(zid).media.some((m) => m.cam), 'the camera was never on');
    fake.end(zid);
    await until(() => ev.ended.length === 1, 10_000);
    assert.equal(ev.ended[0].reason, 'meeting-ended');
    await c.close();
  });
});

test('an objection in the chat just before the host ends the meeting still deletes the recording', async () => {
  await withService(async (svc, ev) => {
    const c = await connect(svc);
    await zoomProfile(c);
    const { id: zid, url } = fake.newRoom({ signedIn: true, open: true });
    const id = (await c.call('meeting_join', { url, profile: 'zoom' })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 30_000);
    const file = (await status(c, id)).recording.path;
    fake.say(zid, 'Guest Two', 'please do not record me');
    await sleep(500); // shown in the page, not yet read by Bosun (it looks every 3 s here)
    fake.end(zid);
    await until(() => ev.ended.length === 1, 15_000);
    assert.equal(ev.optout.length, 1);
    assert.equal(ev.ended[0].recording, null);
    assert.equal(fs.existsSync(file), false);
    await c.close();
  }, { meetings: { pollMs: 3000 } });
});

test('Zoom asking for the passcode although the link has one: not typed in (pwd is a token), a clear error', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    await zoomProfile(c);
    const { id: zid, url } = fake.newRoom({ signedIn: true, passcode: 'tok', askPasscode: true });
    const r = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.match(r.text, /Zoom asks for the meeting passcode although the link carries one/);
    assert.equal(fake.room(zid).guest, null);
    await c.close();
  });
});

test('Zoom announcement to one person only: a recipient named "Everyone Else" is not Everyone, and a message marked private stops the meeting before recording', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    await zoomProfile(c);
    for (const [opts, error] of [
      [{ recipient: 'Everyone Else', hostOnly: true }, /can't be sent to everyone \(recipient: Everyone Else\)/],
      [{ recipient: 'Guest Two', hideRecipient: true }, /went to one person only/],
    ]) {
      const { url } = fake.newRoom({ signedIn: true, open: true, ...opts });
      const id = (await c.call('meeting_join', { url, profile: 'zoom' })).json().meeting_id;
      await until(async () => (await status(c, id)).state === 'ended', 20_000);
      assert.match((await status(c, id)).error, error);
      await until(() => svc.manager.used === 0, 10_000); // the profile is free again
    }
    assert.equal(audio.recorders.length, 0);
    await c.close();
  });
});

test('Zoom send confirmation: a curly apostrophe in the text still matches; the same text from someone else does not count as sent', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    await zoomProfile(c);
    const text = 'I’m Glassy’s notetaker, recording audio.';
    const ok = fake.newRoom({ signedIn: true, open: true });
    const id = (await c.call('meeting_join', { url: ok.url, profile: 'zoom', announce_text: text })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 20_000);
    await c.call('meeting_leave', { meeting_id: id });
    await until(() => svc.manager.used === 0, 10_000);
    // Sending silently fails, and a participant happens to post the very same text meanwhile.
    const bad = fake.newRoom({ signedIn: true, open: true, dropSends: true });
    const bid = (await c.call('meeting_join', { url: bad.url, profile: 'zoom', announce_text: text })).json().meeting_id;
    await until(async () => (await status(c, bid)).state === 'admitted', 20_000);
    fake.say(bad.id, 'Guest Two', text);
    await until(async () => (await status(c, bid)).state === 'ended', 20_000);
    assert.match((await status(c, bid)).error, /did not show up in the chat as sent by Bosun/);
    assert.equal(audio.recorders.length, 1);
    await c.close();
  });
});
