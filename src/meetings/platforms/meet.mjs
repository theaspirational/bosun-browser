// Google Meet, joined as an unauthenticated guest, or with a Bosun profile that is signed in to a Google account
// (then Meet takes the name from the account and shows no name field). Everything Meet-specific (texts, labels, DOM
// markers) lives here; the meeting manager only uses the platform interface:
//
//   name, matches(url), locale
//   joinUrl(url)          the URL to load: forces Meet's English UI (hl=en)
//   lobby(page, {name, info})  mic and camera off, guest name filled in (if asked), join clicked; info.joinedAs:
//                         'account' | 'guest'
//                         -> 'waiting' (knock seen) | 'asked' (no waiting room seen yet) | 'admitted' | 'denied' | 'refused' | 'ended'
//                            (a platform may also return 'invalid' | 'sign-in' | 'captcha'; see index.mjs)
//   state(page)           'lobby' | 'waiting' | 'admitted' | 'denied' | 'refused' | 'removed' | 'ended' | 'unknown'
//   afterAdmit(page)      optional: what has to happen once in the call before the chat (Zoom joins computer audio)
//   messages              optional: {refused, invalid, signIn, captcha} texts for those outcomes
//   openChat(page), sendChat(page, text)
//   watchChat(page, key)  install a MutationObserver that queues new chat messages; drainChat(page, key) -> [{id, sender, text}]
//   participants(page)    number of people in the call (incl. the bot), or null if the page doesn't show it
//   leave(page)
//
// Meet's markup changes without notice and its language follows the account, the browser and the hl parameter. The
// session asks for English (joinUrl, locale), and every text and label is still matched in English, German, Slovak,
// Ukrainian and Russian, so a UI that comes up in another of those languages works too. Markers are labels, roles
// and texts a person sees; a run against real Meet that fails here is fixed here.

import { norm, any, pageText as textOutside, visible, button, firstVisible, dismissOverlays, clickThrough, ensureOff, DIALOGS, HEADINGS } from './common.mjs';

