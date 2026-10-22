// Keepalive: visit persistent profiles on a schedule so sliding login sessions don't expire. No model involved: the
// service opens the profile with the engine and mode it is normally used with, loads one URL, moves the mouse and
// scrolls a little like a person reading (no clicks, no typing, no navigation), checks that it is still logged in,
// and closes it again. A logged-out profile or a bot check is reported as a needs-human event; nothing is retried
// before the next scheduled visit. A visit can also watch one value on the page (a counter such as "43 neue
// Nachrichten", or a short text) and report when it changed. Only the check result and the watched value are kept,
// never page content.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { glidePath } from './liveview.mjs';
import { readProfileMeta } from './engines.mjs';
import { httpUrl } from './sessions.mjs';

export const HISTORY = 10; // results kept per profile
const MIN_GAP_MS = 15 * 60_000; // a visit is never scheduled closer than this to the previous one
const BUSY_RETRY_MIN = [10, 20]; // service at capacity: try again in 10–20 min
const TICK_MS = 30_000;
const GAP_MS = [60_000, 300_000]; // between two visits of different profiles
const ACTIVITY_MS = [20_000, 60_000];
const CHECK_TIMEOUT_MS = 5000;
export const MIN_PERIOD_MIN = 30;
const QUIET_FACTOR = 4; // the interval is this much longer during quiet hours
export const WATCH_MAX_TEXT = 200;
const WATCH_SCAN_CHARS = 200_000; // page text a watch regex looks at, at most

const between = (rnd, [a, b]) => a + (b - a) * rnd();

// quiet_hours "22-08" or "22:30-07:15" (local time, may wrap past midnight) -> {start, end} in minutes of the day.
export function parseQuiet(q) {
  const m = /^(\d{1,2})(?::(\d{2}))?-(\d{1,2})(?::(\d{2}))?$/.exec(String(q).trim());
  const min = m && [[m[1], m[2]], [m[3], m[4]]].map(([h, mm]) => (Number(h) === 24 && !Number(mm) ? 0 : Number(h) < 24 && Number(mm || 0) < 60 ? Number(h) * 60 + Number(mm || 0) : NaN));
  if (!min || min.some(Number.isNaN)) throw new Error('quiet_hours must look like "22-08" or "22:30-07:00"');
  if (min[0] === min[1]) throw new Error('quiet_hours must not start and end at the same time');
  return { start: min[0], end: min[1] };
}

