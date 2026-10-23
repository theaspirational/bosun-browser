# Changelog

## 0.10.0 — file uploads into web pages

### Added

- **`upload_create` and `upload`.** An agent can now put files into a page.
  - `upload_create { filename, size_bytes? }` returns a `file_id` and a one-time PUT URL with a ready `curl -T`
    line. The URL is valid for 15 min, works once, and only for the tenant that asked for it.
  - The PUT goes to the MCP port itself, built from the `Host` the MCP client connected with (or
    `UPLOAD_BASE_URL`), so whatever reaches MCP reaches it. The body streams straight to
    `BROWSER_DATA/uploads/<tenant>/<file_id>/<filename>` (0600): not held in memory, not base64.
  - `upload_create { filename, content_base64 }` stores a file of up to 1 MB at once, no PUT needed.
  - `upload { session, ref | selector | role+name | text, file_id | files[] }` fills an `<input type=file>`
    (hidden ones too, or through its label), or clicks a button and answers the file chooser it opens, or drops the
    files on a drop zone (synthetic drag events, best effort). `method` forces one. Several files only where the
    input or chooser allows `multiple`. The browser reads the files from disk itself.
  - Limits: `UPLOAD_MAX_BYTES` (300 MB per file) and `UPLOAD_TENANT_QUOTA_BYTES` (1 GB per tenant), checked
    against `Content-Length` and again while the body streams (`413`, nothing left on disk). `size_bytes`, when
    given, must match exactly. A tenant holds at most 50 uploads at a time and streams 4 at once (16 in all;
    `429`, retry the same URL). `Expect: 100-continue` is answered only after these
    checks, so a refused file is never sent.
  - Instead of the URL's secret, `PUT /upload/<file_id>` with the tenant's own token in `Authorization: Bearer`
    works too (once, like the URL).
  - Files are deleted when the session that used them closes, an hour after they arrived (`UPLOAD_TTL_SEC`), and
    all of them when the service starts.
  - Files never cross tenants: another tenant's `file_id` answers like one that never existed, and a PUT with
    another tenant's token in `Authorization` is refused. Read-only tokens (policy `ephemeral`) can't upload.
  - `FEATURES_UPLOADS=0` switches it all off: no tools, no PUT endpoint, no uploads directory.

### Changed

- The WebSocket message limit is 2 MiB (was 1 MiB), so a 1 MB file fits as base64; the stdio bridge follows.
- The MCP port's HTTP server has no 5-minute request limit any more (a large upload takes longer). Each upload
  PUT is bounded on its own: 60 s without data, an hour in all.

### Limits

- Drag-and-drop is synthetic (`isTrusted` false); drop zones that insist on real user events ignore it. Under
  `camoufox` the drop runs as a script in the page, which a Content-Security-Policy without inline scripts refuses
  (`note` says so).

## 0.9.0 — signed-in meeting joins: Google Meet and Zoom

### Added

- **Zoom.** `meeting_join` takes Zoom links: `zoom.us/j/<id>?pwd=…`, any `*.zoom.us` subdomain, webinar `/w/` and
  web client `/wc/` links. Bosun rewrites them to Zoom's web client (`https://app.zoom.us/wc/<id>/join?pwd=…`) and
  joins with a profile signed in to Zoom (`profile`).
  - The preview: the account's name is kept, microphone and camera verifiably off, cookie banners and tips
    closed. If Zoom shows its app-launch page anyway, Bosun clicks "Join from your browser".
  - Waiting room and "waiting for the host" count as `waiting`. Once admitted, Bosun joins computer audio (without
    it nothing is heard or recorded), mutes the microphone Zoom may have turned on, and checks the camera is off.
  - The rest is the Meet flow: the announcement in the chat before recording, the same audio recorder, every chat
    message as `bosun:meeting-chat`, the opt-out phrases stop and delete the recording, participants from the
    toolbar counter, and leaving when the meeting ends, Bosun is removed, or it is alone for 2 minutes.
  - The announcement goes to everyone: the chat's recipient is switched to Everyone first. If the host allows chat
    with the host only, Bosun leaves without recording. A message still in the chat box after Enter (an account
    set to "Enter adds a new line") is sent with the Send button. The announcement has to show up in the chat, not
    marked private; otherwise the meeting ends before recording.
  - New join outcomes with their own reason and hint: `invalid-meeting` (wrong ID or passcode, or a link without
    `?pwd=`), `sign-in-required`, `captcha`. Removal from the waiting room is `denied`. The link's `pwd` is an
    encrypted token: Bosun never types it into a passcode field.
  - `platform` is `zoom` in `meeting_status` and in the events (`bosun:platform`).
