// Meetings against a local Meet stand-in (fakemeet.mjs) with a fake audio backend: join as a guest (mic and camera
// off, name, ask to join), waiting room, admission, the announcement before recording, chat events, opt-out (stop,
// delete, confirm, leave), automatic leaving, status, retention, and what is refused. The real audio pipeline is in
// meeting-audio.test.mjs (Linux with PulseAudio).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startBosun, connect, until, sleep, TOKEN_B, tmpDir } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { transition, sweepRecordings, announcement, CONFIRM_DELETED, Meetings } from '../src/meetings/index.mjs';

let fake;
before(async () => { fake = await startFakeMeet(); });
after(async () => { await fake.close(); });

async function withService(fn, { env = {}, meetings = {}, audioOpts = {} } = {}) {
  const audio = fakeAudio(audioOpts);
  const svc = await startBosun({ KEEPALIVE: '0', ...env }, { meetings: { audio, platformFor: (u) => (u.startsWith(fake.base) ? meet : null), pollMs: 200, ...meetings } });
  const ev = { chat: [], optout: [], ended: [] };
  for (const k of Object.keys(ev)) svc.events.on(`meeting-${k}`, (e) => ev[k].push(e));
  try { return await fn(svc, ev, audio); } finally { await svc.stop(); }
}

const status = async (c, id) => (await c.call('meeting_status', { meeting_id: id })).json();

test('join as a guest: mic and camera off, name, ask to join; waiting until admitted; announcement in the chat BEFORE recording starts', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    const r = await c.call('meeting_join', { url });
    assert.equal(r.isError, false, r.text);
    const j = r.json();
    assert.match(j.meeting_id, /^m[0-9a-f]{12}$/);
    assert.equal(j.state, 'waiting');
    assert.deepEqual(fake.room(code).guest, { name: 'Glassy (notetaker)', mic: false, cam: false });
    await sleep(600);
    assert.equal((await status(c, j.meeting_id)).state, 'waiting');
    assert.equal(audio.recorders.length, 0);
    fake.admit(code);
    await until(async () => (await status(c, j.meeting_id)).state === 'recording', 15_000);
    const room = fake.room(code);
    const [en, de] = announcement('Glassy (notetaker)', null);
    assert.deepEqual(room.chat.map((m) => m.text), [en, de]);
    assert.match(en, /^Hi, I'm Glassy, an AI notetaker\. I'm recording audio for notes\. .*'please don't record'/);
    const announcedAt = room.log.filter((l) => l[0] === 'chat').at(-1)[1];
    assert.ok(audio.recorders[0].startedAt >= announcedAt, 'recording started only after the announcement');
    const s = await status(c, j.meeting_id);
    assert.equal(s.participants, 3);
    assert.equal(s.recording.path, path.join(svc.dataDir, 'recordings', 'alice', `${j.meeting_id}.ogg`));
    assert.equal(fs.statSync(s.recording.path).mode & 0o777, 0o600);
    // The meeting is not the agent's session: it doesn't show up there and survives the agent disconnecting.
    assert.deepEqual((await c.call('sessions')).json(), []);
    await c.close();
    await sleep(500);
    const c2 = await connect(svc);
    assert.equal((await status(c2, j.meeting_id)).state, 'recording');
    // Another tenant can't see or touch it.
    const b = await connect(svc, TOKEN_B);
    for (const [tool, args] of [['meeting_status', {}], ['meeting_leave', {}], ['meeting_chat_read', {}], ['meeting_recording_delete', {}]]) {
      assert.match((await b.call(tool, { meeting_id: j.meeting_id, ...args })).text, /no meeting/, tool);
    }
    assert.deepEqual((await b.call('meeting_status')).json(), []);
    // Leaving: the call is left, the recording kept, bosun:meeting-ended with the reference.
    const left = (await c2.call('meeting_leave', { meeting_id: j.meeting_id })).json();
    assert.equal(left.state, 'ended');
    assert.equal(left.reason, 'left');
    assert.ok(room.left, 'clicked Leave call');
    await until(() => ev.ended.length === 1);
    const e = ev.ended[0];
    assert.equal(e.meeting_id, j.meeting_id);
    assert.equal(e.reason, 'left');
    assert.ok(e.duration_s >= 0);
    assert.ok(e.bytes > 4);
    assert.equal(e.recording.path, s.recording.path);
    assert.equal(e.recording.bytes, e.bytes);
    assert.match(e.recording.uri, /^file:\/\/.*\.ogg$/);
    assert.equal(audio.recorders[0].killed, false); // stopped cleanly, file finalized
    assert.equal(svc.manager.used, 0);
    await Promise.all([b.close(), c2.close()]);
  });
});

