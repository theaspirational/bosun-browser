// A local stand-in for Zoom's web client with the labels and markers platforms/zoom.mjs relies on: an app-launch
// page (/j/<id>: "Launch Meeting", then "Join from your browser"), the preview (/wc/<id>/join: name, passcode, "Mute",
// "Stop Video", "Join"), the waiting room, admission, the in-call toolbar ("Join Audio by Computer", "mute my
// microphone", "stop my video", participants with a counter, chat, "Leave" + "Leave Meeting"), a chat panel that
// groups consecutive messages of one sender under one name, the end of the meeting and removal. The test plays host
// through the returned object. With tone: true the admitted page plays a 440 Hz tone once computer audio is joined.
import http from 'http';

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// The launch page an invitation link opens (zoom.us/j/<id>): the app is offered first, the browser on request.
function launch(id, search) {
  return `<!doctype html><meta charset="utf-8"><title>Launch Meeting - Zoom</title>
<h1>Click Open Zoom Workplace on the dialog shown by your browser</h1>
<button id="launch">Launch Meeting</button>
<p id="alt" hidden>Having issues with Zoom Workplace? <a href="/wc/${id}/join${esc(search)}">Join from your browser</a></p>
<script>document.getElementById('launch').onclick = () => { document.getElementById('alt').hidden = false; };</script>`;
}

