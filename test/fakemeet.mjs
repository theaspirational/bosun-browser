// A local stand-in for Google Meet with the labels and markers platforms/meet.mjs relies on: a lobby (mic and camera
// toggles, guest name, "Ask to join"), the waiting room, admission or denial, an in-call toolbar, participant tiles, a
// chat panel, the end of the call and removal. The test plays host through the returned object (admit, deny, say,
// end, ...). With tone: true the admitted page plays a 440 Hz tone (audio pipeline test).
import http from 'http';
import fs from 'fs';
import path from 'path';

// UI texts per language. de mirrors what a German-locale server saw on real Meet: "Wie heißen Sie?", placeholder
// "Ihr Name", "Teilnahme erbitten", no devices ("Kamera nicht gefunden").
const UI = {
  en: { ready: 'Ready to join?', name: 'Your name', ask: 'Ask to join', joinNow: 'Join now', micOff: 'Turn off microphone', micOn: 'Turn on microphone',
    camOff: 'Turn off camera', camOn: 'Turn on camera', noCam: 'Camera not found', noMic: 'Microphone not found', waiting: 'Asking to be let in…',
    cantJoin: 'You can’t join this video call', home: 'Return to home screen', safe: 'Your meeting is safe', denied: 'Someone in the call denied your request to join',
    chat: 'Chat with everyone', send: 'Send a message', leave: 'Leave call', ended: 'The call has ended', removed: 'You’ve been removed from the meeting', left: 'You left the meeting' },
  de: { ready: 'Wie heißen Sie?', name: 'Ihr Name', ask: 'Teilnahme erbitten', joinNow: 'Jetzt teilnehmen', micOff: 'Mikrofon deaktivieren', micOn: 'Mikrofon aktivieren',
    camOff: 'Kamera deaktivieren', camOn: 'Kamera aktivieren', noCam: 'Kamera nicht gefunden', noMic: 'Mikrofon nicht gefunden', waiting: 'Teilnahme wird angefragt…',
    cantJoin: 'Sie können nicht an diesem Videoanruf teilnehmen.', home: 'Zurück zum Startbildschirm', safe: 'Ihre Besprechung ist sicher', denied: 'Jemand im Anruf hat Ihre Anfrage abgelehnt',
    chat: 'Chat mit allen', send: 'Nachricht senden', leave: 'Anruf verlassen', ended: 'Der Anruf wurde beendet', removed: 'Sie wurden aus dem Meeting entfernt', left: 'Sie haben das Meeting verlassen' },
};
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// opts: lang (en|de), toggles ('ok' | 'none': no mic/camera buttons | 'stuck': the mic button does nothing |
// 'nodevices': no buttons, Meet says no camera/microphone found | 'disabledOn': the mic shows "turn off" but is
// disabled | 'staleBanner': "Microphone not found" while a stuck mic control still shows it on), signedIn (no name
// field, "Join now"), bareName (a name field without label or placeholder, under "What's your name?"), searchBox (an
// unrelated text box in the lobby), bigChallenge (the refusal page shows a visible challenge frame). Signed in, as seen
// on real Meet: account (the account's address and "Switch account" shown), dialog (a modal "Do you want people to
// hear you in the meeting?" over the lobby, so a click on the join button is intercepted until it is closed),
// readyMs (the join button is disabled, "Getting ready...", that long), elsewhere (the account is in the call on
// another device: "Switch here", and "Join here too" under "Other ways to join").
function app({ title = '', lang = 'en', toggles = 'ok', signedIn = false, bareName = false, searchBox = false, bigChallenge = false, account = false, dialog = false, readyMs = 0, elsewhere = false }) {
  const L = UI[lang];
  const de = lang === 'de';
  const joinButtons = elsewhere
    ? `<button id="switch">${de ? 'Hierher wechseln' : 'Switch here'}</button><button id="other" aria-haspopup="menu">${de ? 'Weitere Möglichkeiten zur Teilnahme' : 'Other ways to join'}</button>
       <div role="menu" id="menu" hidden><div role="menuitem" id="too" tabindex="0">${de ? 'Auch hier teilnehmen' : 'Join here too'}</div><div role="menuitem" tabindex="0">${de ? 'Präsentieren' : 'Present'}</div></div>`
    : `<button id="ask"${readyMs ? ' disabled' : ''}><span>${esc(signedIn ? L.joinNow : L.ask)}</span></button>
       <button id="other">${de ? 'Weitere Möglichkeiten zur Teilnahme' : 'Other ways to join'}</button>`;
  const frame = bigChallenge ? '<iframe src="/recaptcha/api2/anchor?k=x" title="reCAPTCHA" width="300" height="300"></iframe>' : '<iframe src="/recaptcha/api2/anchor?k=x" title="reCAPTCHA" width="10" height="10"></iframe>';
  const nameField = signedIn ? '' : bareName ? '<input type="text">' : `<input type="text" placeholder="${esc(L.name)}"${lang === 'en' ? ` aria-label="${esc(L.name)}"` : ''}>`;
  return `<!doctype html><meta charset="utf-8"><title>Meet</title>
<style>[hidden]{display:none!important} .tile{display:inline-block;width:80px;height:60px;background:#333;margin:4px}</style>
<div id="lobby"><h1>${esc(bareName ? "What's your name?" : L.ready)}</h1>
  <button id="mic" aria-label="${esc(L.micOff)}"${toggles === 'disabledOn' ? ' disabled' : ''}>mic</button><button id="cam" aria-label="${esc(L.camOff)}">cam</button>
  ${toggles === 'nodevices' ? `<p>${esc(L.noCam)}</p><p>${esc(L.noMic)}</p>` : toggles === 'staleBanner' ? `<p>${esc(L.noMic)}</p>` : ''}
  ${searchBox ? '<input type="text" id="search" aria-label="Search">' : ''}
  ${nameField}${joinButtons}
  ${readyMs ? `<p id="ready">${de ? 'Wird vorbereitet…' : 'Getting ready...'}</p>` : ''}
  ${account ? '<div id="acct"><span>glassy@smartie.team</span> <a href="#">Switch account</a></div>' : signedIn ? '' : '<a href="#" id="signin">Sign in</a>'}</div>
${dialog ? `<div id="dlg" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10"><div style="background:#fff;margin:80px auto;width:360px;padding:16px">
  <h2>${de ? 'Möchten Sie, dass andere Sie in der Besprechung hören?' : 'Do you want people to hear you in the meeting?'}</h2>
  <button id="dlgOk">${de ? 'Ohne Mikrofon und Kamera fortfahren' : 'Continue without microphone and camera'}</button></div></div>` : ''}
<div id="waiting" hidden><p>${esc(L.waiting)}</p></div>
<div id="denied" hidden><h1>${esc(L.cantJoin)}</h1><p>${esc(L.denied)}</p></div>
<div id="refused" hidden><h1>${esc(L.cantJoin)}</h1><button>${esc(L.home)}</button><p>${esc(L.safe)}</p>${frame}</div>
<div id="pending" hidden></div>
<div id="call" hidden><div id="topic">${esc(title || '')}</div><div id="tiles"></div><div id="captions" class="caption-text"></div>
  <div role="toolbar"><button aria-label="${esc(L.chat)}">chat</button><button aria-label="${esc(L.leave)}">leave</button></div>
  <aside id="panel" hidden><div role="list" id="msgs"></div><textarea aria-label="${esc(L.send)}"></textarea></aside></div>
<div id="over" hidden><h1 id="overText"></h1></div>
<script>
const L = ${JSON.stringify(L)}, TOGGLES = ${JSON.stringify(toggles)};
const code = location.pathname.slice(1), $ = (id) => document.getElementById(id);
const post = (p, b) => fetch('/api/' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, ...b }) });
let mic = true, cam = true, shown = new Set(), toned = false;
$('mic').onclick = () => { mic = !mic; $('mic').setAttribute('aria-label', mic ? L.micOff : L.micOn); };
$('cam').onclick = () => { cam = !cam; $('cam').setAttribute('aria-label', cam ? L.camOff : L.camOn); };
if (TOGGLES === 'none' || TOGGLES === 'nodevices') { $('mic').hidden = $('cam').hidden = true; }
if (TOGGLES === 'nodevices') { mic = cam = false; }
if (TOGGLES === 'stuck' || TOGGLES === 'staleBanner') $('mic').onclick = null;
const ask = (via) => () => { const f = document.querySelector('#lobby input:not(#search)'), q = $('search'); post('ask', { name: f ? f.value : null, mic, cam, via, ...(q ? { search: q.value } : {}) }); };
if ($('ask')) $('ask').onclick = ask('ask');
if ($('switch')) { $('switch').onclick = ask('switch'); $('too').onclick = ask('too'); $('other').onclick = () => { $('menu').hidden = !$('menu').hidden; }; }
if ($('dlgOk')) $('dlgOk').onclick = () => $('dlg').remove();
if (${readyMs}) setTimeout(() => { $('ask').disabled = false; $('ready')?.remove(); }, ${readyMs});
document.querySelector('[aria-label="' + L.chat + '"]').onclick = () => { $('panel').hidden = false; };
document.querySelector('[aria-label="' + L.leave + '"]').onclick = () => post('leave', {});
const box = document.querySelector('textarea');
box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = box.value.trim(); box.value = ''; if (t) post('chat', { text: t }); } });
async function poll() {
  const s = await (await fetch('/api/state?code=' + code)).json();
  for (const id of ['lobby', 'waiting', 'denied', 'refused', 'pending', 'call', 'over']) $(id).hidden = s.view !== id;
  if (s.view === 'over') $('overText').textContent = L[s.over];
  if (s.view === 'call') {
    $('captions').textContent = s.caption || '';
    const want = s.participants.join();
    if ($('tiles').dataset.p !== want) {
      $('tiles').dataset.p = want;
      $('tiles').replaceChildren(...s.participants.map((p) => { const t = document.createElement('div'); t.className = 'tile'; t.dataset.participantId = p; t.textContent = p; return t; }));
    }
    for (const m of s.chat) {
      if (shown.has(m.id)) { const d = document.querySelector('[data-message-id="' + m.id + '"]'); if (d.textContent !== m.text) d.textContent = m.text; continue; }
      shown.add(m.id);
      const g = document.createElement('div');
      g.dataset.senderName = m.self ? 'You' : m.sender;
      const d = document.createElement('div');
      d.dataset.messageId = m.id;
      d.textContent = m.text; // may be empty at first and filled in by a later poll (lateMs)
      g.append(d);
      $('msgs').append(g);
    }
    if (s.tone && !toned) { toned = true; const c = new AudioContext(); const o = c.createOscillator(); o.frequency.value = 440; o.connect(c.destination); o.start(); }
  }
  setTimeout(poll, 150);
}
poll();
</script>`;
}