test('chat: every message from others is an event (own messages are not), readable with meeting_chat_read, and meeting_chat_send posts', async () => {
  await withService(async (svc, ev) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    fake.open(code); // no waiting room
    const id = (await c.call('meeting_join', { url, name: 'Notes Bot', announce_text: 'Notes Bot records audio for notes.' })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    fake.say(code, 'Alex Example', 'Hello there');
    fake.say(code, 'Sam Sample', 'Agenda: budget, hiring');
    await until(() => ev.chat.length === 2, 5000);
    assert.deepEqual(ev.chat.map((e) => [e.meeting_id, e.sender, e.text]), [[id, 'Alex Example', 'Hello there'], [id, 'Sam Sample', 'Agenda: budget, hiring']]);
    assert.equal((await c.call('meeting_chat_send', { meeting_id: id, text: 'Thanks, noted.' })).isError, false);
    await until(() => fake.room(code).chat.some((m) => m.text === 'Thanks, noted.'));
    await sleep(600);
    assert.equal(ev.chat.length, 2); // the announcement and our reply are not reported back
    const read = (await c.call('meeting_chat_read', { meeting_id: id })).json();
    assert.deepEqual(read.messages.map((m) => [m.seq, m.sender, m.text]), [[1, 'Alex Example', 'Hello there'], [2, 'Sam Sample', 'Agenda: budget, hiring']]);
    assert.deepEqual((await c.call('meeting_chat_read', { meeting_id: id, since: 1 })).json().messages.map((m) => m.seq), [2]);
    // A participant writing "the call has ended" in the chat does not end it.
    fake.say(code, 'Alex Example', 'The call has ended for me soon, I have to go');
    await sleep(800);
    assert.equal((await status(c, id)).state, 'recording');
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('opt-out in natural language: the recording stops and is deleted at once, confirmed in the chat, an event, and Bosun leaves', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    fake.open(code);
    const id = (await c.call('meeting_join', { url })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    const file = (await status(c, id)).recording.path;
    assert.ok(fs.existsSync(file));
    fake.say(code, 'Alex Example', 'Bitte nicht aufnehmen!');
    await until(() => ev.optout.length === 1, 5000);
    assert.equal(fs.existsSync(file), false);
    assert.equal(audio.recorders[0].killed, true);
    assert.deepEqual([ev.optout[0].sender, ev.optout[0].text, ev.optout[0].left], ['Alex Example', 'Bitte nicht aufnehmen!', true]);
    assert.ok(fake.room(code).chat.some((m) => m.text === CONFIRM_DELETED));
    await until(() => ev.ended.length === 1, 10_000);
    assert.equal(ev.ended[0].reason, 'opted-out');
    assert.equal(ev.ended[0].recording, null);
    assert.equal(ev.ended[0].bytes, 0);
    const s = await status(c, id);
    assert.deepEqual([s.state, s.recording, s.opted_out.sender], ['ended', 'deleted', 'Alex Example']);
    assert.ok(fake.room(code).left);
    assert.equal(fs.readdirSync(path.join(svc.dataDir, 'recordings', 'alice')).length, 0);
    await c.close();
  });
});

test('opt-out with leave_on_optout=false: stays, unrecorded, and never records again; the agent can stop (and keep) a recording itself', async () => {
  await withService(async (svc, ev) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    fake.open(code);
    const id = (await c.call('meeting_join', { url, leave_on_optout: false })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    fake.say(code, 'Alex Example', 'Не записуйте, будь ласка');
    await until(() => ev.optout.length === 1, 5000);
    await sleep(800);
    const s = await status(c, id);
    assert.deepEqual([s.state, s.recording], ['admitted', 'deleted']);
    fake.say(code, 'Sam Sample', 'stop recording'); // nothing left to stop: no second opt-out
    await sleep(800);
    assert.equal(ev.optout.length, 1);
    await c.call('meeting_leave', { meeting_id: id });
    // Agent-side stop: delete=false keeps the file, then meeting_recording_delete removes it.
    const { code: code2, url: url2 } = fake.newRoom();
    fake.open(code2);
    const id2 = (await c.call('meeting_join', { url: url2 })).json().meeting_id;
    await until(async () => (await status(c, id2)).state === 'recording', 15_000);
    await sleep(300);
    const st = (await c.call('meeting_stop_recording', { meeting_id: id2, delete: false })).json();
    assert.equal(st.stopped, true);
    assert.equal(st.deleted, false);
    assert.ok(st.bytes > 4);
    assert.equal(st.state, 'admitted');
    const f = (await status(c, id2)).recording.path;
    assert.ok(fs.existsSync(f));
    assert.deepEqual((await c.call('meeting_recording_delete', { meeting_id: id2 })).json(), { meeting_id: id2, deleted: true });
    assert.equal(fs.existsSync(f), false);
    assert.match((await c.call('meeting_recording_delete', { meeting_id: 'm000000000000' })).text, /no recording/);
    assert.match((await c.call('meeting_recording_delete', { meeting_id: '../../etc' })).text, /no meeting/);
    await c.call('meeting_leave', { meeting_id: id2 });
    await c.close();
  });
});

test('leaves by itself: the meeting ends, the bot is removed, or it is alone too long', async () => {
  await withService(async (svc, ev) => {
    const c = await connect(svc);
    const run = async (act, reason) => {
      const { code, url } = fake.newRoom();
      fake.open(code);
      const id = (await c.call('meeting_join', { url })).json().meeting_id;
      await until(async () => (await status(c, id)).state === 'recording', 15_000);
      act(code);
      await until(() => ev.ended.some((e) => e.meeting_id === id), 10_000);
      const e = ev.ended.find((x) => x.meeting_id === id);
      assert.equal(e.reason, reason);
      assert.ok(e.recording.bytes > 0); // kept: these are normal ends
      assert.equal(fake.room(code).left, reason === 'alone' ? true : undefined);
    };
    await run((code) => fake.end(code), 'meeting-ended');
    await run((code) => fake.remove(code), 'removed');
    await run((code) => fake.setOthers(code, []), 'alone');
    assert.equal(svc.manager.used, 0);
    await c.close();
  }, { meetings: { aloneMs: 1000 } });
});

test("denied, can't join, not admitted in time: clear errors and an ended event without recording", async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    const a = fake.newRoom();
    fake.deny(a.code); // the host already said no: "You can't join this call" + "Someone in the call denied your request"
    const r = await c.call('meeting_join', { url: a.url });
    assert.equal(r.isError, true);
    assert.match(r.text, /the request to join was denied/);
    const b = fake.newRoom();
    const id = (await c.call('meeting_join', { url: b.url })).json().meeting_id;
    fake.deny(b.code);
    await until(() => ev.ended.some((e) => e.meeting_id === id), 10_000);
    assert.equal(ev.ended.find((e) => e.meeting_id === id).reason, 'denied');
    assert.match((await status(c, id)).error, /denied/);
    const t = fake.newRoom();
    const m = await svc.meetings.join('alice', { url: t.url, maxWaitAdmitMin: 0.02 });
    await until(() => ev.ended.some((e) => e.meeting_id === m.meeting_id), 10_000);
    assert.equal(ev.ended.find((e) => e.meeting_id === m.meeting_id).reason, 'not-admitted');
    assert.equal(audio.recorders.length, 0);
    assert.ok(ev.ended.every((e) => e.recording === null));
    assert.equal(svc.manager.used, 0);
    await c.close();
  });
});