// opts: signedIn (the name field holds the account's name), cookies (a cookie banner over the Join button),
// passcode (the meeting has one; the preview asks for it unless the link carried it), noDevices (no mic/camera
// controls in the preview, "Cannot detect your camera"/"microphone"), recordedNotice (a "This meeting is being
// recorded" dialog once in), bigChallenge (a visible reCAPTCHA in the preview), title (the meeting's topic shown in
// the call), recipient (the chat starts addressed to this person; "Everyone" is in its menu unless hostOnly),
// enterNewline (Enter adds a line break; the Send button sends), hideRecipient (no recipient control shown: messages
// go to `recipient` anyway, marked "(Privately)"), dropSends (the chat box clears but nothing is posted), askPasscode (the preview asks for the passcode even
// though the link carried one).
function webClient(id, r) {
  return `<!doctype html><meta charset="utf-8"><title>Zoom Meeting</title>
<style>[hidden]{display:none!important} .tile{display:inline-block;width:80px;height:60px;background:#333;margin:4px}</style>
<div id="preview">
  <h1>Enter Meeting Info</h1>
  <input id="input-for-name" type="text" aria-label="Your Name" placeholder="Your Name" value="${r.signedIn ? 'Glassy Smartie' : ''}">
  ${(r.passcode && !r.pwdGiven) || r.askPasscode ? '<input id="input-for-pwd" type="password" aria-label="Meeting Passcode" placeholder="Meeting Passcode">' : ''}
  ${r.noDevices ? '<p>Cannot detect your camera</p><p>Cannot detect your microphone</p>' : '<button id="pmic" aria-label="Mute">Mute</button><button id="pcam" aria-label="Stop Video">Stop Video</button>'}
  <button id="join" class="preview-join-button">Join</button>
  <p>By clicking "Join", you agree to our Terms of Service and Privacy Statement</p>
  ${r.bigChallenge ? '<iframe src="/recaptcha/api2/anchor?k=x" title="reCAPTCHA" width="300" height="300"></iframe>' : ''}
</div>
${r.cookies ? `<div id="onetrust-banner-sdk" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10"><p>We use cookies.</p>
  <button id="onetrust-accept-btn-handler">Accept Cookies</button></div>` : ''}
<div id="waiting" hidden><h2>Please wait, the meeting host will let you in soon.</h2><button>Leave</button></div>
<div id="notice" role="dialog" hidden><p id="noticeText"></p><button>OK</button></div>
<div id="call" hidden>
  ${r.title ? `<div class="meeting-info-container__topic">${esc(r.title)}</div>` : ''}
  <div id="tiles"></div>
  <div id="captions" class="live-transcription-subtitle__box"></div>
  <div role="dialog" id="audioDlg" hidden><h2>Join Audio</h2><button id="byComputer">Join Audio by Computer</button></div>
  <div role="dialog" id="recDlg" hidden><p>This meeting is being recorded</p><button id="recOk">Got it</button><button>Leave Meeting</button></div>
  <footer>
    <button id="mic" aria-label="join audio">Join Audio</button>
    <button id="cam" aria-label="start my video">Start Video</button>
    <button id="parts" aria-label="open the manage participants list pane,[0] particpants"><span class="footer-button__number-counter" id="count">0</span>Participants</button>
    <button id="chatBtn" aria-label="open the chat panel">Chat</button>
    <button id="leave" aria-label="Leave">Leave</button>
    <div id="leaveMenu" hidden><button id="leaveConfirm">Leave Meeting</button></div>
  </footer>
  <aside id="panel" class="chat-container" hidden>
    <div id="msgs" class="chat-container__chat-list"></div>
    <div class="chat-receiver-list"${r.hideRecipient ? ' hidden' : ''}><button id="to" class="chat-receiver-list__receiver">${esc(r.recipient || 'Everyone')}</button>
      <div role="menu" id="toMenu" hidden>${r.hostOnly ? '' : '<div role="menuitem" tabindex="0" id="toAll">Everyone</div>'}<div role="menuitem" tabindex="0">Host and co-hosts</div></div></div>
    <div id="box" class="tiptap ProseMirror" contenteditable="true" aria-label="Type message here ..."></div>
    <button id="send" aria-label="send">Send</button>
  </aside>
</div>
<script>
const R = ${JSON.stringify({ tone: r.tone, recordedNotice: !!r.recordedNotice, enterNewline: !!r.enterNewline, dropSends: !!r.dropSends })};
const id = ${JSON.stringify(id)}, $ = (x) => document.getElementById(x);
const params = new URL(location.href).searchParams;
const post = (p, b) => fetch('/api/' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...b }) });
let pmic = true, pcam = ${r.noDevices ? 'false' : 'true'}, audio = false, mic = true, cam = false, shown = new Set(), toned = false, inCall = false;
if ($('pmic')) { $('pmic').onclick = () => { pmic = !pmic; $('pmic').textContent = pmic ? 'Mute' : 'Unmute'; $('pmic').setAttribute('aria-label', $('pmic').textContent); };
  $('pcam').onclick = () => { pcam = !pcam; $('pcam').textContent = pcam ? 'Stop Video' : 'Start Video'; $('pcam').setAttribute('aria-label', $('pcam').textContent); }; }
if (${r.noDevices ? 'true' : 'false'}) pmic = false;
$('onetrust-accept-btn-handler') && ($('onetrust-accept-btn-handler').onclick = () => $('onetrust-banner-sdk').remove());
$('join').onclick = () => {
  const pwd = $('input-for-pwd') ? $('input-for-pwd').value : params.get('pwd');
  mic = pmic; cam = pcam;
  post('join', { name: $('input-for-name').value, pwd, mic: pmic, cam: pcam });
};
const micLabel = () => { $('mic').setAttribute('aria-label', !audio ? 'join audio' : mic ? 'mute my microphone' : 'unmute my microphone'); $('mic').textContent = !audio ? 'Join Audio' : mic ? 'Mute' : 'Unmute'; };
$('mic').onclick = () => { if (!audio) { $('audioDlg').hidden = false; return; } mic = !mic; micLabel(); post('media', { mic, cam }); };
// Zoom may connect computer audio with the microphone live, whatever the preview said: Bosun has to mute it.
$('byComputer').onclick = () => { audio = true; mic = true; $('audioDlg').hidden = true; micLabel(); post('media', { audio, mic, cam }); };
$('cam').onclick = () => { cam = !cam; $('cam').setAttribute('aria-label', cam ? 'stop my video' : 'start my video'); post('media', { mic, cam }); };
$('recOk').onclick = () => { $('recDlg').hidden = true; };
$('chatBtn').onclick = () => { $('panel').hidden = !$('panel').hidden; $('chatBtn').setAttribute('aria-label', $('panel').hidden ? 'open the chat panel' : 'close the chat panel'); };
$('leave').onclick = () => { $('leaveMenu').hidden = false; };
$('leaveConfirm').onclick = () => post('leave', {});
const sendBox = () => { const t = $('box').innerText.trim(); $('box').textContent = ''; if (t && !R.dropSends) post('chat', { text: t, to: $('to').textContent }); };
$('box').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !R.enterNewline) { e.preventDefault(); sendBox(); } });
$('send').onclick = sendBox;
$('to').onclick = () => { $('toMenu').hidden = !$('toMenu').hidden; };
for (const it of document.querySelectorAll('#toMenu [role=menuitem]')) it.onclick = () => { $('to').textContent = it.textContent; $('toMenu').hidden = true; };
async function poll() {
  const s = await (await fetch('/api/state?id=' + id)).json();
  if (s.navigate) { location.href = s.navigate; return; }
  $('preview').hidden = s.view !== 'preview';
  $('waiting').hidden = s.view !== 'waiting';
  $('call').hidden = s.view !== 'call';
  $('notice').hidden = s.view !== 'notice';
  if (s.view === 'notice') $('noticeText').textContent = s.notice;
  if (s.view === 'call') {
    if (!inCall) { inCall = true; $('audioDlg').hidden = false; if (R.recordedNotice) $('recDlg').hidden = false; micLabel(); }
    const want = s.participants.join();
    if ($('tiles').dataset.p !== want) {
      $('tiles').dataset.p = want;
      $('tiles').replaceChildren(...s.participants.map((p) => { const t = document.createElement('div'); t.className = 'tile video-avatar__avatar-name'; t.textContent = p; return t; }));
      $('count').textContent = s.participants.length;
      $('parts').setAttribute('aria-label', 'open the manage participants list pane,[' + s.participants.length + '] particpants');
    }
    $('captions').textContent = s.caption || '';
    let prev = null;
    for (const m of s.chat) {
      if (shown.has(m.id)) { prev = m.sender; continue; }
      shown.add(m.id);
      const item = document.createElement('div');
      item.className = 'chat-item-container';
      const sender = m.self ? 'Me' : m.sender;
      if (sender !== prev) { const h = document.createElement('div'); h.className = 'chat-item__sender'; h.textContent = sender; item.append(h); }
      prev = sender;
      const d = document.createElement('div');
      d.className = 'new-chat-message__container';
      d.id = 'chat-message-content-' + m.id;
      d.textContent = m.text;
      item.append(d);
      if (m.to && m.to !== 'Everyone') { const p = document.createElement('span'); p.textContent = '(Privately)'; item.append(p); }
      $('msgs').append(item);
    }
    if (R.tone && audio && !toned) { toned = true; const c = new AudioContext(); const o = c.createOscillator(); o.frequency.value = 440; o.connect(c.destination); o.start(); }
  }
  setTimeout(poll, 150);
}
poll();
</script>`;
}

