// MCP tool surface. One McpServer per connection; every session lookup is scoped to that connection (owner).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { countNodes, maskText, maskedScreenshot, sensitiveValues } from './redact.mjs';
import { NOT_ALLOWED, PROFILES_REFUSED, TENANT_RE } from './auth.mjs';
import { urlKey, httpUrl } from './sessions.mjs';

export { httpUrl };
import { MANIFEST, mcplConnection } from './events.mjs';
import { MIN_PERIOD_MIN } from './keepalive.mjs';
import { meetRefusalPage } from './meetings/platforms/meet.mjs';

const MAX_SHOT_PX = 8000; // tallest full-page screenshot, CSS px
const POLL_SEC = 50; // default handoff wait: below the MCP SDK's 60 s request timeout

// Heuristic bot-wall detection after navigation/click.
export const MEET_REFUSED = "Google Meet refused this guest (\"You can't join this video call\"), not a captcha: use a profile signed in to Google, or a residential IP";
// opts.meetHost: tests only (a local Meet stand-in).
export async function wall(p, { meetHost } = {}) {
  try {
    const title = (await p.title()).toLowerCase();
    if (/just a moment|nur einen moment|attention required|verify you are human|robot/.test(title)) return 'bot check page';
    // Meet's refusal page embeds an invisible reCAPTCHA but is a refusal: there is nothing to solve.
    if (await meetRefusalPage(p, meetHost ? { meetHost } : {})) return MEET_REFUSED;
    const f = p.frames().map((f) => f.url()).join(' ');
    if (/recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|captcha-delivery|geo\.captcha/.test(f)) return 'captcha';
    const t = (await p.locator('body').innerText({ timeout: 2000 }).catch(() => '')).slice(0, 3000).toLowerCase();
    if (/(kein roboter|not a robot|are you a human|zugriff blockiert|access denied)/.test(t)) return 'bot check text';
  } catch {}
  return null;
}
// A bot check that keeps reloading itself (typically Cloudflare refusing the IP): the page looks like a bot check
// (now, or at the same URL within LOOP_WINDOW_MS) and either had more than LOOP_NAVS main-frame navigations to that
// URL within LOOP_WINDOW_MS, or LOOP_CTX_ERRORS page tools failed because it navigated away under them. A page that
// merely reloads itself (a dashboard) is not reported.
export const BOT_LOOP = 'bot check keeps reloading (likely IP reputation); try engine chromium + request_human, or another network';
const LOOP_WINDOW_MS = 30_000, LOOP_NAVS = 5, LOOP_CTX_ERRORS = 3;
const CTX_GONE = /Execution context was destroyed|interrupted by another navigation/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prune = (arr, now) => { while (arr.length && (arr[0].t ?? arr[0]) < now - LOOP_WINDOW_MS) arr.shift(); };
function reloads(s) {
  prune(s.navs, Date.now());
  const here = urlKey(s.page.url());
  return s.navs.filter((n) => n.at === here).length;
}
// Remember that the page at its current URL looked like a bot check (navigate/click see it before the loop shows).
function noteWall(s, w) { if (w) s.wallSeen = { t: Date.now(), at: urlKey(s.page.url()) }; return w; }
async function looksLikeBotCheck(s) {
  const seen = s.wallSeen;
  if (seen && seen.at === urlKey(s.page.url()) && seen.t > Date.now() - LOOP_WINDOW_MS) return true;
  for (let i = 0; i < 3; i++) { // the title may be mid-reload
    if (noteWall(s, await wall(s.page))) return true;
    await sleep(250);
  }
  return false;
}
async function botLoop(s) {
  prune(s.ctxErrors, Date.now());
  if (reloads(s) <= LOOP_NAVS && s.ctxErrors.length < LOOP_CTX_ERRORS) return false;
  return looksLikeBotCheck(s);
}

const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
async function pageInfo(p) { return { url: p.url(), title: await p.title().catch(() => '') }; }