test('refused: links that are not Google Meet, camoufox, no audio support, headless with real audio', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    assert.match((await c.call('meeting_join', { url: 'https://zoom.example.com/j/123' })).text, /only Google Meet \(.*\) and Zoom \(https:\/\/zoom.us\/j\/<id>\?pwd=…\) links are supported/);
    assert.match((await c.call('meeting_join', { url: 'file:///etc/passwd' })).text, /http|url/i);
    assert.match((await c.call('meeting_join', { url: fake.newRoom().url, engine: 'camoufox' })).text, /meetings need a Chromium engine/);
    assert.equal(svc.manager.used, 0);
    const m = (audio) => new Meetings({ cfg: { ...svc.cfg, dataDir: tmpDir(), headless: true }, manager: svc.manager, audio, platformFor: () => meet });
    await assert.rejects(m({ unsupported: async () => 'pulseaudio is not installed' }).join('alice', { url: 'https://meet.google.com/abc-defg-hij' }), /pulseaudio is not installed/);
    await assert.rejects(m({ unsupported: async () => null, needsHeadful: true }).join('alice', { url: 'https://meet.google.com/abc-defg-hij' }), /headful/);
    await c.close();
  });
  assert.equal(meet.matches('https://meet.google.com/abc-defg-hij'), true);
  for (const u of ['http://meet.google.com/abc-defg-hij', 'https://meet.google.com.evil.example/abc-defg-hij', 'https://meet.google.com/landing', 'https://example.com/abc-defg-hij']) assert.equal(meet.matches(u), false, u);
});