const NOTICES = {
  ended: 'This meeting has been ended by host',
  removed: 'You have been removed from this meeting by the host',
  invalid: 'Passcode wrong. Please try again.',
  signIn: 'This meeting is for authorized attendees only. Sign in to join.',
};

export async function startFakeZoom({ tone = false } = {}) {
  const rooms = new Map();
  const room = (id) => {
    if (!rooms.has(id)) rooms.set(id, { phase: 'preview', guest: null, chat: [], others: ['Host Person', 'Guest Two'], over: null, tone, log: [], seq: 0, media: [], loads: [] });
    return rooms.get(id);
  };
  const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => r(b ? JSON.parse(b) : {})); });
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const html = (h) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(h); };
    let m = u.pathname.match(/^\/j\/(\d{9,12})$/);
    if (m) { room(m[1]).loads.push(u.pathname); return html(launch(m[1], u.search)); }
    m = u.pathname.match(/^\/wc\/(\d{9,12})\/join$/);
    if (m) {
      const r = room(m[1]);
      r.loads.push(u.pathname);
      r.pwdGiven = !!u.searchParams.get('pwd');
      r.cookieLang = (req.headers.cookie || '').match(/_zm_lang=([^;]+)/)?.[1] || null;
      return html(webClient(m[1], r));
    }
    if (u.pathname === '/api/state') {
      const r = room(u.searchParams.get('id'));
      const view = r.over ? 'notice' : r.phase === 'admitted' ? 'call' : r.phase === 'waiting' ? 'waiting' : r.phase === 'rejected' ? 'notice' : 'preview';
      const notice = r.over ? NOTICES[r.over] : r.phase === 'rejected' ? NOTICES[r.rejected] : null;
      return json({ view, notice, participants: [r.guest?.name || 'self', ...r.others], chat: r.chat, caption: r.caption || null });
    }
    if (req.method === 'POST') {
      const b = await body(req);
      const r = room(b.id);
      if (u.pathname === '/api/join') {
        r.guest = { name: b.name, mic: b.mic, cam: b.cam };
        r.log.push(['join', Date.now()]);
        if (r.passcode && b.pwd !== r.passcode) { r.phase = 'rejected'; r.rejected = 'invalid'; } else if (r.requireSignIn && !r.signedIn) { r.phase = 'rejected'; r.rejected = 'signIn'; } else r.phase = r.open ? 'admitted' : 'waiting';
      }
      if (u.pathname === '/api/media') { r.media.push({ ...b, at: Date.now() }); delete r.media.at(-1).id; }
      if (u.pathname === '/api/chat') { r.chat.push({ id: `${++r.seq}`, sender: r.guest?.name, self: true, text: b.text, to: b.to }); r.log.push(['chat', Date.now(), b.text]); }
      if (u.pathname === '/api/leave') { r.left = true; r.over = 'ended'; r.log.push(['leave', Date.now()]); }
      return json({ ok: true });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let n = 0;
  return {
    base,
    // A meeting: its invitation link (as Zoom sends it; the test platform maps it to this server's web client).
    newRoom: (opts = {}) => {
      const id = String(81234567890 + n++);
      Object.assign(room(id), opts);
      return { id, url: `https://us02web.zoom.us/j/${id}${opts.passcode ? `?pwd=${opts.passcode}` : ''}` };
    },
    room,
    admit: (id) => { room(id).phase = 'admitted'; room(id).log.push(['admit', Date.now()]); },
    say: (id, sender, text) => { const r = room(id); r.chat.push({ id: `${++r.seq}`, sender, text }); },
    setOthers: (id, others) => { room(id).others = others; },
    end: (id) => { room(id).over = 'ended'; },
    caption: (id, text) => { room(id).caption = text; },
    remove: (id) => { room(id).over = 'removed'; },
    set: (id, opts) => { Object.assign(room(id), opts); },
    close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections(); }),
  };
}