- `meeting_status` shows `joined_as`: `account` (signed in) or `guest`.

### Fixed

- **Signed-in Google Meet joins.** The first live signed-in join (`profile: google-glassy`) failed with a
  `locator.click` timeout on the join button. 0.8.0 already skipped the missing name field, but it clicked the
  first join button once, with a 10 s timeout, after waiting 5 s for it to be enabled. Now:
  - The lobby is detected as guest (a name field) or account (no name field, the account shown); `name` is used
    for guests only.
  - Dialogs and tips over the lobby ("Do you want people to hear you in the meeting?", "Got it", …) are closed
    when they take the click. Only buttons inside a dialog are clicked, in EN/DE/SK/UK/RU.
  - A disabled join button ("Getting ready...") is waited for up to 25 s, and the first *visible* join button is
    clicked.
  - With the account already in the call on another device, Bosun picks "Join here too" (also under "Other ways to
    join") over "Switch here", which would drop the other device.
  - Which of these caused the live failure isn't known: 0.8.0 fails on the dialog and the other-device case in the
    stand-in, and on a "Getting ready" phase longer than 15 s.

- **An objection right before the meeting ends was lost** (since 0.6.0). When the host ended the meeting, or removed
  Bosun, between two chat reads, Bosun finished first and kept the recording. It now reads the chat once more and
  an objection still deletes the recording.
- **Captions or a meeting title could end a meeting.** Once in the call, "the meeting has ended" or "you have been
  removed" now only counts in the platform's own dialogs (and headings, once the call's controls are gone). Captions, the meeting title and the rest of the page are
  participants' words. Before the call, the whole page still counts.

### Documented

- README: Zoom, the signed-in Meet lobby, and keepalive advice for the meeting profiles (keep them signed in,
  check `keepalive_list` before an important meeting, and how keepalive visits and meetings share a profile).

### Not tested live

- The signed-in Meet changes and all of Zoom were tested against local stand-ins of the pages (`test/fakemeet.mjs`,
  `test/fakezoom.mjs`) and, on Linux, with the real audio pipeline. No live meeting was joined for this release.

## 0.8.0 — security hardening: Chromium sandbox, host allowlist, download budget

From an external security review of 0.7.0 ([docs/SECURITY-REVIEW-0.7.0.md](docs/SECURITY-REVIEW-0.7.0.md)) and the
hardening contributed with it.

### Changed — read before upgrading

- **Chromium runs with its own sandbox** (`CHROMIUM_SANDBOX=1`, the default). 0.7.0 ran it with Playwright's
  `--no-sandbox`, so a compromised renderer landed directly on the service user. On Linux, **startup now launches the
  browser once and refuses to start** if the sandbox cannot be set up, printing what the host needs: unprivileged
  user namespaces, an AppArmor profile that grants `userns`, or the setuid helper (see README › Chromium sandbox and
  docs/DEPLOY-SYSTEMD.md). `CHROMIUM_SANDBOX=0` runs unsandboxed and says so at every start.
- **Downloads are refused by default** (`DOWNLOADS=0` → `acceptDownloads: false`). No tool used them, and a page
  could write unbounded files into Playwright's temp directory (often RAM-backed). `DOWNLOADS=1` turns them on, with
  `DOWNLOADS_MAX_MB` per session (100) and `DOWNLOADS_TOTAL_MAX_MB` service-wide (500): a download past either
  budget is cancelled, or deleted if it finished first.

### Added

- **Per-tenant host allowlist**, `BROWSER_TENANT_ALLOW='ops=*.example.org,127.0.0.1:4848; swarm=*.example.org'`.
  - A named tenant gets its own forward proxy inside the service (loopback, a password of its own), and each of
    its sessions runs in a browser of its own launched with it (a temporary profile, removed with the session), so
    every connection is checked before it leaves: navigations, each redirect hop,
    subresources, page and worker WebSockets, service workers, prefetches.
  - The proxy resolves DNS itself and connects to the address it checked. A name that resolves into a private range
    is refused unless the allowlist names that address.
  - QUIC is off and WebRTC is limited to the proxy: Chromium flags, the `webrtc.ip_handling_policy` profile
    preference (full Chromium — headful, patchright — ignores the flag), and Firefox preferences for camoufox (which
    also needs `network.proxy.allow_hijacking_localhost` to send loopback through the proxy).
  - `navigate` and `keepalive_set` refuse hosts outside the list up front. `navigate` reports a refused redirect as
    `refused: "host allowlist"`, or, for an `https` hop refused at `CONNECT`, with an error naming host and port.
  - Denials are logged as host and port, never a path or query.
  - A tenant without an allowlist gets no proxy and the same shared browser as before.
- **Feature switches**: `FEATURES_MEETINGS=0` drops the meeting tools and their machinery; `FEATURES_ENGINES` limits
  the engines a session may pick. Both default to everything on, as before.
- `docs/DEPLOY-SYSTEMD.md` and `deploy/` (unit and env example): a hardened systemd deployment.
- Tests for all of the above, including an engine matrix for the allowlist (`ENGINE=patchright|camoufox npm test`)
  and a standing test of what credential masking does not cover.

### Fixed

- **camoufox: a WebSocket opened in a worker could end the service.** Playwright's Firefox driver hits an internal
  assertion on that WebSocket's events, which surfaced as an unhandled rejection, and Node exits on those, taking every
  tenant's sessions and handoffs with it. A rejection from inside the browser driver is now logged
  (`bosun: browser driver error, ignored: …`) and the service keeps serving; any other unhandled rejection still ends
  the process.

### Documented

- On `chromium` a page can neutralize the credential-masking helpers (they run in its JavaScript world), and on any
  engine a page can copy what the human typed into ordinary text. The page where a credential is typed must be
  trusted (review finding H2).

## 0.7.0 — read-only tokens for subagents

### Added

- **Per-tenant policies: `BROWSER_TOKEN_POLICIES=<tenant>=ephemeral,…`.** Tenants not named keep policy `full`,
  which is the behaviour so far. A named tenant must have a token, and an unknown policy stops the service.
- **Policy `ephemeral`, enforced by the server.**
  - `tools/list` shows only the session and page tools: `session_open`, `session_close`, `navigate`, `read`,
    `click`, `type`, `select`, `press`, `back`, `wait_for`, `screenshot` and `sessions`.
  - Every other tool answers "not allowed for this token", whatever its arguments.
  - `session_open` refuses `profile` and any engine but the default, and so does the session manager.
  - Screenshots are never saved to disk, and the connection gets no MCPL push events.
  - The tenant's session cap is `BROWSER_EPHEMERAL_MAX_SESSIONS` (default 2).
- **`bosun-mcp-stdio`, a stdio bridge.** It lets stdio-only MCP clients such as `claude --mcp-config` use a Bosun
  WebSocket. It reads `BOSUN_URL` and `BOSUN_TOKEN`, sends the token as a Bearer header, and pipes newline-delimited
  JSON-RPC, one message per WebSocket frame. Records split on LF only and are capped at 1 MiB while reading, and the
  handshake times out after 15 s. A refused token exits 3 with one line on stderr, without the token.

### Meetings against real Google Meet

From a live run on a Linux server (datacenter IP, de-AT locale).

#### Fixed

- **Joining a German Meet UI failed** with "locator.click: Timeout": "Teilnahme erbitten" and the placeholder-only
  "Ihr Name" field weren't recognized.
  - The meeting browser now asks for English (`hl=en`, Accept-Language `en-US`).
  - Lobby, waiting, denial, end, removal, device and chat texts are matched in English, German, Slovak, Ukrainian and
    Russian.
  - The guest name field is found by label or placeholder. While the page asks for a name, the only plain text
    input also counts; search and chat boxes never do.
- **A missing camera or microphone blocked the join.** Meet showed "Kamera nicht gefunden" and no toggle. A device
  that Meet reports as not found, while no control shows it on, now counts as off and is never clicked. A device
  that is present must still be verifiably switched off. A disabled control that shows "on" is never taken as off.
- **Google's refusal page was taken for a captcha.** It embeds reCAPTCHA frames. "You can't join this video call"
  shown right after asking, before anyone could admit the guest, now ends the meeting with reason
  `refused_by_google` and a hint (signed-in profile or residential IP).
  - "Before anyone could admit" means no waiting room was seen, however late the refusal comes.
  - The bot-wall check reports it as a refusal only on Meet itself, with the refusal as the page heading and no
    visible challenge frame.
  - Anywhere else, a reCAPTCHA frame still counts as a captcha.

#### Added

- **`meeting_join({profile})` with a Bosun profile signed in to Google.** The profile must exist; Firefox profiles
  are refused. There is no name step, since Meet uses the account's name, and the profile opens with the engine it
  was last used with.

## 0.6.0 — meetings (PoC)

### Added

- **Meetings, Google Meet (PoC)**, seven tools:
  - `meeting_join`, `meeting_status`, `meeting_chat_read`, `meeting_chat_send`, `meeting_stop_recording`,
    `meeting_leave`, `meeting_recording_delete`.
- **Joining:** as an unauthenticated guest, in a browser of its own.
  - Mic and camera are off and the name is filled in before "Ask to join".
  - It waits up to `max_wait_admit_min` for admission. A denied request, "You can't join this call" or no admission
    in time ends it with a clear error.
  - Chromium and patchright only; camoufox is refused.
- **Once in:** Bosun opens the chat and posts an English/German announcement (`MEETING_OWNER` names whose notetaker
  it is). **Only then** does it record the meeting's audio:
  - Ogg/Opus, 16 kHz mono 24 kbps, in `BROWSER_DATA/recordings/<tenant>/<id>.ogg`, mode 0600.
  - Each meeting has a private PulseAudio server (own runtime dir and socket): a null sink as the browser's output
    and a silent one as its microphone.
  - The audio is captured by ffmpeg.
- **Chat:**
  - A MutationObserver queues chat messages and every message from others becomes a `bosun:meeting-chat` event;
    `meeting_chat_read` returns them too.
  - **Opt-out in natural language:** a conservative matcher for English, German, Ukrainian, Russian and Slovak.
    It stops and deletes the recording at once, confirms in the chat, sends `bosun:meeting-optout` and leaves (or
    stays unrecorded).
- **Leaving:** Bosun leaves by itself when the meeting ends, when it is removed or after 2 minutes alone.
  `bosun:meeting-ended` carries the duration, reason and the recording (path, `file://` URI, bytes, as an MCP
  `resource_link`).
- **MCPL feature set `bosun.meeting`.**
- **`RECORDING_RETENTION_DAYS`** (default 30): older recordings are deleted at startup and hourly.
- **Platform interface** (`src/meetings/platforms/meet.mjs`): Zoom and Teams can be added later.
- **`docker/meeting-test.Dockerfile`:** a Linux image (Playwright + pulseaudio + ffmpeg + Xvfb) for the audio
  pipeline test.

## 0.5.0 — watch values on keepalive visits

### Added

- **Watch** (`keepalive_set` → `watch: {selector?, text_regex?, kind: "count"|"text", label}`): after the
  logged-in check a visit reads one value from the page — the selector's textContent or the visible text, narrowed
  by `text_regex` (run in the page, 5 s limit). The first read is a baseline; afterwards a count that went up or a
  text that differs raises one MCPL push event (`bosun:watch-changed`; origin `{profile, label, old, new, url}`).
  Only the value is stored (a number, or ≤200 characters), with when it was read and last changed; `keepalive_list`
  shows it, and each result in `last` says `baseline` / `unchanged` / `changed` / `lower` or why the read failed.
  - "No match" (0 / null) is only a selector or regex that matched nothing. An invalid selector or a closed page is
    a failed read that keeps the baseline. A takeover mid-read aborts the visit.
  - A new `selector` / `text_regex` / `kind` / `url` starts a new baseline. A configuration generation keeps a visit
    still running for the old one from recording.
- **MCPL feature set `bosun.watch`** for those events, next to `bosun.handoff`. A host recipe that lists
  `enabledFeatureSets` must add `bosun.watch` (or `bosun.*`); one without the list gets both. A new
  `featureSets/update` Request now offers queued events again. Feature sets the host didn't ask for are no longer
  reported as unavailable. `enabled` / `disabled` also accept `*` and `prefix.*`.
- **`every_minutes`** (at least 30) as an alternative to `every_hours`. `jitter_min` defaults to 30 or a quarter of
  a shorter interval.
- **`quiet_hours`** (`"22-08"`, local time in `TZ`, default `Europe/Vienna`): the interval runs four times slower
  during the window (an interval that straddles its edge is stretched only for the part inside). Wall-clock edges.
  Time is integrated between quiet edges and DST changes, so skipped and repeated hours count as they really pass. Jitter and "skip
  while an agent has the profile open" are unchanged.

### Fixed

- **Trackpad cursor shook while the finger rested.** A finger held still on a phone reports ±1–2 px of sensor
  noise. Scaled to the page, that was ±10 px, and it was sent as a stream of mouse moves. A finger that stays within
  3 px for 120 ms now counts as resting. Its centre is averaged, and the cursor settles there, so an idle cursor
  sends nothing. A deliberate fine shift (≥1 px of averaged movement) still moves it, also while dragging, and
  what is left of it is applied before the release. The jitter on server-side interpolated paths during real movement is unchanged. The tap/hold threshold
  now measures distance from where the finger went down, not the noisy path length.
- **URLs are http(s) only at every entry point:** besides the tool layer, the keepalive core refuses a non-web URL
  in `set()`, and a visit refuses one found in a hand-edited `keepalive.json` before opening the profile.

## 0.4.0 — keepalive

### Added

- **Keepalive for persistent profiles** (`keepalive_set` / `keepalive_list` / `keepalive_remove`, per tenant): a
  scheduler inside the service visits a profile every `every_hours` (default 12, min 1) ± `jitter_min` (default 30),
  with the engine and headful/headless mode the profile was last used with, loads one URL, moves the mouse along
  interpolated paths and scrolls for 20–60 s (no clicks, typing or navigation), checks `logged_in_check`
  (`text` / `selector` / `url_not_contains`) and closes the profile. Results (time, ok / logged_out / bot_check /
  error, duration; last 10) and schedules persist in `BROWSER_DATA/keepalive.json`. One visit at a time, a few
  minutes apart; skipped while an agent has the profile open, postponed at the session limit, taken over at once by
  an agent that opens the profile. `KEEPALIVE=0` pauses the scheduler.
- **MCPL push events** (first one): `push/event` with feature set `bosun.handoff`, tags `bosun:needs-human`,
  `bosun:source=keepalive`, `bosun:reason=…`, `bosun:profile=…`, when a kept-alive profile is logged out or at a bot
  check. The manifest is in `capabilities.experimental.mcpl`; pushes go only to connections whose client asked for
  MCPL and whose host granted `pushEvents` via a `featureSets/update` Request (a notification can only narrow it).
  Up to 20 undelivered events per tenant wait for the next such connection. `mcpl/manifest` returns the manifest.
- Profiles record the engine and mode they were last opened with (`bosun-profile.json`).
- Visit failures are stored as fixed categories (`navigation failed (net::ERR_…)`, `activity failed`, …), never
  as browser error text. A failed save of `keepalive.json` is logged and retried; the event is raised regardless.

### Fixed

- Opening a persistent profile right after its session was closed — in particular when the closing was triggered by
  a dropped connection, idle timeout or crash, whose browser is still shutting down — failed with "profile … is
  already open in another session". The open now waits for that close to finish (bounded by the close deadline).


## 0.3.0 — live view on phones

From testing the handoff on an iPhone (Safari and Telegram's in-app browser, plain http over a mesh VPN).

### Changed behaviour

- **The live-view link can be reopened.** It used to be claimed by the first browser tab for good (viewer key in
  `sessionStorage`), so closing Telegram's in-app browser and tapping the link again showed "closed". Now the link
  admits **one viewer at a time** until Done, Give up, expiry or cancel: a second viewer is refused (WebSocket close
  `4409`, and the page waits and retries) while the first is connected, and may take over once the first has been
  silent for more than 5 s (it is pinged every 2 s). There is no per-tab viewer key any more (a duplicated tab
  would copy it): a reconnecting tab waits like anyone else. A finished handoff's link answers 404.

### Added

- **First frame at once:** the last frame is cached per handoff and sent to a (re)connecting viewer before the stream
  starts; a page that doesn't repaint is re-captured at least every 2 s (`Page.captureScreenshot` /
  `page.screenshot`), so the screen is never black.
- **Paste bar:** a masked text field (eye button to show it) with **Insert** (or Enter). The text is inserted into the
  page's focused field (`insertText`) and the field is cleared and masked again; with a clipboard API (https or
  localhost) the empty field's button reads **Paste** and inserts the clipboard directly. Desktop ⌘V/Ctrl+V on the
  live view also inserts. Pasted text is never logged and never reaches the agent; the service drops it once
  dispatched.