test('state machine: only the documented transitions', () => {
  const m = { id: 'm1', state: 'joining' };
  for (const to of ['waiting', 'admitted', 'recording', 'admitted', 'recording', 'ended']) transition(m, to);
  assert.throws(() => transition(m, 'recording'), /ended -> recording is not allowed/);
  for (const [from, to] of [['joining', 'recording'], ['waiting', 'recording'], ['admitted', 'waiting'], ['recording', 'waiting']]) {
    assert.throws(() => transition({ id: 'x', state: from }, to), /not allowed/, `${from} -> ${to}`);
  }
  for (const from of ['joining', 'waiting', 'admitted', 'recording']) { const x = { id: 'x', state: from }; transition(x, 'ended'); assert.equal(x.state, 'ended'); }
});

test('retention: recordings older than RECORDING_RETENTION_DAYS are deleted, recent and active ones kept', () => {
  const dir = tmpDir();
  const now = Date.now();
  const mk = (t, id, ageDays) => { fs.mkdirSync(path.join(dir, t), { recursive: true }); const f = path.join(dir, t, `${id}.ogg`); fs.writeFileSync(f, 'x'); const at = (now - ageDays * 86_400_000) / 1000; fs.utimesSync(f, at, at); return f; };
  const old = mk('alice', 'm000000000001', 31), recent = mk('alice', 'm000000000002', 29), active = mk('bob', 'm000000000003', 40), other = mk('bob', 'notes.txt', 400);
  const removed = sweepRecordings(dir, 30, { now, keep: new Set([active]) });
  assert.deepEqual(removed, [old]);
  for (const f of [recent, active, other]) assert.ok(fs.existsSync(f), f);
  assert.deepEqual(sweepRecordings(dir, 1, { now, keep: new Set() }).sort(), [active, recent].sort());
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config: RECORDING_RETENTION_DAYS and MEETING_OWNER; the announcement names the owner only when configured', async () => {
  const { loadConfig } = await import('../src/config.mjs');
  assert.equal(loadConfig({}).recordingRetentionDays, 30);
  assert.equal(loadConfig({ RECORDING_RETENTION_DAYS: '7' }).recordingRetentionDays, 7);
  assert.throws(() => loadConfig({ RECORDING_RETENTION_DAYS: '0' }), /RECORDING_RETENTION_DAYS/);
  assert.equal(loadConfig({}).meetingOwner, null);
  const [en, de] = announcement('Glassy (notetaker)', 'Alex');
  assert.match(en, /^Hi, I'm Glassy, Alex's AI notetaker\./);
  assert.match(de, /KI-Notizassistent von Alex/);
  assert.match(de, /bitte nicht aufnehmen/);
});