const TEXT = {
  waiting: any("asking to be let in", "you'll join the call when someone lets you in", 'waiting for the host', 'please wait until a meeting host',
    'teilnahme wird (?:angefragt|erbeten)', 'sie nehmen teil, sobald', 'sobald (?:dich|sie) jemand', 'warten, bis sie jemand',
    'žiadate o (?:pripojenie|vpustenie)', 'pripojíte sa, keď vás niekto',
    'просимо дозволу', 'ви приєднаєтеся до дзвінка, коли вас',
    'запрашиваем разрешение', 'вы присоединитесь к звонку, когда вас'),
  // A participant (the host) said no.
  denied: any('denied your request', 'request to join was denied', "weren't allowed to join", 'not allowed to join',
    'hat ihre anfrage (?:auf teilnahme )?abgelehnt', 'anfrage.*abgelehnt', 'zamietol (?:vašu )?žiadosť', 'відхилив (?:ваш )?запит', 'отклонил (?:ваш )?запрос'),
  // "You can't join this (video) call": Google turning the guest away, usually before anyone could be asked.
  cantJoin: any("(?:can't|cannot|can not) join this (?:video )?call", 'sie können nicht an diesem (?:video)?anruf teilnehmen',
    'sie können diesem (?:video)?anruf nicht beitreten', 'du kannst nicht an diesem (?:video)?anruf teilnehmen',
    'k tomuto (?:video)?hovoru sa nemôžete pripojiť', 'nemôžete sa pripojiť k tomuto (?:video)?hovoru',
    'ви не можете приєднатися до цього (?:відео)?дзвінка', 'вы не можете присоединиться к этому (?:видео)?(?:звонку|вызову)'),
  removed: any("you've been removed", 'you have been removed', 'removed you from the (?:meeting|call)', 'aus (?:dem|der) (?:meeting|besprechung|anruf|videoanruf) entfernt',
    'vás odstránil', 'вас видалено', 'вас удалили'),
  ended: any('the call has ended', 'call ended', 'meeting (?:has )?ended', 'you left the meeting', 'you left the call', 'der anruf wurde beendet',
    '(?:besprechung|meeting) (?:wurde )?beendet', 'sie haben (?:das meeting|den anruf|die besprechung) verlassen',
    'hovor sa skončil', 'opustili ste (?:hovor|stretnutie)', 'дзвінок завершено', 'ви вийшли', 'звонок завершен', 'вы покинули'),
  // Shown in the lobby when the browser has no such device: the control is off by construction.
  noCamera: any('camera not found', 'no camera found', 'kamera nicht gefunden', 'keine kamera gefunden', 'kamera sa nenašla', 'камеру не знайдено', 'камера не найдена'),
  noMic: any('microphone not found', 'no microphone found', 'mikrofon nicht gefunden', 'kein mikrofon gefunden', 'mikrofón sa nenašiel', 'мікрофон не знайдено', 'микрофон не найден'),
};
const LABEL = {
  micOff: any('^turn off microphone', '^mikrofon (?:deaktivieren|ausschalten)', '^vypnúť mikrofón', '^вимкнути мікрофон', '^выключить микрофон'), // it is on
  micOn: any('^turn on microphone', '^mikrofon (?:aktivieren|einschalten)', '^zapnúť mikrofón', '^увімкнути мікрофон', '^включить микрофон'), // it is off
  camOff: any('^turn off camera', '^kamera (?:deaktivieren|ausschalten)', '^vypnúť kameru', '^вимкнути камеру', '^выключить камеру'),
  camOn: any('^turn on camera', '^kamera (?:aktivieren|einschalten)', '^zapnúť kameru', '^увімкнути камеру', '^включить камеру'),
  join: any('^ask to join$', '^join now$', '^join$', '^teilnahme erbitten$', '^teilnahme anfragen$', '^teilnehmen anfragen$', '^jetzt teilnehmen$', '^teilnehmen$', '^beitreten$',
    '^požiadať o pripojenie$', '^pripojiť sa$', '^pripojiť sa teraz$', '^попросити приєднатися$', '^попросити дозволу приєднатися$', '^приєднатися$', '^приєднатися зараз$',
    '^попросить разрешения присоединиться$', '^присоединиться$', '^присоединиться сейчас$'),
  // The account is in this call on another device: "Switch here" moves it over (and drops the other device), "Join
  // here too" (directly, or under "Other ways to join") keeps both. Bosun prefers "Join here too".
  joinToo: any('^join here too$', '^auch hier teilnehmen$', '^hier ebenfalls teilnehmen$', '^hier auch teilnehmen$', '^pripojiť sa aj tu$', '^приєднатися й тут$', '^приєднатися і тут$', '^приєднатися також тут$', '^присоединиться и здесь$', '^присоединиться также здесь$'),
  switchHere: any('^switch here$', '^hierher wechseln$', '^hier wechseln$', '^prepnúť sem$', '^перейти сюди$', '^переключитися сюди$', '^переключиться сюда$', '^перейти сюда$'),
  otherWays: any('^other ways to join$', '^other joining options$', '^weitere möglichkeiten zur teilnahme$', '^weitere teilnahmeoptionen$', '^ďalšie spôsoby pripojenia$', '^інші способи приєднатися$', '^інші способи приєднання$', '^другие способы присоединиться$', '^другие способы подключения$'),
  // Closes what Meet lays over the lobby (feature tips, "Do you want people to hear you?", "Got it"); clicked only
  // inside a dialog.
  dismiss: any('^got it$', '^dismiss$', '^close$', '^no thanks$', '^not now$', '^ok$', '^continue without (?:microphone|camera|microphone and camera)$',
    '^verstanden$', '^schließen$', '^nein danke$', '^nicht jetzt$', '^ohne (?:mikrofon|kamera|mikrofon und kamera) (?:fortfahren|weiter)$',
    '^rozumiem$', '^zavrieť$', '^nie, ďakujem$', '^зрозуміло$', '^закрити$', '^ні, дякую$', '^не зараз$', '^продовжити без (?:мікрофона|камери|мікрофона й камери|мікрофона та камери)$',
    '^понятно$', '^закрыть$', '^нет, спасибо$', '^не сейчас$', '^продолжить без (?:микрофона|камеры|микрофона и камеры)$'),
  chat: any('^chat with everyone$', '^chat mit allen$', '^open chat$', '^chat öffnen$', '^chat$', '^chatovať so všetkými$', '^чат з усіма$', '^чат со всеми$', '^чат$'),
  chatInput: any('send a message', 'nachricht senden', 'nachricht an alle', 'odoslať správu', 'надіслати повідомлення', 'отправить сообщение'),
  leave: any('^leave call$', '^anruf verlassen$', '^leave meeting$', '^besprechung verlassen$', '^opustiť hovor$', '^вийти з дзвінка$', '^покинуть звонок$'),
};
const NAME_LABELS = ['Your name', 'Ihr Name', 'Dein Name', 'Vaše meno', 'Ваше ім’я', "Ваше ім'я", 'Ваше имя'];
// The lobby asking a guest for a name ("What's your name?" / "Wie heißen Sie?" ...).
const NAME_PROMPT = any("what's your name", 'wie heißen sie', 'wie heißt du', 'ako sa voláte', 'як вас звати', 'как вас зовут');
// A signed-in lobby names the account ("Switch account", or the address itself); a guest lobby offers "Sign in".
const ACCOUNT = any('switch account', 'konto wechseln', 'prepnúť účet', 'змінити обліковий запис', 'перейти в інший обліковий запис', 'сменить аккаунт', '[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+');
const SIGN_IN = any('^sign in$', '^anmelden$', '^prihlásiť sa$', '^увійти$', '^войти$');
// The guest-name field: by its label or placeholder in any of the languages; else, only while the page asks for a
// name, the one plain text input there is (never a search box, chat box or textarea). null: no name step (signed in).
async function nameInput(page) {
  for (const n of NAME_LABELS) {
    const l = page.locator(`input[aria-label="${n}"], input[placeholder="${n}"]`);
    if (await visible(l)) return l.first();
  }
  if (!NAME_PROMPT.test(await pageText(page).catch(() => ''))) return null;
  const boxes = page.locator('input:not([type]), input[type="text"]');
  const shown = [];
  for (let i = 0, c = Math.min(await boxes.count().catch(() => 0), 5); i < c; i++) {
    const b = boxes.nth(i);
    if (!(await b.isVisible().catch(() => false))) continue;
    const label = await b.evaluate((e) => `${e.getAttribute('aria-label') || ''} ${e.getAttribute('placeholder') || ''} ${e.getAttribute('role') || ''}`).catch(() => '');
    if (!/search|suche|chat|message|nachricht|hľadať|пошук|поиск|searchbox/i.test(label)) shown.push(b);
  }
  return shown.length === 1 ? shown[0] : null;
}