- **Trackpad mode** (default on touch devices; toggle **Tap | Trackpad**): a cursor drawn over the stream; one finger
  moves it (relative, accelerated), tap clicks at the cursor, two fingers scroll, hold then drag presses the button
  (sliders, drag-to-verify). The service turns each move into a human-looking path (eased steps of ~8 px on a slight
  curve with sub-pixel jitter) instead of jumping. Tap mode behaves as before (scroll now happens at the finger).
  A desktop mouse sends real hover moves and press/release (drag works there too).
- **Bot-check loop detection:** if a page that looks like a bot check keeps reloading (more than 5 navigations to the
  same URL within 30 s) or page tools on it keep failing with "Execution context was destroyed" (3 within 30 s),
  page tools — also ones that failed for another reason, e.g. a `wait_for` timeout — return
  `bot check keeps reloading (likely IP reputation); try engine chromium + request_human, or another network`. The
  history is reset when a handoff ends.
- **Mobile layout:** one-line status bar that never covers the page, the stream fitted between the bars, every
  control (Done, Give up, Keys, paste bar, Tap/Trackpad) in a bottom bar within thumb reach (down to 320 px wide), 44 px targets,
  `viewport-fit=cover` with safe-area insets, `100dvh` so Safari's toolbar doesn't hide the controls, a key strip
  (Tab, Enter, ⌫, Esc, arrows) behind **Keys**. Screenshots in [docs/liveview/](docs/liveview/).