export async function startFakeMeet({ tone = false } = {}) {
  const rooms = new Map();
  const room = (code) => {
    if (!rooms.has(code)) rooms.set(code, { phase: 'lobby', guest: null, chat: [], others: ['host-1', 'guest-2'], over: null, tone, log: [], seq: 0, loads: [] });
    return rooms.get(code);
  };
  const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => r(b ? JSON.parse(b) : {})); });
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(u.pathname)) {
      const r = room(u.pathname.slice(1));
      r.loads.push({ hl: u.searchParams.get('hl'), acceptLanguage: req.headers['accept-language'] || null });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(app(r));
    }
    if (u.pathname === '/api/state') {
      const r = room(u.searchParams.get('code'));
      if (r.phase === 'pending' && Date.now() >= r.refuseAt) r.phase = 'refused';
      const view = r.over ? 'over' : ['waiting', 'denied', 'refused', 'pending'].includes(r.phase) ? r.phase : r.phase === 'admitted' ? 'call' : 'lobby';
      const chat = r.chat.map((m) => (m.fillAt && Date.now() < m.fillAt ? { ...m, text: '' } : m));
      return json({ view, over: r.over, participants: ['self', ...r.others], chat, tone: r.tone, caption: r.caption || null });
    }
    if (req.method === 'POST') {
      const b = await body(req);
      const r = room(b.code);
      if (u.pathname === '/api/ask') {
        r.guest = { name: b.name, mic: b.mic, cam: b.cam, ...('search' in b ? { search: b.search } : {}) };
        r.via = b.via;
        // refuseAfterMs: a blank page first (no waiting room), then Google's refusal.
        r.phase = r.refuse ? (r.refuseAfterMs ? 'pending' : 'refused') : r.open ? 'admitted' : 'waiting';
        if (r.refuseAfterMs) r.refuseAt = Date.now() + r.refuseAfterMs;
        r.log.push(['ask', Date.now()]);
      }
      if (u.pathname === '/api/chat') { r.chat.push({ id: `c${++r.seq}`, sender: r.guest?.name, self: true, text: b.text }); r.log.push(['chat', Date.now(), b.text]); }
      if (u.pathname === '/api/leave') { r.left = true; r.over = 'left'; r.log.push(['leave', Date.now()]); }
      return json({ ok: true });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let n = 0;
  return {
    base,
    newRoom: () => { const c = `abc-defg-h${String.fromCharCode(97 + (n++ % 26))}${String.fromCharCode(97 + Math.floor(n / 26) % 26)}`; room(c); return { code: c, url: `${base}/${c}` }; },
    room,
    admit: (c) => { room(c).phase = 'admitted'; room(c).log.push(['admit', Date.now()]); },
    open: (c) => { room(c).open = true; },
    deny: (c) => { room(c).phase = 'denied'; },
    // lateMs: the message shows up empty first and gets its text that much later (incremental rendering).
    say: (c, sender, text, { lateMs = 0 } = {}) => { const r = room(c); r.chat.push({ id: `c${++r.seq}`, sender, text, ...(lateMs ? { fillAt: Date.now() + lateMs } : {}) }); },
    toggles: (c, mode) => { room(c).toggles = mode; },
    setOthers: (c, others) => { room(c).others = others; },
    end: (c) => { room(c).over = 'ended'; },
    caption: (c, text) => { room(c).caption = text; },
    remove: (c) => { room(c).over = 'removed'; },
    // Variants of a room (set before the page loads): lang, toggles, signedIn, bareName; refuse = Google turns the
    // guest away right after "Ask to join".
    set: (c, opts) => { Object.assign(room(c), opts); },
    close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections(); }),
  };
}

