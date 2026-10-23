// MCP tool surface. One McpServer per connection; every session lookup is scoped to that connection (owner).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import crypto from 'crypto';
import { z } from 'zod';
import { countNodes, maskText, maskedScreenshot, sensitiveValues } from './redact.mjs';
import { NOT_ALLOWED, PROFILES_REFUSED, TENANT_RE } from './auth.mjs';
import { urlKey, httpUrl } from './sessions.mjs';

export { httpUrl };
import { MANIFEST, mcplConnection } from './events.mjs';
import { MIN_PERIOD_MIN } from './keepalive.mjs';
import { meetRefusalPage } from './meetings/platforms/meet.mjs';
import { BASE64_MAX_BYTES } from './uploads.mjs';

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
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Runs in the page: drags the files of input i onto el (dragenter, dragover, drop, dragleave). true when the page
// cancelled dragover or drop, i.e. something there takes drops. mark: leave the answer on el (main-world run).
function dropFiles(el, i, mark) {
  const dt = new DataTransfer();
  for (const f of i.files) dt.items.add(f);
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new DragEvent('dragenter', at));
  const over = !el.dispatchEvent(new DragEvent('dragover', at));
  const drop = !el.dispatchEvent(new DragEvent('drop', at));
  el.dispatchEvent(new DragEvent('dragleave', at));
  if (mark) el.setAttribute('data-bosun-res', String(over || drop));
  return over || drop;
}

// Puts files (paths on this machine) into the page through the element: an <input type=file> (also a hidden one, or
// a label of one) directly; anything else is clicked and the file chooser it opens is answered; if none opens, the
// files are dropped onto it (synthetic drag events, best effort). method forces one of them. The browser reads the
// files from disk itself: no bytes pass through this process or the protocol.
// mainWorld (camoufox): Firefox hides files that our isolated world put into a DataTransfer from the page, so the drop
// is dispatched by a script element in the page's own world (unless the page's CSP refuses inline scripts).
async function putFiles(page, l, paths, method, { mainWorld = false } = {}) {
  const input = await l.evaluate((el) => {
    const i = el.tagName === 'INPUT' ? el : el.tagName === 'LABEL' ? el.control : null;
    return i && i.type === 'file' ? { multiple: i.multiple, disabled: i.disabled } : null;
  }, null, { timeout: 15000 });
  const many = paths.length > 1;
  if (input && method !== 'drop' && method !== 'chooser') {
    if (many && !input.multiple) throw new Error(`this file input takes one file (no multiple attribute); got ${paths.length}`);
    if (input.disabled) throw new Error('this file input is disabled');
    await l.setInputFiles(paths, { timeout: 30000 });
    const names = await l.evaluate((el) => [...((el.tagName === 'LABEL' ? el.control : el).files || [])].map((f) => f.name)).catch(() => null);
    return { method: 'input', ...(names ? { input_files: names } : {}) };
  }
  if (method === 'input') throw new Error('the element is not a file input (or a label of one); try method chooser or drop');
  if (method !== 'drop') {
    // Listening from before the click (which may wait for the button to become clickable) until a grace period
    // after it: a page may open its chooser asynchronously.
    let fc = null;
    const onChooser = (c) => { fc ??= c; };
    page.on('filechooser', onChooser);
    try {
      await l.click({ timeout: 15000 });
      for (const end = Date.now() + (method === 'chooser' ? 10000 : 5000); !fc && Date.now() < end;) await sleep(100);
    } finally {
      page.off('filechooser', onChooser);
    }
    if (fc) {
      if (many && !fc.isMultiple()) throw new Error(`the file chooser this opened takes one file; got ${paths.length}`);
      await fc.setFiles(paths, { timeout: 30000 });
      return { method: 'chooser' };
    }
    if (method === 'chooser') throw new Error('clicking the element opened no file chooser within 10 s');
  }
  // Drop: the files go into a temporary input of our own, then onto the element as a DataTransfer.
  const tmp = await page.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    i.style.display = 'none';
    document.documentElement.append(i);
    return i;
  });
  try {
    await tmp.setInputFiles(paths, { timeout: 30000 });
    let accepted = null;
    if (mainWorld) {
      // The elements are found again by a one-off attribute; null: the page's CSP didn't run the script.
      const key = crypto.randomBytes(8).toString('hex');
      await tmp.evaluate((i, k) => i.setAttribute('data-bosun-src', k), key);
      try {
        accepted = await l.evaluate((el, [k, code]) => {
          el.setAttribute('data-bosun-dst', k);
          const sc = document.createElement('script');
          sc.textContent = `(${code})(document.querySelector('[data-bosun-dst="${k}"]'), document.querySelector('[data-bosun-src="${k}"]'), true)`;
          document.documentElement.append(sc);
          sc.remove();
          const r = el.getAttribute('data-bosun-res');
          return r === null ? null : r === 'true';
        }, [key, dropFiles.toString()], { timeout: 15000 });
      } finally {
        await l.evaluate((el) => { el.removeAttribute('data-bosun-dst'); el.removeAttribute('data-bosun-res'); }).catch(() => {});
      }
    }
    const blocked = mainWorld && accepted === null;
    if (accepted === null) accepted = await l.evaluate(dropFiles, tmp, { timeout: 15000 });
    const note = blocked ? "the page's Content-Security-Policy blocked the drop script, and this engine hides files dropped from outside the page: use another engine (chromium) for this page"
      : accepted ? 'synthetic drop (best effort): check the page took the files' : 'nothing on the page handled the drop; this element is probably not a drop zone';
    return { method: 'drop', accepted, note };
  } finally {
    await tmp.evaluate((i) => i.remove()).catch(() => {});
    await tmp.dispose().catch(() => {});
  }
}