- `scripts/liveview-shots.mjs` regenerates those screenshots.

### Live-view protocol (viewer → service)

`move {x,y}`, `down {x,y}`, `up {x,y}` and `wheel {x,y,dx?,dy}` join `click`, `text`, `key`, `done`, `giveup`.
Consecutive queued moves collapse into the latest, queued scrolling at one point adds up, and a release is never
dropped from a full queue (repeated releases collapse into one). A drag cut off by teardown is released where the
pointer is. Snapshots and the initial cursor use the measured CSS viewport where the page has no fixed one (patchright). The service sends `{cursor:{x,y}}` so a new viewer starts where the pointer is.

## 0.2.0 — engines

### Added

- **Engines:** `ENGINE` (default `chromium`) and an optional `engine` parameter on `session_open`:
  `patchright` (Chromium fork without the CDP/automation leaks; persistent context per session, its recommended
  settings) and `camoufox` (anti-detect Firefox; camoufox-js `launchOptions()` driven by our Playwright 1.64, one
  browser per session). Both are `optionalDependencies` (`npm ci --omit=optional` skips them). `session_open` and
  `sessions` report the engine.
- Live view for non-CDP engines: frames from Playwright's `page.screencast`, input via `page.mouse`/`page.keyboard`.
- `npm run test:engines` runs the suite once per installed engine; `npm run measure:engines` re-runs the
  bot-detection/RAM measurements in [docs/ENGINES.md](docs/ENGINES.md).