const formatters = new Map();
// The wall clock in time zone tz at instant t, as if it were UTC (so wall(t) - t is the zone's offset then).
function wall(t, tz) {
  if (!formatters.has(tz)) formatters.set(tz, new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  const p = Object.fromEntries(formatters.get(tz).formatToParts(t).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) + (((t % 1000) + 1000) % 1000);
}
const offset = (t, tz) => wall(t, tz) - t;
const inQuiet = (m, q) => (q.start < q.end ? m >= q.start && m < q.end : m >= q.start || m < q.end);

// The first instant in (a, b] where the zone's offset differs from the one at a (a DST change), to the second.
function transition(a, b, tz) {
  const off = offset(a, tz);
  while (b - a > 1000) {
    const mid = a + Math.floor((b - a) / 2000) * 1000 || a + 1000;
    if (offset(mid, tz) === off) a = mid; else b = mid;
  }
  return b;
}

// `from` plus `ms` of schedule time, where quiet hours (local wall-clock time in tz) run QUIET_FACTOR times slower:
// a 30 min interval that starts at 21:50 with quiet hours 22-08 ends at 23:20 (10 min, then 20 min x4). The time is
// integrated piece by piece between quiet edges and DST changes, so a skipped or repeated hour is counted as it
// really passes.
export function advance(from, ms, quiet, tz) {
  if (!quiet) return from + ms;
  let t = from, left = ms;
  for (let i = 0; i < 1000 && left > 0; i++) {
    const off = offset(t, tz);
    const m = ((((t + off) % 86_400_000) + 86_400_000) % 86_400_000) / 60_000;
    const q = inQuiet(m, quiet);
    const edge = q ? quiet.end : quiet.start;
    let next = t + ((((edge - m) % 1440) + 1440) % 1440 || 1440) * 60_000; // right while the offset stays the same
    if (offset(next, tz) !== off) next = transition(t, next, tz);
    const rate = q ? 1 / QUIET_FACTOR : 1; // schedule time per real time
    if (left <= (next - t) * rate) return t + left / rate;
    left -= (next - t) * rate;
    t = next;
  }
  return t + left;
}

// Interval in minutes of a schedule ({everyMinutes} or {everyHours}).
export const periodMin = (e) => e.everyMinutes ?? e.everyHours * 60;

// When the next visit is due: one interval after `from`, shifted by up to ±jitterMin (both stretched during quiet
// hours), never sooner than MIN_GAP_MS.
export function nextRun(from, e, rnd = Math.random, tz = 'Europe/Vienna') {
  const ms = periodMin(e) * 60_000 + (rnd() * 2 - 1) * e.jitterMin * 60_000;
  const quiet = e.quietHours ? parseQuiet(e.quietHours) : null;
  return Math.round(Math.max(from + MIN_GAP_MS, advance(from, ms, quiet, tz)));
}

// logged_in_check: every given condition must hold. Returns {ok, reason}; reason names the failed condition, not
// anything from the page.
export async function evaluateCheck(page, check) {
  if (check.url_not_contains && page.url().includes(check.url_not_contains)) return { ok: false, reason: 'url contains url_not_contains' };
  if (check.selector) {
    const seen = await page.locator(check.selector).first().waitFor({ state: 'visible', timeout: CHECK_TIMEOUT_MS }).then(() => true, () => false);
    if (!seen) return { ok: false, reason: 'selector not visible' };
  }
  if (check.text) {
    const seen = await page.getByText(check.text).first().waitFor({ state: 'visible', timeout: CHECK_TIMEOUT_MS }).then(() => true, () => false);
    if (!seen) return { ok: false, reason: 'text not found' };
  }
  return { ok: true };
}

// watch: {selector?, text_regex?, kind: count|text}. The text is the selector's textContent (default: the page's
// visible text); text_regex picks the part that matters (its first capture group, else the whole match). The regex
// runs in the page, never in the service, and only the result crosses over. kind count: the first whole number in it
// (thousands separators ignored); no match counts as 0 (a badge that vanishes when nothing is new). kind text: the
// text with whitespace collapsed, at most WATCH_MAX_TEXT chars; no match is null. Throws if it can't be read.
export async function extractWatch(page, w, { timeoutMs = CHECK_TIMEOUT_MS, signal } = {}) {
  let raw = null;
  const root = w.selector ? page.locator(w.selector).first() : page.locator('body');
  // Absent means the selector matched nothing for timeoutMs. A selector error or a closed page throws (count()
  // does), so a failed read is never mistaken for "nothing new".
  const end = Date.now() + timeoutMs;
  let found = false;
  for (;;) {
    if (signal?.aborted) throw new Error('aborted');
    if ((found = (await root.count()) > 0) || Date.now() >= end) break;
    await sleep(Math.min(250, Math.max(0, end - Date.now())), signal);
  }
  if (found) {
    let timer;
    const read = root.evaluate((el, [bySelector, src, max]) => {
      const t = String((bySelector ? el.textContent : el.innerText) || '').slice(0, max);
      if (!src) return t.slice(0, 2000);
      const m = new RegExp(src).exec(t);
      return m ? String(m[1] ?? m[0]).slice(0, 2000) : null;
    }, [!!w.selector, w.textRegex || null, WATCH_SCAN_CHARS]);
    raw = await Promise.race([read, new Promise((_, no) => { timer = setTimeout(() => no(new Error('watch timeout')), timeoutMs); })]).finally(() => clearTimeout(timer));
    if (raw !== null && typeof raw !== 'string') throw new Error('watch read failed');
  }
  if (signal?.aborted) throw new Error('aborted');
  if (w.kind === 'count') {
    if (raw === null) return 0;
    const n = /\d(?:[\d.,'\u00a0\u202f]*\d)?/.exec(raw)?.[0].replace(/\D/g, '');
    if (!n) throw new Error('no number in the watched text');
    return Math.min(Number(n), Number.MAX_SAFE_INTEGER);
  }
  return raw === null ? null : raw.replace(/\s+/g, ' ').trim().slice(0, WATCH_MAX_TEXT);
}

// Whether a watched value changed in a way worth telling: a count that went up, a text that differs.
export const watchChanged = (kind, old, now) => (kind === 'count' ? now > old : now !== old);

const sleep = (ms, signal) => new Promise((r) => {
  if (signal?.aborted) return r();
  const onAbort = () => { clearTimeout(t); r(); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); r(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

// About `ms` of reading-like activity: 3–6 pointer glides along the live view's human path, 1–3 scrolls (mostly
// down), sometimes a pause over a link, with pauses in between. Only page.mouse.move / wheel: nothing is clicked.
export async function humanActivity(page, ms, { rnd = Math.random, signal } = {}) {
  const vp = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const point = () => ({ x: Math.round(vp.width * between(rnd, [0.08, 0.92])), y: Math.round(vp.height * between(rnd, [0.1, 0.9])) });
  let pos = point();
  await page.mouse.move(pos.x, pos.y);
  const glide = async (to) => {
    for (const pt of glidePath(pos, to, rnd)) {
      if (signal?.aborted) return;
      await page.mouse.move(pt.x, pt.y);
      await sleep(between(rnd, [8, 22]), signal);
    }
    pos = to;
  };
  const actions = [
    ...Array(3 + Math.floor(rnd() * 4)).fill('move'),
    ...Array(1 + Math.floor(rnd() * 3)).fill('scroll'),
    ...(rnd() < 0.6 ? ['hover'] : []),
  ];
  for (let i = actions.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [actions[i], actions[j]] = [actions[j], actions[i]]; }
  const end = Date.now() + ms;
  const done = { move: 0, scroll: 0, hover: 0 };
  for (let i = 0; i < actions.length && !signal?.aborted; i++) {
    const a = actions[i];
    if (a === 'move') await glide(point());
    else if (a === 'scroll') {
      const dir = rnd() < 0.8 ? 1 : -1, total = between(rnd, [150, 600]);
      for (let left = total; left > 0 && !signal?.aborted; left -= 100) { await page.mouse.wheel(0, dir * Math.min(100, left)); await sleep(between(rnd, [30, 90]), signal); }
    } else {
      const links = page.locator('a[href]:visible');
      const n = Math.min(await links.count().catch(() => 0), 20);
      const box = n ? await links.nth(Math.floor(rnd() * n)).boundingBox({ timeout: 1000 }).catch(() => null) : null;
      const inView = box && box.y >= 0 && box.y + box.height <= vp.height;
      await glide(inView ? { x: Math.round(box.x + box.width * between(rnd, [0.3, 0.7])), y: Math.round(box.y + box.height / 2) } : point());
    }
    done[a]++;
    const left = end - Date.now(), steps = actions.length - i;
    await sleep(Math.max(0, left / steps * between(rnd, [0.6, 1.4])), signal);
  }
  const rest = end - Date.now();
  if (rest > 0 && !signal?.aborted) await sleep(rest, signal);
  return done;
}

// Persisted configuration and results, one file on the data volume next to profiles/.
class Store {
  constructor(file) {
    this.file = file;
    this.entries = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const e of data.entries || []) this.entries.set(`${e.tenant}/${e.profile}`, e);
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`keepalive: cannot read ${file}: ${e.message}`);
    }
  }
  // Throws on failure; dirty stays set so the next tick retries.
  save() {
    this.dirty = true;
    const tmp = `${this.file}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...this.entries.values()] }, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    this.dirty = false;
  }
}

export class Keepalive {
  // opts: emit(event) for needs-human, onWatch(event) for a changed watch value; rnd/now for tests; tickMs, gapMs,
  // activityMs, wall (bot-check detector).
  constructor({ cfg, manager, emit = () => {}, onWatch = () => {}, wall = async () => null, rnd = Math.random, now = Date.now, tickMs = TICK_MS, gapMs = GAP_MS, activityMs = ACTIVITY_MS }) {
    Object.assign(this, { cfg, manager, emit, onWatch, wall, rnd, now, tickMs, gapMs, activityMs });
    this.tz = cfg.tz || 'Europe/Vienna';
    this.store = new Store(path.join(cfg.dataDir, 'keepalive.json'));
    this.current = null; // {key, abort, done}
    this.notBefore = 0; // spacing between visits
    this.timer = null;
    this.stopped = false;
  }

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.tickMs);
    this.timer.unref();
  }

  // Aborts a running visit and closes its browser at once; waits for it only briefly (shutdown's own close of all
  // sessions and pending opens is bounded and follows).
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    const run = this.current;
    if (!run) return;
    run.abort();
    if (run.session) this.manager.dispose(run.session, 'shutdown');
    await Promise.race([run.done, sleep(3000)]);
  }

  // Background saves (after a visit, a skip) report failures instead of losing them; the next tick retries.
  persist() {
    try { this.store.save(); } catch (e) { console.error(`bosun keepalive: cannot save ${this.store.file}: ${e.code || e.message}`); }
  }

  profileDir(tenant, profile) { return path.join(this.cfg.dataDir, 'profiles', tenant, profile); }

  nextRun(from, e) { return nextRun(from, e, this.rnd, this.tz); }

  // Schedule: everyMinutes (>= MIN_PERIOD_MIN) or everyHours (default 12); jitterMin defaults to 30 or a quarter of
  // the interval, whichever is less. watch: {selector?, textRegex?, kind, label}.
  set(tenant, { profile, url, everyHours, everyMinutes, jitterMin, quietHours = null, check, watch = null, enabled = true }) {
    url = this.manager.checkAllowed(tenant, httpUrl(url));
    if (!fs.existsSync(this.profileDir(tenant, profile))) throw new Error(`no profile ${profile}: open it once with session_open({profile}) and log in first`);
    if (everyHours != null && everyMinutes != null) throw new Error('give every_hours or every_minutes, not both');
    if (everyMinutes != null && !(Number.isInteger(everyMinutes) && everyMinutes >= MIN_PERIOD_MIN)) throw new Error(`every_minutes must be a whole number of at least ${MIN_PERIOD_MIN}`);
    if (everyMinutes == null) everyHours ??= 12;
    const period = everyMinutes ?? everyHours * 60;
    jitterMin ??= Math.min(30, Math.floor(period / 4));
    if (jitterMin * 2 > period) throw new Error(`jitter_min must be at most half of the interval (${period} min)`);
    if (quietHours) parseQuiet(quietHours);
    if (!check || !(check.text || check.selector || check.url_not_contains)) throw new Error('logged_in_check needs text, selector or url_not_contains');
    if (watch) {
      if (!watch.selector && !watch.textRegex) throw new Error('watch needs selector or text_regex');
      if (watch.textRegex) { try { new RegExp(watch.textRegex); } catch { throw new Error('watch.text_regex is not a valid regular expression'); } }
      if (watch.kind !== 'count' && watch.kind !== 'text') throw new Error('watch.kind must be count or text');
      if (!watch.label) throw new Error('watch needs a label');
    }
    const key = `${tenant}/${profile}`;
    const old = this.store.entries.get(key);
    const rescheduled = !old || !old.enabled || periodMin(old) !== period || old.jitterMin !== jitterMin || (old.quietHours || null) !== (quietHours || null);
    // Updated in place: a visit running right now records its result on this same entry.
    const e = old || { tenant, profile, nextAt: null, history: [], lastSkip: null, created: this.now() };
    const w = watch && Object.fromEntries(['selector', 'textRegex', 'kind', 'label'].filter((k) => watch[k]).map((k) => [k, watch[k]]));
    // Watching something else, or on another page, starts from a new baseline (and a new generation, so a visit
    // still running for the old one can't record into it); a new label alone keeps it.
    const sameWatch = w && e.watch && e.url === url && ['selector', 'textRegex', 'kind'].every((k) => (w[k] || null) === (e.watch[k] || null));
    if (!sameWatch) { delete e.watchState; e.watchGen = (e.watchGen || 0) + 1; }
    delete e.everyHours; delete e.everyMinutes;
    Object.assign(e, {
      url, ...(everyMinutes != null ? { everyMinutes } : { everyHours }), jitterMin, quietHours: quietHours || null, enabled,
      check: Object.fromEntries(['text', 'selector', 'url_not_contains'].filter((k) => check[k]).map((k) => [k, check[k]])),
      watch: w || null,
    });
    if (enabled && (rescheduled || !e.nextAt)) e.nextAt = this.nextRun(this.now(), e);
    this.store.entries.set(key, e);
    this.store.save();
    return this.view(e);
  }

  remove(tenant, profile) {
    const key = `${tenant}/${profile}`;
    if (!this.store.entries.delete(key)) throw new Error(`no keepalive for profile ${profile}`);
    this.store.save();
    if (this.current?.key === key) this.current.abort();
    return { removed: profile };
  }

  list(tenant) { return [...this.store.entries.values()].filter((e) => e.tenant === tenant).map((e) => this.view(e)); }

  view(e) {
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    return {
      profile: e.profile, url: e.url, ...(e.everyMinutes != null ? { every_minutes: e.everyMinutes } : { every_hours: e.everyHours }), jitter_min: e.jitterMin,
      ...(e.quietHours ? { quiet_hours: e.quietHours, tz: this.tz } : {}), logged_in_check: e.check,
      ...(e.watch ? { watch: {
        ...(e.watch.selector ? { selector: e.watch.selector } : {}), ...(e.watch.textRegex ? { text_regex: e.watch.textRegex } : {}), kind: e.watch.kind, label: e.watch.label,
        value: e.watchState ? e.watchState.value : null, ...(e.watchState ? { read_at: iso(e.watchState.at), changed_at: iso(e.watchState.changedAt) } : { baseline: 'not read yet' }),
      } } : {}),
      enabled: e.enabled, next_run: e.enabled ? iso(e.nextAt) : null, running: this.current?.key === `${e.tenant}/${e.profile}`,
      last: e.history.slice(-HISTORY).reverse().map((r) => ({ at: iso(r.at), status: r.status, duration_ms: r.durationMs, ...(r.reason ? { reason: r.reason } : {}), ...(r.watch ? { watch: r.watch } : {}) })),
      ...(e.lastSkip ? { last_skip: { at: iso(e.lastSkip.at), reason: e.lastSkip.reason } } : {}),
    };
  }

  // Runs at most one due visit. Visits are spread: one at a time, gapMs apart, the most overdue first.
  async tick() {
    if (this.store.dirty) this.persist();
    if (this.current || this.stopped || this.manager.closing) return null;
    const now = this.now();
    if (now < this.notBefore) return null;
    const due = [...this.store.entries.values()].filter((e) => e.enabled && e.nextAt && e.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt)[0];
    if (!due) return null;
    const key = `${due.tenant}/${due.profile}`;
    const m = this.manager;
    // An agent has the profile open (or it is still closing): the profile is in use anyway; the next visit comes a
    // full period later.
    if (m.profilesInUse.has(key)) return this.skip(due, 'profile in use', this.nextRun(now, due));
    // Leave agents a free slot (where there is more than one): a visit is background work.
    const room = (used, max) => used < max - (max > 1 ? 1 : 0);
    if (!room(m.used, this.cfg.maxSessions) || !room(m.tenantUse.get(due.tenant) || 0, this.cfg.maxSessionsPerTenant)) {
      return this.skip(due, 'session limit reached', now + Math.round(between(this.rnd, BUSY_RETRY_MIN) * 60_000));
    }
    const ac = new AbortController();
    const run = { key, abort: () => ac.abort(), session: null };
    run.done = this.visit(due, ac.signal, run).finally(() => {
      if (this.current === run) this.current = null;
      m.preemptible.delete(key);
      this.notBefore = this.now() + Math.round(between(this.rnd, this.gapMs));
    });
    this.current = run;
    // An agent opening this profile meanwhile takes it over: the visit stops and its session closes first.
    m.preemptible.set(key, async () => { ac.abort(); if (run.session) await m.dispose(run.session, 'keepalive-preempted'); await run.done; });
    return run.done;
  }

  skip(e, reason, nextAt) {
    e.lastSkip = { at: this.now(), reason };
    e.nextAt = nextAt;
    this.persist();
    return { skipped: reason };
  }

  // A visit's watched value against the stored one. The first value is the baseline (no event); after that a count
  // that went up or a text that differs is an event. A count that went down is kept silently, so the next rise is
  // measured from there. Returns what happened, for the history.
  recordWatch(e, watch, { value, error }, url, gen) {
    // keepalive_set changed what is watched (or where) while this visit ran: the value belongs to the old watch.
    if (!e.watch || e.watchGen !== gen) return null;
    if (error) return error;
    const at = this.now(), prev = e.watchState;
    if (!prev) { e.watchState = { value, at, changedAt: null }; return 'baseline'; }
    if (value === prev.value) { prev.at = at; return 'unchanged'; }
    const changed = watchChanged(watch.kind, prev.value, value);
    e.watchState = { value, at, changedAt: changed ? at : prev.changedAt };
    if (!changed) return 'lower';
    const ev = { tenant: e.tenant, profile: e.profile, label: e.watch.label, old: prev.value, new: value, url };
    Promise.resolve().then(() => this.onWatch(ev)).catch(() => {});
    return 'changed';
  }

  engineFor(meta) {
    if (meta?.engine) return meta.engine;
    if (meta?.family === 'firefox') return 'camoufox';
    return this.cfg.engine === 'camoufox' ? 'chromium' : this.cfg.engine;
  }

  // Error reasons are fixed categories or Bosun's own messages, never raw browser errors (which can quote the page).
  async visit(e, signal, run) {
    const t0 = this.now();
    const m = this.manager;
    const owner = `keepalive:${e.tenant}`;
    const key = `${e.tenant}/${e.profile}`;
    const { url, check, watch, watchGen } = { url: e.url, check: { ...e.check }, watch: e.watch && { ...e.watch }, watchGen: e.watchGen }; // this visit's configuration
    let status = 'error', reason = null, s = null, phase = 'open', watched = null;
    try {
      try { httpUrl(url); } catch { reason = 'url is not http(s)'; throw new Error(reason); }
      // The tenant's allowlist may have changed since the schedule was set.
      try { this.manager.checkAllowed(e.tenant, url); } catch { reason = 'url is not in the host allowlist'; throw new Error(reason); }
      const meta = readProfileMeta(this.profileDir(e.tenant, e.profile));
      // Same mode as normal use, so the fingerprint stays consistent: never open a headful profile headless.
      if (this.cfg.headless && meta?.headless !== true) { reason = 'profile is used headful; keepalive will not open it headless (run the service headful)'; throw new Error(reason); }
      try {
        s = run.session = await m.open({ owner, tenant: e.tenant, profile: e.profile, engine: this.engineFor(meta), preempt: false });
      } catch (err) {
        reason = /^(engine \S+ (is not installed|: browser binary missing)|session limit|profile \S+ is already open|profile was created with|service is shutting down)/.test(err?.message || '')
          ? String(err.message).split('\n')[0].slice(0, 200) : 'could not open the profile';
        throw err;
      }
      if (signal.aborted) throw new Error('aborted');
      const r = await m.run(owner, s.id, async (ss) => {
        phase = 'navigate';
        try {
          await ss.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        } catch (err) {
          const code = /\b(net::ERR_[A-Z_]+|NS_ERROR_[A-Z_]+)\b/.exec(err?.message || '')?.[1];
          reason = /Timeout/.test(err?.name || '') || /timeout/i.test(err?.message || '') ? 'navigation timeout' : `navigation failed${code ? ` (${code})` : ''}`;
          throw err;
        }
        await ss.page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
        phase = 'activity';
        if (await this.wall(ss.page)) return { status: 'bot_check', reason: 'bot check page' };
        await humanActivity(ss.page, Math.round(between(this.rnd, this.activityMs)), { rnd: this.rnd, signal });
        if (signal.aborted) throw new Error('aborted');
        phase = 'check';
        if (await this.wall(ss.page)) return { status: 'bot_check', reason: 'bot check page' };
        const c = await evaluateCheck(ss.page, check);
        if (!c.ok) return { status: 'logged_out', reason: c.reason };
        if (watch) {
          phase = 'watch';
          watched = await extractWatch(ss.page, watch, { signal }).then((value) => ({ value }), (err) => {
            if (signal.aborted) throw err; // taken over: the visit is aborted, nothing is recorded
            return { error: /^(watch timeout|no number in the watched text)$/.test(err?.message || '') ? err.message : 'watch failed' };
          });
          if (signal.aborted) throw new Error('aborted');
        }
        return { status: 'ok' };
      });
      ({ status, reason = null } = r);
    } catch {
      if (signal.aborted) status = 'aborted';
      else if (!reason) reason = `${phase} failed`;
    } finally {
      if (s) await m.dispose(s, 'keepalive-done');
    }
    if (this.store.entries.get(key) !== e) return { status }; // removed (or removed and re-added) meanwhile
    if (status === 'aborted') {
      this.skip(e, this.stopped ? 'service stopped' : 'taken over by an agent', e.nextAt <= this.now() && !this.stopped ? this.nextRun(this.now(), e) : e.nextAt);
      return { status };
    }
    const w = status === 'ok' && watched ? this.recordWatch(e, watch, watched, url, watchGen) : null;
    e.history.push({ at: t0, status, durationMs: this.now() - t0, ...(reason ? { reason } : {}), ...(w ? { watch: w } : {}) });
    if (e.history.length > HISTORY) e.history.splice(0, e.history.length - HISTORY);
    e.nextAt = this.nextRun(this.now(), e);
    // The human has to hear about it even if the result can't be saved right now.
    if (status === 'logged_out' || status === 'bot_check') {
      Promise.resolve().then(() => this.emit({ tenant: e.tenant, profile: e.profile, url, kind: status, reason })).catch(() => {});
    }
    this.persist();
    return { status, reason, ...(w ? { watch: w } : {}) };
  }
}