test('own messages are recognized by what Bosun just sent, not by name: a participant called "You" or "Glassy (notetaker)" can still opt out', async () => {
  for (const name of ['You', 'Glassy (notetaker)']) {
    await withService(async (svc, ev) => {
      const c = await connect(svc);
      const { code, url } = fake.newRoom();
      fake.open(code);
      const id = (await c.call('meeting_join', { url })).json().meeting_id;
      await until(async () => (await status(c, id)).state === 'recording', 15_000);
      fake.say(code, name, "Please don't record");
      await until(() => ev.optout.length === 1, 5000);
      assert.equal(ev.chat[0].sender, name);
      // Repeating the bot's own announcement is forwarded as chat, but is not an objection.
      await c.close();
    });
  }
  await withService(async (svc, ev) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    fake.open(code);
    const id = (await c.call('meeting_join', { url })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    fake.say(code, 'Alex Example', announcement('Glassy (notetaker)', null)[0]);
    await until(() => ev.chat.length === 1, 5000);
    await sleep(500);
    assert.equal(ev.optout.length, 0);
    assert.equal((await status(c, id)).state, 'recording');
    await c.close();
  });
});

test('a chat message rendered empty first and filled in later still counts (opt-out included)', async () => {
  await withService(async (svc, ev) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    fake.open(code);
    const id = (await c.call('meeting_join', { url })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    fake.say(code, 'Alex Example', 'stop recording please', { lateMs: 700 });
    await until(() => ev.optout.length === 1, 6000);
    assert.equal(ev.optout[0].text, 'stop recording please');
    await c.close();
  });
});

test('microphone and camera must be verifiably off, or Bosun does not join', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    // No control at all; a control that won't switch; one showing "on" but disabled; a stale "not found" banner next
    // to a control that still shows the microphone on.
    for (const mode of ['none', 'stuck', 'disabledOn', 'staleBanner']) {
      const { code, url } = fake.newRoom();
      fake.toggles(code, mode);
      const r = await c.call('meeting_join', { url });
      assert.equal(r.isError, true, mode);
      assert.match(r.text, /could not make sure the microphone is off/, mode);
      assert.equal(fake.room(code).guest, null, `${mode}: never asked to join`);
    }
    await until(() => svc.manager.used === 0, 10_000);
    await c.close();
  });
});

test('meeting state comes from the page, not from what participants control: names and chat lines', async () => {
  await withService(async (svc, ev) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    fake.open(code);
    fake.setOthers(code, ['The call has ended', 'You have been removed']);
    const id = (await c.call('meeting_join', { url })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    fake.say(code, 'Alex Example', 'The call has ended');
    await sleep(1000);
    assert.equal((await status(c, id)).state, 'recording');
    fake.end(code); // the real banner, with the same words already in the chat
    await until(() => ev.ended.length === 1, 10_000);
    assert.equal(ev.ended[0].reason, 'meeting-ended');
    await c.close();
  });
});

test('meeting_stop_recording before recording has started: it never starts', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    const id = (await c.call('meeting_join', { url })).json().meeting_id;
    assert.equal((await status(c, id)).state, 'waiting');
    assert.deepEqual((await c.call('meeting_stop_recording', { meeting_id: id })).json(), { stopped: false, deleted: false, recording_disabled: true, state: 'waiting' });
    fake.admit(code);
    await until(async () => fake.room(code).chat.length === 2, 15_000); // announced
    await sleep(800);
    assert.equal((await status(c, id)).state, 'admitted');
    assert.equal(audio.recorders.length, 0);
    await c.call('meeting_leave', { meeting_id: id });
    await until(() => ev.ended.length === 1);
    assert.equal(ev.ended[0].recording, null);
    await c.close();
  });
});

test('an objection during a graceful stop kills the recorder and deletes the file at once', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    fake.open(code);
    const id = (await c.call('meeting_join', { url, leave_on_optout: false })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    const file = (await status(c, id)).recording.path;
    const keep = c.call('meeting_stop_recording', { meeting_id: id, delete: false }); // takes 5 s to finish cleanly
    await sleep(300);
    fake.say(code, 'Alex Example', 'Nenahrávajte ma, prosím');
    await until(() => ev.optout.length === 1, 4000);
    assert.equal(audio.recorders[0].killed, true);
    assert.equal(fs.existsSync(file), false);
    await keep;
    assert.equal(fs.existsSync(file), false);
    assert.equal((await status(c, id)).recording, 'deleted');
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  }, { audioOpts: { stopMs: 5000 } });
});