// Playwright errors carry a call log that can quote page markup; keep only the headline.
const cleanError = (e) => String(e?.message || e).split('\nCall log:')[0].replace(/\x1b\[[0-9;]*m/g, '').slice(0, 500);

// Locate an element: ref (from read a11y: "e12" -> aria-ref), role+name, css, or visible text.
function locate(p, t) {
  if (t.ref) return p.locator(`aria-ref=${t.ref}`);
  if (t.role) return p.getByRole(t.role, t.name ? { name: t.name } : {}).first();
  if (t.selector) return p.locator(t.selector).first();
  if (t.text) return p.getByText(t.text, { exact: false }).first();
  throw new Error('give ref, role(+name), selector or text');
}
const str = (n) => z.string().max(n);
const target = { ref: str(20).optional().describe('element ref from read (e.g. "e12")'), role: str(40).optional(), name: str(1000).optional(), selector: str(2000).optional(), text: str(1000).optional() };
const hasTarget = (a) => !!(a.ref || a.role || a.selector || a.text);

// The tools a token with policy "ephemeral" may call: ephemeral sessions and page tools. No profiles, keepalive,
// meetings or handoff.
export const EPHEMERAL_TOOLS = new Set(['session_open', 'session_close', 'navigate', 'read', 'click', 'type', 'select', 'press', 'back', 'wait_for', 'screenshot', 'sessions']);

export function buildServer({ manager, owner, tenant, cfg, policy = 'full', conn = { inflight: 0 } }) {
  const ephemeral = policy === 'ephemeral';
  // Fork: when this tenant has a host allowlist, say so in the tool description instead of letting the agent guess.
  const allowed = manager.allowList(tenant);
  const allowNote = allowed ? `This token may only reach: ${allowed.map((p) => (p.any ? '*' : `${p.wild ? '*.' : ''}${p.host}${p.port ? `:${p.port}` : ''}`)).join(', ')}.` : null;
  const server = new McpServer({ name: 'bosun', version: '0.7.0' }, { capabilities: ephemeral ? {} : { experimental: { mcpl: MANIFEST } } });
  // MCPL push events (needs-human) for this tenant, once the host has granted them.
  if (manager.events && !ephemeral) {
    const mcpl = mcplConnection(server.server, { bus: manager.events, tenant });
    const prev = server.server.onclose;
    server.server.onclose = () => { mcpl.close(); prev?.(); };
  }
  // Page tools: serialized per session, and turned into BOT_LOOP (success or failure) when the page is stuck in a
  // reloading bot check.
  const run = (id, fn) => manager.run(owner, id, async (s) => {
    let r;
    try {
      r = await fn(s);
    } catch (e) {
      if (CTX_GONE.test(String(e?.message || e))) s.ctxErrors.push(Date.now());
      if (await botLoop(s).catch(() => false)) throw new Error(BOT_LOOP);
      throw e;
    }
    if (await botLoop(s)) throw new Error(BOT_LOOP);
    return r;
  });

  // Every tool: bounded concurrency per connection, sanitized errors. A tool the policy doesn't allow is registered
  // as a stub that only refuses (its handler is never wired up) and is left out of tools/list below.
  const tool = (name, desc, shape, fn) => {
    if (ephemeral && !EPHEMERAL_TOOLS.has(name)) return server.tool(name, NOT_ALLOWED, {}, async () => { throw new Error(`${name}: ${NOT_ALLOWED}`); });
    return server.tool(name, desc, shape, async (a, extra) => {
      if (conn.inflight >= cfg.maxInflight) throw new Error(`too many concurrent requests on this connection (max ${cfg.maxInflight})`);
      conn.inflight++;
      try { return await fn(a, extra); } catch (e) { throw new Error(cleanError(e)); } finally { conn.inflight--; }
    });
  };

  tool('session_open', ephemeral ? `Open an ephemeral browser session (wiped on close). Profiles, and engines other than ${cfg.engine}, are not allowed for this token.` : 'Open a browser session. Without profile: ephemeral (wiped on close). With profile: persistent per-tenant profile (stays logged in).',
    { profile: z.string().regex(TENANT_RE).optional(), locale: str(35).optional(), timezone: str(64).optional(),
      engine: z.enum(cfg.engines).optional().describe(`browser engine (default ${cfg.engine}); enabled here: ${cfg.engines.join(', ')}`) },
    async (a) => {
      if (ephemeral && a.profile !== undefined) throw new Error(PROFILES_REFUSED);
      if (ephemeral && a.engine && a.engine !== cfg.engine) throw new Error(`engine ${a.engine} is ${NOT_ALLOWED}; use the default (${cfg.engine})`);
      const s = await manager.open({ owner, tenant, profile: a.profile, locale: a.locale, timezone: a.timezone, engine: a.engine });
      return ok({ session: s.id, profile: a.profile || 'ephemeral', engine: s.engine });
    });

  tool('session_close', 'Close a session (persistent profile stays on disk).', { session: str(40) }, async ({ session }) => {
    await manager.close(owner, session);
    return ok({ closed: session });
  });

  tool('navigate', allowNote ? `Go to a URL (http/https only). ${allowNote}` : 'Go to a URL (http/https only).', { session: str(40), url: z.string().max(4096).url(), wait: z.enum(['load', 'domcontentloaded', 'networkidle']).optional() }, async (a) => {
    const url = manager.checkAllowed(tenant, httpUrl(a.url));
    return run(a.session, async (s) => {
      const r = await s.page.goto(url, { waitUntil: a.wait || 'domcontentloaded', timeout: 45000 });
      await s.page.waitForTimeout(1200);
      const w = noteWall(s, await wall(s.page));
      const info = await pageInfo(s.page);
      // The browser follows redirects itself; one that left the allowlist got the tenant proxy's refusal instead.
      const refused = r?.status() === 403 && !manager.isAllowed(tenant, info.url);
      return ok({ status: r?.status(), ...info, ...(refused ? { refused: 'host allowlist' } : {}), ...(w ? { blocked: w, hint: 'call request_human to let a person solve it' } : {}) });
    });
  });

  tool('read', 'Read the page. mode a11y (default): accessibility snapshot with element refs [ref=eN] usable by click/type. mode text: visible text. Values of password/PIN/OTP fields are masked.',
    { session: str(40), mode: z.enum(['a11y', 'text']).optional(), selector: str(2000).optional(), maxChars: z.number().int().min(1).max(200000).optional() },
    async (a) => run(a.session, async (s) => {
      const max = a.maxChars ?? 20000;
      const root = a.selector ? s.page.locator(a.selector).first() : s.page.locator('body');
      let out, total;
      if ((a.mode || 'a11y') === 'a11y') {
        if (!a.selector) {
          const nodes = await countNodes(s.page, cfg.maxDomNodes);
          if (nodes > cfg.maxDomNodes) throw new Error(`page has more than ${cfg.maxDomNodes} elements (frames and shadow roots included); read a part of it with selector, or use mode text`);
        }
        out = await (a.selector ? root.ariaSnapshot({ mode: 'ai', timeout: 15000 }) : s.page.ariaSnapshot({ mode: 'ai', timeout: 15000 }));
        total = out.length;
      } else {
        // Truncate in the page so a huge document never crosses the wire whole.
        [total, out] = await root.evaluate((el, n) => { const t = el.innerText.replace(/\n{3,}/g, '\n\n'); return [t.length, t.slice(0, n)]; }, max, { timeout: 15000 });
      }
      out = maskText(out, await sensitiveValues(s.page));
      const info = await pageInfo(s.page);
      return ok(`url: ${info.url}\ntitle: ${info.title}\nchars: ${total}${total > max ? ` (truncated to ${max})` : ''}\n\n${out.slice(0, max)}`);
    }));

  tool('click', 'Click an element (by ref from read, role+name, selector or text).', { session: str(40), ...target }, async (a) => run(a.session, async (s) => {
    await locate(s.page, a).click({ timeout: 15000 });
    await s.page.waitForTimeout(1000);
    const w = noteWall(s, await wall(s.page));
    return ok({ ...(await pageInfo(s.page)), ...(w ? { blocked: w } : {}) });
  }));

  tool('type', 'Fill a field. submit=true presses Enter.', { session: str(40), ...target, value: str(10000), submit: z.boolean().optional() }, async (a) => run(a.session, async (s) => {
    const l = locate(s.page, a);
    await l.fill(a.value, { timeout: 15000 });
    if (a.submit) { await l.press('Enter', { timeout: 15000 }); await s.page.waitForTimeout(1500); }
    return ok(await pageInfo(s.page));
  }));

  tool('select', 'Choose an option in a <select>.', { session: str(40), ...target, value: str(1000) }, async (a) => run(a.session, async (s) => {
    await locate(s.page, a).selectOption({ label: a.value }, { timeout: 15000 }).catch(() => locate(s.page, a).selectOption(a.value, { timeout: 15000 }));
    return ok(await pageInfo(s.page));
  }));

  tool('press', 'Press a key (Enter, Escape, PageDown, …).', { session: str(40), key: str(50) }, async (a) => run(a.session, async (s) => {
    await s.page.keyboard.press(a.key);
    await s.page.waitForTimeout(600);
    return ok(await pageInfo(s.page));
  }));

  tool('back', 'History back.', { session: str(40) }, async (a) => run(a.session, async (s) => {
    await s.page.goBack({ timeout: 30000 });
    return ok(await pageInfo(s.page));
  }));

  tool('wait_for', 'Wait for text or selector to appear (timeoutMs up to 60000).', { session: str(40), text: str(1000).optional(), selector: str(2000).optional(), timeoutMs: z.number().int().min(1).max(60000).optional() }, async (a) => run(a.session, async (s) => {
    const t = a.timeoutMs ?? 15000;
    if (a.text) await s.page.getByText(a.text).first().waitFor({ timeout: t });
    else if (a.selector) await s.page.locator(a.selector).first().waitFor({ timeout: t });
    return ok(await pageInfo(s.page));
  }));

  tool('screenshot', `Screenshot of the viewport (or an element; fullPage is cut at ${MAX_SHOT_PX}px). Returns an image with password/OTP fields masked. Saved to disk only with SAVE_SHOTS=1.`,
    { session: str(40), ...target, fullPage: z.boolean().optional() }, async (a) => run(a.session, async (s) => {
      const opt = { type: 'jpeg', quality: 70, timeout: 30000 };
      const buf = await maskedScreenshot(s.page, async (mask) => {
        if (hasTarget(a)) {
          const l = locate(s.page, a);
          const box = await l.boundingBox({ timeout: 15000 });
          if (box && box.width * box.height > MAX_SHOT_PX * 2000) throw new Error('element too large to screenshot');
          return l.screenshot({ ...opt, mask });
        }
        if (!a.fullPage) return s.page.screenshot({ ...opt, mask });
        const [w, h] = await s.page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]);
        return s.page.screenshot({ ...opt, mask, fullPage: true, clip: { x: 0, y: 0, width: Math.min(w, 4000), height: Math.min(h, MAX_SHOT_PX) } });
      });
      const file = await manager.saveShot(s, buf);
      return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: file || 'not saved to disk (SAVE_SHOTS=1 enables it)' }] };
    }));

  const waitResult = async (id, status, h) => {
    if (status === 'still_waiting') return ok({ status, expires_in_sec: Math.max(0, Math.round((h.expiresAt - Date.now()) / 1000)), next: 'call handoff_wait again' });
    const info = await run(id, async (s) => pageInfo(s.page)).catch(() => ({}));
    return ok({ status, ...info });
  };

  tool('request_human', `Ask a human to take over this tab (CAPTCHA, cookie wall, login, 2FA). Returns a live-view link at once (one viewer at a time, valid until the handoff ends) (wait=false, default) — send it to your human, then call handoff_wait. With wait=true it also waits up to ${POLL_SEC}s and may return still_waiting. While a handoff is active, every page tool (read, screenshot, click, type, navigate, …) is refused and no URL/title is reported.`,
    { session: str(40), reason: z.string().min(1).max(300), wait: z.boolean().optional() }, async (a, extra) => {
      const h = await manager.requestHuman(owner, a.session, a.reason);
      const pending = { status: 'waiting_for_human', link: h.url, expires_in_min: Math.max(0, Math.round((h.expiresAt - Date.now()) / 60000)), next: 'send the link to your human, then call handoff_wait' };
      if (!a.wait) return ok(pending);
      const status = await manager.waitHandoff(owner, a.session, POLL_SEC * 1000, extra?.signal);
      if (status === 'still_waiting') return ok({ ...pending, status });
      return waitResult(a.session, status ?? 'no_active_handoff', h);
    });

  tool('handoff_wait', `Wait for the human to finish an active handoff (up to timeoutSec, default ${POLL_SEC}; above ~55 raise your MCP client's request timeout). Call again if it returns still_waiting.`,
    { session: str(40), timeoutSec: z.number().int().min(1).max(1800).optional() }, async (a, extra) => {
      const h = manager.get(owner, a.session).handoff;
      const status = await manager.waitHandoff(owner, a.session, (a.timeoutSec ?? POLL_SEC) * 1000, extra?.signal);
      return waitResult(a.session, status ?? 'no_active_handoff', h);
    });

  // Keepalive: per tenant (like profiles, shared by the tenant's connections).
  const keepalive = manager.keepalive;
  if (keepalive) {
    tool('keepalive_set', 'Keep a persistent profile logged in without a model: every every_hours or every_minutes (± jitter_min; ×4 during quiet_hours) the service opens the profile, loads url, moves the mouse and scrolls for 20–60 s (no clicks, typing or navigation), then checks logged_in_check. Logged out or a bot check -> a bosun:needs-human event; no retries before the next visit. Optional watch: read one value on the page (e.g. a "43 neue Nachrichten" counter) and send a bosun:watch-changed event when it changes (count up, or text differs); the first visit only records it. Only helps sites with sliding sessions.',
      { profile: z.string().regex(TENANT_RE), url: z.string().max(4096).url().describe('http(s) only'),
        every_hours: z.number().int().min(1).max(720).optional().describe('interval (default 12)'),
        every_minutes: z.number().int().min(MIN_PERIOD_MIN).max(43200).optional().describe(`interval in minutes, at least ${MIN_PERIOD_MIN} (instead of every_hours)`),
        jitter_min: z.number().int().min(0).max(720).optional().describe('random shift of each visit, ± minutes (default 30, at most a quarter of a shorter interval)'),
        quiet_hours: z.string().max(20).optional().describe(`local hours (time zone ${cfg.tz || 'Europe/Vienna'}) when the interval is ×4, e.g. "22-08"`),
        logged_in_check: z.object({ text: str(1000).optional(), selector: str(2000).optional(), url_not_contains: str(1000).optional() }).describe('what proves it is still logged in; every given condition must hold'),
        watch: z.object({
          selector: str(2000).optional().describe("element whose textContent is read (default: the page's visible text)"),
          text_regex: str(500).optional().describe('picks the value: first capture group, else the whole match, e.g. "(\\d+) neue Nachrichten"'),
          kind: z.enum(['count', 'text']).describe('count: a number, event when it goes up (no match = 0); text: at most 200 chars, event when it differs'),
          label: str(100).describe('name for the value in events, e.g. "willhaben messages"'),
        }).optional().describe('a value to read after the logged-in check; only the value is stored'),
        enabled: z.boolean().optional() },
      async (a) => ok(keepalive.set(tenant, {
        profile: a.profile, url: a.url, everyHours: a.every_hours, everyMinutes: a.every_minutes, jitterMin: a.jitter_min, quietHours: a.quiet_hours || null,
        check: a.logged_in_check, watch: a.watch ? { selector: a.watch.selector, textRegex: a.watch.text_regex, kind: a.watch.kind, label: a.watch.label } : null, enabled: a.enabled ?? true,
      })));
    tool('keepalive_list', 'Keepalive schedules of your profiles with the next run, the watched value and the last results (ok, logged_out, bot_check, error).', {}, async () => ok(keepalive.list(tenant)));
    tool('keepalive_remove', 'Stop keeping a profile alive.', { profile: z.string().regex(TENANT_RE) }, async (a) => ok(keepalive.remove(tenant, a.profile)));
  }

  // Meetings (PoC): per tenant, like keepalive. A meeting runs in a session of its own and outlives this connection.
  const meetings = manager.meetings;
  if (meetings) {
    const mid = { meeting_id: z.string().max(20) };
    tool('meeting_join', 'Join a Google Meet as an unauthenticated guest notetaker, or with profile (a Bosun profile signed in to Google: the account name is used) (mic and camera off), ask to be let in and wait (up to max_wait_admit_min) for admission. Once in, it posts announce_text in the chat (default: an English/German notice that audio is recorded and how to object), THEN records the meeting audio to a file. Every chat message becomes a bosun:meeting-chat event; a clear "please don\'t record" (EN/DE/UK/RU/SK) stops and deletes the recording at once (bosun:meeting-optout) and leaves (leave_on_optout=false: stay, unrecorded). Leaves by itself when the meeting ends, the bot is removed, or it is alone for 2 min; then bosun:meeting-ended carries the recording. Returns once the join request is out: poll meeting_status or wait for events. Transcription is up to you, after the meeting.',
      { url: z.string().max(2048).url().describe('https://meet.google.com/abc-defg-hij'), name: str(60).optional().describe('display name (default "Glassy (notetaker)")'),
        announce_text: str(1000).optional(), max_wait_admit_min: z.number().int().min(1).max(60).optional(),
        profile: z.string().regex(TENANT_RE).optional().describe('join with an existing Bosun profile signed in to Google (gets refused less often than an anonymous guest)'),
        engine: z.enum(cfg.engines).optional().describe('chromium (default) or patchright; camoufox is not supported for meetings'),
        leave_on_optout: z.boolean().optional() },
      async (a) => ok(await meetings.join(tenant, {
        url: a.url, name: a.name || 'Glassy (notetaker)', announceText: a.announce_text, maxWaitAdmitMin: a.max_wait_admit_min ?? 10,
        profile: a.profile, engine: a.engine, leaveOnOptOut: a.leave_on_optout ?? true,
      })));
    tool('meeting_status', 'State of a meeting (joining, waiting, admitted, recording, ended), participants if visible, recorded seconds; without meeting_id all your meetings.',
      { meeting_id: z.string().max(20).optional() }, async (a) => ok(meetings.status(tenant, a.meeting_id)));
    tool('meeting_chat_read', 'Chat messages of a meeting seen so far (others\' messages; since = last seq you have).', { ...mid, since: z.number().int().min(0).optional() },
      async (a) => ok(meetings.chatRead(tenant, a.meeting_id, a.since ?? 0)));
    tool('meeting_chat_send', 'Post a message in the meeting chat.', { ...mid, text: z.string().min(1).max(1000) },
      async (a) => ok(await meetings.chatSend(tenant, a.meeting_id, a.text)));
    tool('meeting_stop_recording', 'Stop recording (delete=true, default: also delete the file). The meeting goes on unrecorded.', { ...mid, delete: z.boolean().optional() },
      async (a) => ok(await meetings.stopRecordingTool(tenant, a.meeting_id, a.delete ?? true)));
    tool('meeting_leave', 'Leave the meeting; the recording is finished and kept (bosun:meeting-ended).', mid, async (a) => ok(await meetings.leave(tenant, a.meeting_id)));
    tool('meeting_recording_delete', `Delete a meeting's recording (recordings are deleted automatically after ${cfg.recordingRetentionDays ?? 30} days).`, mid,
      async (a) => ok(await meetings.deleteRecording(tenant, a.meeting_id)));
  }

  tool('sessions', 'List your open sessions.', {}, async () => ok(manager.list(owner).map((s) => (
    s.handoff ? { id: s.id, profile: s.profile || 'ephemeral', engine: s.engine, handoff: 'active' } : { id: s.id, profile: s.profile || 'ephemeral', engine: s.engine, url: s.page.url() }
  ))));

  if (ephemeral) {
    // McpServer has no public filter for tools/list; wrap its handler (the SDK version is pinned, and the tests check
    // the list). Without the handler, refuse to build the server rather than list every tool.
    const handlers = server.server._requestHandlers;
    const list = handlers?.get('tools/list');
    if (!list) throw new Error('cannot restrict tools/list for policy ephemeral');
    handlers.set('tools/list', async (req, extra) => {
      const r = await list(req, extra);
      return { ...r, tools: r.tools.filter((t) => EPHEMERAL_TOOLS.has(t.name)) };
    });
  }
  return server;
}
