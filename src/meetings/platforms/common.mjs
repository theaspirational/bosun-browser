// Helpers shared by the meeting platforms: text matching, the visible page text outside what participants control,
// buttons, overlays, and the "microphone/camera verifiably off" check.

export const norm = (s) => String(s || '').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ');
export const any = (...parts) => new RegExp(parts.join('|'), 'i');

// Visible page text outside `skip` (chat messages, participant names, form fields: what participants control), so a
// name or a chat line reading "The call has ended" neither ends the meeting nor hides the real banner. roots: only
// text inside elements matching it (e.g. dialogs).
export function pageText(page, skip, roots = null) {
  return page.evaluate(({ skip, roots }) => {
    const out = [];
    const vis = new Map();
    for (const root of roots ? document.querySelectorAll(roots) : [document.body || document.documentElement]) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n && out.length < 2000; n = walk.nextNode()) {
        const el = n.parentElement;
        if (!el || !n.nodeValue.trim() || el.closest(skip) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
        if (!vis.has(el)) vis.set(el, el.checkVisibility ? el.checkVisibility() : !!el.offsetParent);
        if (vis.get(el)) out.push(n.nodeValue.trim());
      }
    }
    return out.join('\n').slice(0, 20000);
  }, { skip, roots }).then(norm);
}

// Where a site puts its own status messages over a running call (meeting ended, removed): dialogs only. Captions,
// the meeting title and toasts are outside, so what participants say or name a meeting can't end it.
export const DIALOGS = '[role="dialog"], [role="alertdialog"]';
// With the call's toolbar hidden (it fades out) the end page may have replaced the call: headings count too.
export const HEADINGS = 'h1, h2, h3, [role="heading"]';

export const visible = (l) => l.first().isVisible().catch(() => false);
export const button = (page, name) => page.getByRole('button', { name });
export const disabled = (l) => l.first().evaluate((b) => b.disabled || b.getAttribute('aria-disabled') === 'true').catch(() => false);

// The first visible match of a locator, or null.
export async function firstVisible(l, max = 5) {
  for (let i = 0, c = Math.min(await l.count().catch(() => 0), max); i < c; i++) {
    if (await l.nth(i).isVisible().catch(() => false)) return l.nth(i);
  }
  return null;
}

// Closes what the site lays over its page (feature tips, "continue without devices", cookie banners): only buttons
// with one of `labels` inside a dialog (or matched by `extra` selectors) are clicked. Returns how many were clicked.
export async function dismissOverlays(page, labels, extra = []) {
  let n = 0;
  for (const scope of ['[role="dialog"]', '[role="alertdialog"]', ...extra]) {
    const b = await firstVisible(page.locator(scope).getByRole('button', { name: labels }));
    if (b && !(await disabled(b))) { await b.click({ timeout: 2000 }).then(() => { n++; }, () => {}); }
  }
  return n;
}

// Clicks a button, closing overlays that keep it from getting the click (a tip, a dialog) and waiting while it is
// disabled (the page still getting ready). Throws with what was in the way if it never takes the click.
export async function clickThrough(page, l, { what, overlays, timeoutMs = 25_000 }) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    if (!(await disabled(l))) {
      try { await l.click({ timeout: 3000 }); return; } catch (e) { last = e; }
      if (!(overlays && await overlays(page))) await page.keyboard.press('Escape').catch(() => {});
    } else await page.waitForTimeout(400);
    if (Date.now() > until) {
      const why = last ? String(last.message || last).split('\n').find((s) => /intercepts|not enabled|not stable|not visible/.test(s)) : 'it stayed disabled';
      throw new Error(`could not click ${what}${why ? ` (${why.trim().slice(0, 160)})` : ''}`);
    }
  }
}

// Microphone or camera verified off: its control shows "turn on" (enabled or not), or the page says the device
// wasn't found while no control shows it on. A control showing it on is clicked (if enabled) and checked again; a
// disabled one is waited out, never taken as "off". Throws if "off" can't be established: joining with a live
// microphone or camera is not risked. state(page) may end the wait (denied, refused, ended...): returned as is.
export async function ensureOff(page, { what, onLabel, offLabel, missing, text, state, stop = [], site = 'the site', timeoutMs = 10_000 }) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await visible(button(page, offLabel))) return 'off';
    const st = state ? await state(page) : null;
    if (stop.includes(st)) return st;
    const on = button(page, onLabel);
    const live = await visible(on);
    if (!live && missing && missing.test(await text(page).catch(() => ''))) return 'no device';
    if (live && !(await disabled(on))) await on.first().click({ timeout: 3000 }).catch(() => {});
    if (Date.now() > until) throw new Error(`could not make sure the ${what} is off before joining (${site} changed?); not joining`);
    await page.waitForTimeout(300);
  }
}