test('leaving while the meeting is still setting up releases its audio server and browser; capacity is checked before anything starts', async () => {
  await withService(async (svc, ev, audio) => {
    const { url } = fake.newRoom();
    const p = svc.meetings.join('alice', { url });
    await until(() => svc.meetings.active.size === 1);
    const [m] = svc.meetings.active.values();
    await svc.meetings.leave('alice', m.id); // the audio server is still starting
    await p.catch(() => {});
    await until(() => audio.stats.closed === audio.stats.opened && svc.manager.used === 0, 10_000);
    assert.equal(audio.stats.opened, 1);
    // MAX_SESSIONS is 4 here: four meetings setting up hold the four slots; a fifth starts nothing.
    const joins = Array.from({ length: 4 }, () => svc.meetings.join('alice', { url: fake.newRoom().url }).catch((e) => e));
    await until(() => svc.meetings.active.size === 4);
    await assert.rejects(svc.meetings.join('alice', { url: fake.newRoom().url }), /session limit/);
    await sleep(100);
    assert.equal(audio.stats.opened, 5);
    for (const x of [...svc.meetings.active.values()]) await svc.meetings.leave('alice', x.id);
    await Promise.all(joins);
    await until(() => audio.stats.closed === audio.stats.opened && svc.manager.used === 0, 15_000);
  }, { audioOpts: { openMs: 1500 } });
});

test('the meeting browser asks for English: hl=en on the URL and Accept-Language en-US', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    const id = (await c.call('meeting_join', { url })).json().meeting_id;
    const [load] = fake.room(code).loads;
    assert.equal(load.hl, 'en');
    assert.match(load.acceptLanguage, /^en-US/);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('a German Meet UI without devices (as on a de-AT server): "Ihr Name", "Teilnahme erbitten", "Kamera nicht gefunden" -> joins, chats, ends', async () => {
  await withService(async (svc, ev) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    fake.set(code, { lang: 'de', toggles: 'nodevices' });
    const r = await c.call('meeting_join', { url });
    assert.equal(r.isError, false, r.text);
    const id = r.json().meeting_id;
    assert.equal(r.json().state, 'waiting');
    assert.deepEqual(fake.room(code).guest, { name: 'Glassy (notetaker)', mic: false, cam: false });
    fake.admit(code);
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    assert.equal(fake.room(code).chat.length, 2); // announced through the German chat box
    fake.say(code, 'Alex Example', 'Bitte nicht aufnehmen');
    await until(() => ev.optout.length === 1, 5000);
    await until(() => ev.ended.length === 1, 10_000);
    assert.ok(fake.room(code).left, 'left through "Anruf verlassen"');
    const { code: code2, url: url2 } = fake.newRoom();
    fake.set(code2, { lang: 'de', toggles: 'nodevices', open: true });
    const id2 = (await c.call('meeting_join', { url: url2 })).json().meeting_id;
    await until(async () => (await status(c, id2)).state === 'recording', 15_000);
    fake.end(code2); // "Der Anruf wurde beendet"
    await until(() => ev.ended.some((e) => e.meeting_id === id2), 10_000);
    assert.equal(ev.ended.find((e) => e.meeting_id === id2).reason, 'meeting-ended');
    await c.close();
  });
});