// Fake audio backend for hosts without PulseAudio: no audio server, the browser is muted, and the "recorder" writes a
// growing Ogg-looking file until stopped.
// openMs: the audio server takes that long to start; stopMs: a graceful stop takes that long (a kill is immediate).
export function fakeAudio({ openMs = 0, stopMs = 0 } = {}) {
  const recorders = [];
  const stats = { opened: 0, closed: 0 };
  return {
    recorders,
    stats,
    unsupported: async () => null,
    needsHeadful: false,
    async open() {
      stats.opened++;
      if (openMs) await new Promise((r) => setTimeout(r, openMs));
      let closed = false;
      return {
        browserEnv: undefined,
        args: ['--mute-audio'],
        record(file) {
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          fs.writeFileSync(file, 'OggS', { mode: 0o600 });
          let done;
          const exited = new Promise((r) => { done = r; });
          const t = setInterval(() => fs.appendFileSync(file, Buffer.alloc(200, 1)), 100);
          const rec = { file, startedAt: Date.now(), exited, killed: false, error: () => null };
          let stopping = null;
          const end = async (killed) => { clearInterval(t); rec.killed = rec.killed || killed; rec.ended = Date.now(); done({}); };
          rec.stop = () => (stopping ??= (async () => { if (stopMs) await Promise.race([new Promise((r) => setTimeout(r, stopMs)), exited]); await end(false); })());
          rec.kill = () => end(true);
          recorders.push(rec);
          return rec;
        },
        close: async () => { if (!closed) { closed = true; stats.closed++; } },
      };
    },
  };
}