// The tools a token with policy "ephemeral" may call: ephemeral sessions and page tools. No profiles, keepalive,
// meetings or handoff.
export const EPHEMERAL_TOOLS = new Set(['session_open', 'session_close', 'navigate', 'read', 'click', 'type', 'select', 'press', 'back', 'wait_for', 'screenshot', 'sessions']);

export function buildServer({ manager, owner, tenant, cfg, policy = 'full', conn = { inflight: 0 }, uploadBase = null }) {
  const ephemeral = policy === 'ephemeral';
  // When this tenant has a host allowlist, say so in the tool description instead of letting the agent guess.
  const allowed = manager.allowList(tenant);
  const allowNote = allowed ? `This token may only reach: ${allowed.map((p) => (p.any ? '*' : `${p.wild ? '*.' : ''}${p.host.includes(':') ? `[${p.host}]` : p.host}${p.port ? `:${p.port}` : ''}`)).join(', ')}.` : null;
  const server = new McpServer({ name: 'bosun', version: '0.10.0' }, { capabilities: ephemeral ? {} : { experimental: { mcpl: MANIFEST } } });
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
      const t0 = Date.now();
      let r;
      try {
        r = await s.page.goto(url, { waitUntil: a.wait || 'domcontentloaded', timeout: 45000 });
      } catch (e) {
        // A redirect hop the tenant's proxy refused over CONNECT (https, wss) fails the navigation in the browser:
        // say that it was the allowlist, naming host and port only.
        const denied = /TUNNEL|PROXY/i.test(String(e?.message)) ? await manager.deniedSince(tenant, t0) : [];
        if (denied.length) throw new Error(`navigation refused by the host allowlist of this token: ${denied[denied.length - 1]}`);
        throw e;
      }
      await s.page.waitForTimeout(1200);
      const w = noteWall(s, await wall(s.page));
      const info = await pageInfo(s.page);
      // The browser follows plain-http redirects itself; one that left the allowlist, or an allowed name that
      // resolves into a private address, got the tenant proxy's 403 instead.
      const refused = r?.status() === 403 && (!manager.isAllowed(tenant, info.url) || (await manager.deniedSince(tenant, t0)).length > 0);
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

  // Uploads: files of this tenant only, put into a page with upload.
  const uploads = manager.uploads;
  if (uploads) {
    const maxMb = Math.round(cfg.uploadMaxBytes / 1024 / 1024);
    tool('upload_create', `Get a file onto the browser machine for upload. Returns file_id and a one-time PUT URL (valid ${Math.round(cfg.uploadUrlTtlMs / 60000)} min, this token only): send the file with the curl line given (curl -T <file> '<put_url>'), then call upload with the file_id. Up to ${maxMb} MB. For a small file (up to 1 MB) pass content_base64 instead and use the file_id at once. Files are deleted when the session that used them closes, ${Math.round(cfg.uploadTtlMs / 60000)} min after they arrived, or on a service restart.`,
      { filename: str(255).describe('name the page will see, e.g. "report.pdf"'), size_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('the exact size; the PUT must match it'),
        content_base64: z.string().max(Math.ceil(BASE64_MAX_BYTES / 3) * 4 + 8).optional().describe('the whole file, base64 (1 MB at most): no PUT needed') },
      async (a) => {
        if (a.content_base64 !== undefined) {
          const b64 = a.content_base64.replace(/\s+/g, '');
          const content = Buffer.from(b64, 'base64');
          // Only what decodes back to the same text: Node turns "a==" into zero bytes without a word.
          const bare = (t) => t.replace(/=+$/, '');
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || (b64.includes('=') && b64.length % 4) || bare(content.toString('base64')) !== bare(b64)) throw new Error('content_base64 is not base64');
          if (content.length > BASE64_MAX_BYTES) throw new Error(`content_base64 is for files up to 1 MB; use the PUT URL (omit content_base64) for larger files`);
          const f = await uploads.create(tenant, { filename: a.filename, content });
          return ok({ file_id: f.id, filename: f.name, size: f.size, next: `call upload with file_id ${f.id}` });
        }
        if (!cfg.ws) throw new Error('the PUT URL needs the WebSocket service (WS_PORT); pass content_base64 for a small file');
        const f = await uploads.create(tenant, { filename: a.filename, sizeBytes: a.size_bytes ?? null });
        const where = `/upload/${f.id}?t=${f.secret}`;
        const url = uploadBase ? `${uploadBase}${where}` : null;
        return ok({
          file_id: f.id, filename: f.name, put_url: url ?? where,
          ...(url ? {} : { put_url_note: 'PUT to the host:port of your MCP URL, http, with this path' }),
          curl: `curl -sS --fail-with-body -T ${shq(f.name)} ${shq(url ?? `http://<mcp host:port>${where}`)}`,
          valid_min: Math.round(cfg.uploadUrlTtlMs / 60000), max_bytes: Math.min(cfg.uploadMaxBytes, a.size_bytes ?? Infinity),
          next: 'PUT the file (one request; the URL works once), then call upload with file_id',
        });
      });
    tool('upload', 'Put uploaded files (file_id, or files: several file_ids, from upload_create) into the page through an element: an <input type=file> (hidden ones too, or its label) is filled directly; a button or link that opens a file chooser is clicked and the chooser answered; anything else gets the files dropped onto it (synthetic drag-and-drop, best effort: pages that check for real user events ignore it). method forces input, chooser or drop. Several files only where the input/chooser allows multiple. Then submit the form as usual (click).',
      { session: str(40), ...target, file_id: str(40).optional(), files: z.array(str(40)).min(1).max(20).optional(), method: z.enum(['auto', 'input', 'chooser', 'drop']).optional() },
      async (a) => {
        if (!hasTarget(a)) throw new Error('give the element: ref, role(+name), selector or text');
        if (!!a.file_id === !!a.files) throw new Error('give file_id or files (not both)');
        const ids = [...new Set(a.files ?? [a.file_id])];
        return run(a.session, async (s) => {
          const files = uploads.use(tenant, ids, s.id);
          const r = await putFiles(s.page, locate(s.page, a), files.map((f) => f.file), a.method || 'auto', { mainWorld: s.engine === 'camoufox' });
          await s.page.waitForTimeout(500);
          return ok({ ...r, files: files.map((f) => ({ file_id: f.id, filename: f.name, size: f.size })), ...(await pageInfo(s.page)) });
        });
      });
  }

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
    tool('meeting_join', 'Join a Google Meet or Zoom meeting as a notetaker: a Meet as an unauthenticated guest or with profile (a Bosun profile signed in to Google: the account name is used, name is ignored); a Zoom meeting (zoom.us/j/<id>?pwd=…, in Zoom\'s web client) with profile signed in to Zoom (Zoom refuses most guests). Mic and camera off; asks to be let in and waits (up to max_wait_admit_min) for admission. Once in, it posts announce_text in the chat (default: an English/German notice that audio is recorded and how to object), THEN records the meeting audio to a file. Every chat message becomes a bosun:meeting-chat event; a clear "please don\'t record" (EN/DE/UK/RU/SK) stops and deletes the recording at once (bosun:meeting-optout) and leaves (leave_on_optout=false: stay, unrecorded). Leaves by itself when the meeting ends, the bot is removed, or it is alone for 2 min; then bosun:meeting-ended carries the recording. Returns once the join request is out: poll meeting_status or wait for events. Transcription is up to you, after the meeting.',
      { url: z.string().max(2048).url().describe('https://meet.google.com/abc-defg-hij or https://zoom.us/j/<id>?pwd=… (any *.zoom.us, /w/ and /wc/ links too)'), name: str(60).optional().describe('display name for a guest (default "Glassy (notetaker)"); a signed-in profile joins under the account name'),
        announce_text: str(1000).optional(), max_wait_admit_min: z.number().int().min(1).max(60).optional(),
        profile: z.string().regex(TENANT_RE).optional().describe('join with an existing Bosun profile signed in to Google (Meet) or Zoom (gets refused far less often than an anonymous guest)'),
        engine: z.enum(cfg.engines).optional().describe('chromium (default) or patchright; camoufox is not supported for meetings'),
        leave_on_optout: z.boolean().optional() },
      async (a) => ok(await meetings.join(tenant, {
        url: a.url, name: a.name || 'Glassy (notetaker)', announceText: a.announce_text, maxWaitAdmitMin: a.max_wait_admit_min ?? 10,
        profile: a.profile, engine: a.engine, leaveOnOptOut: a.leave_on_optout ?? true,
      })));
    tool('meeting_status', 'State of a meeting (joining, waiting, admitted, recording, ended), platform (meet, zoom), joined_as (account, guest), participants if visible, recorded seconds; without meeting_id all your meetings.',
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
