// The real audio pipeline (Linux with PulseAudio, ffmpeg and a display, e.g. under xvfb-run; skipped elsewhere): a
// meeting page playing a 440 Hz tone ends up as a non-empty Ogg/Opus file (16 kHz mono, ~24 kbps, mode 0600), and a
// silent meeting recorded at the same time stays silent (each session has its own audio server); a Zoom meeting is
// recorded the same way once computer audio is joined.
//   docker build -f docker/meeting-test.Dockerfile -t bosun-meeting-test docker
//   docker run --rm -v "$PWD":/app -w /app bosun-meeting-test xvfb-run -a node --test test/meeting-audio.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { startBosun, connect, until, sleep } from './helpers.mjs';
import { startFakeMeet } from './fakemeet.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { audioUnsupported } from '../src/meetings/audio.mjs';

const why = (await audioUnsupported()) || (!process.env.DISPLAY ? 'no display (run under xvfb-run)' : null) ||
  (process.env.ENGINE && process.env.ENGINE !== 'chromium' ? `engine ${process.env.ENGINE}: the pipeline is tested with chromium` : null);

let loud, quiet;
before(async () => { if (!why) { loud = await startFakeMeet({ tone: true }); quiet = await startFakeMeet(); } });
after(async () => { await loud?.close(); await quiet?.close(); });

const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
const meanDb = (file) => Number(/mean_volume: (-?[\d.]+) dB/.exec(spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']).stderr.toString())[1]);

test('a meeting playing a tone is recorded to Ogg/Opus 16 kHz mono; a silent one recorded at the same time stays silent', { skip: why || false }, async () => {
  const svc = await startBosun({ KEEPALIVE: '0', HEADLESS: '0', ENGINE: 'chromium' }, { meetings: { platformFor: (u) => (u.startsWith(loud.base) || u.startsWith(quiet.base) ? meet : null), pollMs: 300 } });
  const ended = [];
  svc.events.on('meeting-ended', (e) => ended.push(e));
  try {
    const c = await connect(svc);
    const a = loud.newRoom(), b = quiet.newRoom();
    loud.open(a.code); quiet.open(b.code);
    const [ida, idb] = await Promise.all([a, b].map(async (r) => {
      const res = await c.call('meeting_join', { url: r.url });
      assert.equal(res.isError, false, res.text);
      return res.json().meeting_id;
    }));
    for (const id of [ida, idb]) await until(async () => (await c.call('meeting_status', { meeting_id: id })).json().state === 'recording', 30_000);
    await sleep(5000);
    for (const id of [ida, idb]) await c.call('meeting_leave', { meeting_id: id });
    await until(() => ended.length === 2, 15_000);
    const rec = (id) => ended.find((e) => e.meeting_id === id).recording;
    const ra = rec(ida), rb = rec(idb);
    for (const r of [ra, rb]) {
      assert.ok(r.bytes > 1000, `bytes ${r.bytes}`);
      assert.equal(fs.statSync(r.path).size, r.bytes);
      assert.equal(fs.statSync(r.path).mode & 0o777, 0o600);
      const p = probe(r.path);
      assert.equal(p.format.format_name, 'ogg');
      assert.equal(p.streams[0].codec_name, 'opus');
      assert.equal(p.streams[0].channels, 1);
      assert.ok(Number(p.format.duration) >= 3, `duration ${p.format.duration}`);
      assert.ok(Number(p.format.bit_rate) < 40_000, `bit rate ${p.format.bit_rate}`);
    }
    const [la, lb] = [meanDb(ra.path), meanDb(rb.path)];
    assert.ok(la > -30, `tone recording too quiet: ${la} dB`);
    assert.ok(lb < -60, `silent meeting picked up audio: ${lb} dB`);
    // The input rate (16 kHz) is in the Opus header: bytes 12..15 of the OpusHead packet.
    const buf = fs.readFileSync(ra.path);
    const head = buf.indexOf('OpusHead');
    assert.equal(buf.readUInt32LE(head + 12), 16000);
    await c.close();
  } finally {
    await svc.stop();
  }
});

test('Zoom: the meeting is heard once computer audio is joined, and recorded the same way', { skip: why || false }, async () => {
  const { startFakeZoom } = await import('./fakezoom.mjs');
  const { zoom, zoomWebClientUrl } = await import('../src/meetings/platforms/zoom.mjs');
  const z = await startFakeZoom({ tone: true });
  const platform = { ...zoom, joinUrl: (u) => zoomWebClientUrl(u).replace('https://app.zoom.us', z.base), origins: () => [z.base] };
  const svc = await startBosun({ KEEPALIVE: '0', HEADLESS: '0', ENGINE: 'chromium' }, { meetings: { platformFor: (u) => (zoom.matches(u) ? platform : null), pollMs: 300 } });
  const ended = [];
  svc.events.on('meeting-ended', (e) => ended.push(e));
  try {
    const c = await connect(svc);
    const s = await c.open({ profile: 'zoom', engine: 'chromium' });
    await c.call('session_close', { session: s });
    const { url } = z.newRoom({ signedIn: true, open: true });
    const res = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.equal(res.isError, false, res.text);
    const id = res.json().meeting_id;
    await until(async () => (await c.call('meeting_status', { meeting_id: id })).json().state === 'recording', 30_000);
    await sleep(5000);
    await c.call('meeting_leave', { meeting_id: id });
    await until(() => ended.length === 1, 15_000);
    const r = ended[0].recording;
    assert.ok(r.bytes > 1000, `bytes ${r.bytes}`);
    assert.equal(probe(r.path).streams[0].codec_name, 'opus');
    assert.ok(meanDb(r.path) > -30, `tone recording too quiet: ${meanDb(r.path)} dB`);
    await c.close();
  } finally {
    await svc.stop();
    await z.close();
  }
});