// Visible page text outside anything participants control: chat messages, participant tiles and lists (names), and
// form fields are skipped structurally, so a name or a chat line reading "The call has ended" neither ends the
// meeting nor hides the real banner.
const PARTICIPANT_CONTROLLED = '[data-message-id], [data-sender-name], [data-participant-id], [role="list"], [role="listitem"], textarea, input, [contenteditable="true"]';
const pageText = (page, roots) => textOutside(page, PARTICIPANT_CONTROLLED, roots);
const overlays = (page) => dismissOverlays(page, LABEL.dismiss);

// Any button that joins from the lobby: "Ask to join" / "Join now", "Join here too", "Switch here".
const joinCandidate = async (page) => await firstVisible(button(page, LABEL.join)) || await firstVisible(button(page, LABEL.joinToo)) || firstVisible(button(page, LABEL.switchHere));

// The lobby kind: 'guest' (a name field), 'account' (signed in: no name field, the account shown or no "Sign in"),
// or null (no lobby yet).
export async function meetPrejoin(page) {
  if (await nameInput(page)) return 'guest';
  if (!(await joinCandidate(page))) return null;
  if (ACCOUNT.test(await pageText(page).catch(() => ''))) return 'account';
  const signIn = (await visible(button(page, SIGN_IN))) || (await visible(page.getByRole('link', { name: SIGN_IN })));
  return signIn ? 'guest' : 'account';
}