test('a name field without label or placeholder is found as the only text box', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    fake.set(code, { bareName: true });
    const id = (await c.call('meeting_join', { url, name: 'Notes Bot' })).json().meeting_id;
    assert.equal(fake.room(code).guest.name, 'Notes Bot');
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('Google refusing the guest ("You can\'t join this video call", EN and DE) ends with refused_by_google and a clear hint; navigate does not call it a captcha', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    for (const lang of ['en', 'de']) {
      const { code, url } = fake.newRoom();
      fake.set(code, { lang, refuse: true });
      const r = await c.call('meeting_join', { url });
      assert.equal(r.isError, true, lang);
      assert.match(r.text, /Google refused to let this guest join .*signed in to a Google account.*residential IP/, lang);
      assert.doesNotMatch(r.text, /captcha/i);
      assert.ok(fake.room(code).guest, `${lang}: asked to join first`);
    }
    await until(() => ev.ended.length === 2, 10_000);
    assert.deepEqual(ev.ended.map((e) => e.reason), ['refused_by_google', 'refused_by_google']);
    assert.equal(audio.recorders.length, 0);
    await until(() => svc.manager.used === 0, 10_000);
    // Refused only after a while, with no waiting room in between: still Google, not the host.
    const late = fake.newRoom();
    fake.set(late.code, { refuse: true, refuseAfterMs: 7000 });
    const lid = (await c.call('meeting_join', { url: late.url })).json().meeting_id;
    await until(() => ev.ended.some((e) => e.meeting_id === lid), 20_000);
    assert.equal(ev.ended.find((e) => e.meeting_id === lid).reason, 'refused_by_google');
    assert.match((await status(c, lid)).error, /signed in to a Google account/);
    await c.close();
  });
});

test('the bot-wall check: Meet\'s refusal page (on Meet, as a heading, invisible reCAPTCHA) is a refusal; anything else with a challenge stays a captcha', async () => {
  const { wall, MEET_REFUSED } = await import('../src/tools.mjs');
  await withService(async (svc) => {
    const c = await connect(svc);
    const s = await c.open();
    const page = svc.manager.sessions.get(s).page;
    const show = async (opts) => {
      const { code, url } = fake.newRoom();
      fake.set(code, { phase: 'refused', ...opts });
      await page.goto(url);
      await until(async () => (await page.locator('#refused').isVisible()), 5000);
    };
    const meetHost = new URL(fake.base).hostname;
    await show({ lang: 'de' });
    assert.equal(await wall(page, { meetHost }), MEET_REFUSED);
    assert.equal(await wall(page), 'captcha'); // not on Meet: the reCAPTCHA frame counts as usual
    assert.match((await c.call('navigate', { session: s, url: page.url() })).json().blocked, /captcha/);
    await show({ bigChallenge: true }); // a visible challenge on the refusal page: a captcha after all
    assert.equal(await wall(page, { meetHost }), 'captcha');
    await page.setContent('<h1>Help</h1><p>If you see "You can’t join this video call", try again.</p><iframe src="https://example.com/recaptcha/api2/anchor"></iframe>');
    assert.equal(await wall(page, { meetHost }), 'captcha'); // quoted in text, not Meet's heading (and setContent keeps the URL)
    await c.close();
  });
});

test('joining with a signed-in profile: no name field (the account name is used), "Join now"; unknown profiles are refused', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const s = await c.open({ profile: 'google', engine: 'chromium' }); // where the human signed in to Google earlier
    await c.call('session_close', { session: s });
    const { code, url } = fake.newRoom();
    fake.set(code, { signedIn: true, open: true, searchBox: true });
    const r = await c.call('meeting_join', { url, profile: 'google' });
    assert.equal(r.isError, false, r.text);
    const id = r.json().meeting_id;
    assert.deepEqual(fake.room(code).guest, { name: null, mic: false, cam: false, search: '' }); // the search box is left alone
    const session = [...svc.manager.sessions.values()].find((x) => x.owner === `meeting:${id}`);
    assert.equal(session.profile, 'google');
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    await c.call('meeting_leave', { meeting_id: id });
    assert.match((await c.call('meeting_join', { url: fake.newRoom().url, profile: 'nobody' })).text, /no profile nobody: open it with session_open/);
    if (process.env.ENGINE === 'camoufox') { // a Firefox profile can't host a meeting
      const f = await c.open({ profile: 'firefox' });
      await c.call('session_close', { session: f });
      assert.match((await c.call('meeting_join', { url: fake.newRoom().url, profile: 'firefox' })).text, /Firefox \(camoufox\) profile; meetings need a Chromium profile/);
    }
    await c.close();
  });
});