- `CAMOUFOX_OS` (fingerprint OS, default: the host's).

### Changed

- The startup refuses to run if the default `ENGINE` (package and browser binary) is not installed, with the install
  command. Requesting a missing engine on `session_open` is an error; nothing falls back to another engine silently.
- Persistent profiles record their engine family (`bosun-profile.json`); existing profiles count as Chromium. A failed
  open doesn't claim a fresh profile.
- The password tracker no longer patches `Element.prototype.attachShadow` (detectable); it follows open and
  declarative shadow roots with MutationObservers instead. It runs in the world Bosun scans in: an init script on
  Chromium and Camoufox, installed after every frame navigation on patchright (whose init scripts are page-visible).
  Bosun additionally notes password inputs when a handoff starts and every 500 ms during it.
- A session close that hangs is escalated: Bosun kills the browser processes on the session's directory and frees the
  slot (and deletes the temp profile) only once they are gone. Stale temp profiles are removed at startup.
- Live view: a handoff resolves only after a viewer's stream startup has settled; a reconnecting viewer waits until
  every earlier viewer has drained and stopped; compound Playwright inputs (move + press) re-check revocation between
  steps.

## 0.0.2 — review fixes (Codex round 1)

Fixes from the first security/correctness review (B01–B26). Tool names and parameters are unchanged except where
noted under **Changed behaviour**.

### Changed behaviour

- **Sessions are owned by the connection that opened them.** Other connections no longer see them in `sessions` and
  get `no session <id>` when they try to use or close them. Sessions are closed when their connection disconnects
  (previously they stayed open, shared by everyone, until closed or restart) and after `IDLE_TIMEOUT_SEC` (900) idle.
- **Persistent profiles moved to `profiles/<tenant>/<name>`.** Tenant `default` is used for stdio and `BROWSER_TOKEN`.
  To keep an existing profile: `mv data/profiles/<name> data/profiles/default/<name>`. A profile can be open in one
  session at a time (`profile … is already open`).
- **WebSocket auth is mandatory.** The service refuses to start on a non-loopback `WS_HOST` without
  `BROWSER_TOKEN`/`BROWSER_TOKENS`; on loopback an open listener needs `ALLOW_NO_TOKEN=1`. Tokens must be at least
  16 characters. Browser `Origin`s are refused unless listed in `WS_ALLOWED_ORIGINS`. `Authorization: Bearer` is
  preferred; `?token=` still works.
- **`navigate` accepts only http/https** (was: any URL syntax, incl. `file:` and `javascript:`).
- **Handoff blinding covers every page tool** (`select`, `press`, `back`, `wait_for` were not blocked), and
  `sessions` / `handoff_wait` (`still_waiting`) no longer return URL/title during a handoff. `sessions` shows
  `handoff: "active"` instead of `url` for such sessions.
- **`handoff_wait` default timeout is 50 s** (was 300 s, beyond the SDK's 60 s request timeout).
  `request_human` with `wait=true` now waits at most 50 s and may return `still_waiting` with the link.
- **Live-view links are claimed by the first WebSocket viewer**; afterwards only that viewer (by key) can connect,
  one socket at a time.
- **Live view binds `LIVE_HOST`, default `127.0.0.1`** (was `0.0.0.0`). Set it to your VPN address (or `0.0.0.0`).
- **Screenshots are no longer written to disk by default.** `SAVE_SHOTS=1` keeps them (per session, 0600, at most
  `SHOTS_PER_SESSION`, deleted on close). The text part of the result is then the path, otherwise a note.
- **Argument bounds:** `read.maxChars` 1–200000, `wait_for.timeoutMs` ≤ 60000, `request_human.reason` 1–300 chars,
  `handoff_wait.timeoutSec` 1–1800, length limits on selectors/text/values. `read` in a11y mode refuses pages over
  `MAX_DOM_NODES` without a `selector`; full-page screenshots are cut at 8000 px.
- Configuration is validated (`MAX_SESSIONS=abc` used to disable the cap); bad values stop startup.

### Fixed

- B01 cross-connection access to sessions and profiles → per-connection ownership, per-tenant profile directories.
- B02 / B26 unauthenticated network listener, non-constant-time compare → mandatory token, auth in the HTTP upgrade
  before any WebSocket/MCP server exists, SHA-256 digests compared with `crypto.timingSafeEqual`.
- B03 scheme policy on `navigate`.
- B04 / B05 handoff blinding gaps and in-flight races → one per-session operation queue for all page tools;
  `request_human` queues behind running work; results of operations overtaken by a handoff are discarded.
- B06 password masking by label → detection by DOM type/autocomplete/name/label in all frames, value-based masking
  in `read`, masked screenshots, credential fields cleared after an unsuccessful handoff.
- B07 / B08 / B19 reusable link, expiry/attach race, interleaved input → claim on first socket + viewer key, single
  viewer, attach re-checks state after every await, validated input dispatched through one FIFO that finish revokes.
- B09 / B10 crash on malformed upgrade URL or socket errors → guarded upgrade handlers, error listeners everywhere,
  connection failures isolated to the connection.
- B11 session cap race and duplicate browser launches → synchronous reservation, single-flight launch promise.
- B12 unbounded resources → `maxPayload` (1 MiB MCP, 16 KiB live view), connection and in-flight caps, heartbeats,
  screencast frames acked after send and dropped above 1 MiB buffered, input queue bounded.
- B13 / B14 / B15 / B16 / B17 lifecycle → one idempotent disposal path (close, crash, page close, idle, disconnect,
  shutdown) that cancels the handoff and releases capacity; browser relaunch after a crash; partial opens cleaned up;
  shutdown stops admission, is idempotent and deadline-bounded.
- B18 handoff wait timers and stale-handoff clearing.
- B21 screenshot retention.
- B22 examples no longer print the live-view link or page content; the link goes to a private 0600 temp file.
- B23 WebSocket transport `send` rejects on a closed socket and settles from the write callback.
- B24 `npm test` (node:test): config/auth, service, handoff and live-view race suites against a local page server.
- B25 `package-lock.json` committed (`npm ci` works); README corrected.

### Round 2 (second Codex review, R01–R09)

- R01 MCP connections with more than 64 unanswered requests, or more than 8 MiB of unread output, are disconnected.
- R02 A handoff ends only after the human's in-flight input has returned and the screencast is detached; if that
  hangs (10 s) the session is closed.
- R03 A connection that disconnects while `session_open` is still launching no longer leaves an orphaned session.
- R04 Inputs that are or ever were `type=password` are tracked from document start (init script, incl. open shadow
  roots), so show-password toggles count even before Bosun's first scan.
- R05 `aria-labelledby` resolves inside the input's own shadow tree.
- R06 Masking fails closed: `read`/`screenshot` return an error if a (non-detached) frame can't be inspected, and if
  clearing credential fields after give-up/timeout fails, the session is closed instead of handed back.
- R07 Shutdown also waits for disposals that were already in progress.
- R08 The `read` DOM-size guard counts frames and open shadow roots.
- R09 A screenshot write that finishes after its session closed is deleted and the call fails.
- Calls on a session closed by Bosun (idle, crash, cleanup failure) say why: `no session <id> (closed: <reason>)`.

## 0.0.1

M0 prototype.