// Whether a page text is Google's "You can't join this video call" page.
export const meetCantJoin = (text) => TEXT.cantJoin.test(norm(text));
// For the bot-wall check: Google's refusal page on Meet itself (meetHost), shown as a page heading, with no visible
// challenge frame (Meet embeds an invisible reCAPTCHA there; a visible one is a real challenge).
export async function meetRefusalPage(page, { meetHost = 'meet.google.com' } = {}) {
  try { if (new URL(page.url()).hostname !== meetHost) return false; } catch { return false; }
  const headings = await page.locator('h1, h2, [role="heading"]').allInnerTexts().catch(() => []);
  if (!headings.some(meetCantJoin)) return false;
  const challenge = await page.locator('iframe').evaluateAll((fs) => fs.some((f) => {
    if (!/recaptcha|hcaptcha|challenges\.cloudflare|turnstile/.test(f.src)) return false;
    const r = f.getBoundingClientRect();
    return r.width >= 60 && r.height >= 60 && f.checkVisibility?.() !== false;
  })).catch(() => false);
  return !challenge;
}

export const meet = {
  name: 'meet',
  locale: 'en-US', // the meeting browser's language (Accept-Language, navigator.language)

  matches(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && u.hostname === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(u.pathname);
    } catch { return false; }
  },

  joinUrl(url) {
    const u = new URL(url);
    u.searchParams.set('hl', 'en');
    return u.href;
  },

  async lobby(page, { name, info = {}, timeoutMs = 30_000 }) {
    const end = Date.now() + timeoutMs;
    const STOP = ['denied', 'refused', 'ended'];
    // The lobby renders in steps; wait for a join button (a guest also gets a name field first on some pages). Tips
    // and dialogs Meet lays over it are closed on the way.
    for (;;) {
      if (await joinCandidate(page)) break;
      const s = await this.state(page);
      if (STOP.includes(s)) return s;
      if (Date.now() > end) throw new Error(`no "Ask to join" / "Join now" button found on the Meet page (not a Meet lobby, or Meet changed); page ${s}`);
      await overlays(page);
      await page.waitForTimeout(500);
    }
    await overlays(page);
    for (const [what, onLabel, offLabel, missing] of [['microphone', LABEL.micOff, LABEL.micOn, TEXT.noMic], ['camera', LABEL.camOff, LABEL.camOn, TEXT.noCamera]]) {
      const r = await ensureOff(page, { what, onLabel, offLabel, missing, text: pageText, state: (p) => this.state(p), stop: STOP, site: 'Meet' });
      if (STOP.includes(r)) return r;
    }
    // Signed in to Google: no name field, Meet uses the account's name (`name` is not used).
    info.joinedAs = await meetPrejoin(page) || 'account';
    if (info.joinedAs === 'guest') {
      const input = await nameInput(page);
      if (input) await input.fill(name, { timeout: 5000 });
    }
    const join = await this.joinButton(page);
    if (!join) throw new Error('the Meet lobby has no join button any more (Meet changed?)');
    // Guests may have to type a name before the button is enabled, and a signed-in lobby says "Getting ready..." for a
    // while; a tip or dialog over the button is closed.
    await clickThrough(page, join.button, { what: `"${join.label}" on the Meet page`, overlays });
    info.joinedVia = join.label;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(500);
      const s = await this.state(page);
      if (s === 'admitted' || s === 'denied' || s === 'refused' || s === 'ended' || s === 'waiting') return s;
    }
    return 'asked'; // the request went out, but no waiting room was seen (yet)
  },

  // The button that joins: "Ask to join" / "Join now"; with the account already in the call elsewhere, "Join here
  // too" (also behind "Other ways to join"), else "Switch here". -> {button, label} | null
  async joinButton(page) {
    const pick = async (re) => { const b = await firstVisible(button(page, re)); return b ? { button: b, label: (await b.innerText().catch(() => '')).trim() || String(re) } : null; };
    const primary = await pick(LABEL.join);
    if (primary) return primary;
    const too = await pick(LABEL.joinToo);
    if (too) return too;
    const other = await firstVisible(button(page, LABEL.otherWays));
    if (other) {
      await other.click({ timeout: 3000 }).catch(() => {});
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(250);
        const t = (await firstVisible(page.getByRole('menuitem', { name: LABEL.joinToo })) || await firstVisible(button(page, LABEL.joinToo)));
        if (t) return { button: t, label: (await t.innerText().catch(() => '')).trim() || 'Join here too' };
      }
      await page.keyboard.press('Escape').catch(() => {});
    }
    return pick(LABEL.switchHere);
  },

  // admitted: the manager knows Bosun got in. From then on only Meet's dialogs (and, with the call's controls gone,
  // headings: Meet's end page) can say the call ended or Bosun was removed; captions and the meeting title are
  // participants' words. Before that the whole page counts (lobby, refusal, waiting).
  async state(page, { admitted = false } = {}) {
    const inCall = await firstVisible(page.locator('[data-participant-id]')) || await visible(button(page, LABEL.chat));
    const t = await pageText(page, inCall ? DIALOGS : admitted ? `${DIALOGS}, ${HEADINGS}` : null).catch(() => '');
    if (TEXT.denied.test(t)) return 'denied';
    if (TEXT.cantJoin.test(t)) return 'refused';
    if (TEXT.removed.test(t)) return 'removed';
    if (TEXT.ended.test(t)) return 'ended';
    if (inCall || admitted) return 'admitted';
    if (TEXT.waiting.test(t)) return 'waiting';
    if (await joinCandidate(page)) return 'lobby';
    return 'unknown';
  },

  async openChat(page) {
    if (await visible(page.getByRole('textbox', { name: LABEL.chatInput }))) return;
    await button(page, LABEL.chat).first().click({ timeout: 10_000 });
    await page.getByRole('textbox', { name: LABEL.chatInput }).first().waitFor({ state: 'visible', timeout: 10_000 });
  },

  async sendChat(page, text) {
    await this.openChat(page);
    const box = page.getByRole('textbox', { name: LABEL.chatInput }).first();
    await box.fill(text, { timeout: 5000 });
    await box.press('Enter', { timeout: 5000 });
  },

  // New chat messages are queued in the page under a random, non-enumerable key; drainChat empties the queue.
  // Messages already in the panel when the watch starts are queued too (they arrived before we could listen).
  async watchChat(page, key) {
    await page.evaluate((key) => {
      if (window[key]) return;
      const q = [];
      const seen = new Map(); // id -> text queued last; a message rendered empty first, or changed, is queued again
      const sender = (el) => {
        const named = el.closest('[data-sender-name]');
        if (named) return named.getAttribute('data-sender-name');
        // Meet groups consecutive messages under one header line with the sender's name.
        const own = new Set((el.innerText || '').split('\n').map((s) => s.trim()));
        for (let g = el.parentElement, i = 0; g && i < 3; g = g.parentElement, i++) {
          const first = (g.innerText || '').split('\n').map((s) => s.trim()).find(Boolean);
          if (first && !own.has(first) && first.length <= 80) return first;
        }
        return null;
      };
      const scan = () => {
        for (const el of document.querySelectorAll('[data-message-id]')) {
          const id = el.getAttribute('data-message-id');
          const text = (el.innerText || '').trim().slice(0, 2000);
          if (!id || !text || seen.get(id) === text) continue;
          seen.set(id, text);
          if (seen.size > 2000) seen.delete(seen.keys().next().value);
          q.push({ id, sender: sender(el), text });
          if (q.length > 500) q.shift();
        }
      };
      Object.defineProperty(window, key, { value: { q, scan }, enumerable: false });
      new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
      scan();
    }, key);
  },

  async drainChat(page, key) {
    return page.evaluate((key) => {
      const w = window[key];
      if (!w) return null; // the page was replaced: watch again
      w.scan();
      return w.q.splice(0);
    }, key);
  },

  async participants(page) {
    const n = await page.evaluate(() => new Set([...document.querySelectorAll('[data-participant-id]')].map((e) => e.getAttribute('data-participant-id'))).size).catch(() => 0);
    return n || null;
  },

  async leave(page) {
    const b = button(page, LABEL.leave);
    if (await visible(b)) await b.first().click({ timeout: 5000 }).catch(() => {});
  },
};
