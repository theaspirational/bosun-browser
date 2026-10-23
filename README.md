# Bosun

**The boatswain browser for agents.** A self-hosted browser service that gives AI agents a real browser — and
calls a human on deck when it needs one (CAPTCHA, cookie wall, 2FA).

> Status: **prototype (M0)**. Works end to end in one deployment; APIs will change. See [docs/DESIGN.md](docs/DESIGN.md)
> and [CHANGELOG.md](CHANGELOG.md).

> Security: Chromium runs **with its own sandbox** ([`CHROMIUM_SANDBOX`](#chromium-sandbox)), downloads are refused
> by default (`DOWNLOADS=0`), and a tenant can be kept to a [host allowlist](#per-tenant-host-allowlist)
> (`BROWSER_TENANT_ALLOW`). A review of 0.7.0, and what is still risky, is in
> [docs/SECURITY-REVIEW-0.7.0.md](docs/SECURITY-REVIEW-0.7.0.md); a Linux deployment guide is in
> [docs/DEPLOY-SYSTEMD.md](docs/DEPLOY-SYSTEMD.md).

## What it does today

- Headful Chromium (Playwright) under Xvfb — fewer bot flags than headless.
- **Engines** (`ENGINE`, or `engine` on `session_open`): `chromium` (default), `patchright` (Chromium without the
  CDP/automation leaks) and `camoufox` (anti-detect Firefox). See [docs/ENGINES.md](docs/ENGINES.md) for what each one
  passes and what it costs.
- MCP server over **stdio** (Claude Code, Codex, …) or **WebSocket** (shared service).
- Tools: `session_open` / `session_close` / `sessions`, `navigate`, `read` (accessibility snapshot with element
  refs), `click`, `type`, `select`, `press`, `back`, `wait_for`, `screenshot`, `request_human`, `handoff_wait`,
  `keepalive_set` / `keepalive_list` / `keepalive_remove`, `upload_create` / `upload` (unless `FEATURES_UPLOADS=0`),
  and (only with `FEATURES_MEETINGS=1`, which this fork does not default to) `meeting_join` /
  `meeting_status` / `meeting_chat_read` / `meeting_chat_send` / `meeting_stop_recording` /
  `meeting_leave` / `meeting_recording_delete`.
- **Keepalive** for persistent profiles: scheduled visits keep sliding login sessions alive without a model, and a
  logged-out profile raises an MCPL `bosun:needs-human` push event. A visit can also **watch** one value (say, a
  "43 neue Nachrichten" counter) and push `bosun:watch-changed` when it goes up. See
  [Keeping logins alive](#keeping-logins-alive) and [Watching a value](#watching-a-value).
- **Meetings (PoC):** joins a Google Meet (as a guest or signed in) or a Zoom meeting (signed in, in Zoom's web
  client) as a notetaker, announces itself in the chat, records the audio to a file and leaves; a "please don't record" in the chat stops and deletes the recording. Transcription happens later,
  from the file. See [Meetings (PoC)](#meetings-poc).
- **File uploads** into pages: the agent sends the file with one `curl -T` to a one-time URL on the MCP port
  (streamed to disk, up to 300 MB), then `upload` puts it into a file input, answers the file chooser a button
  opens, or drops it on a drop zone. See [Uploading files](#uploading-files).
- Sessions are **ephemeral** (wiped on close) or use a named **persistent profile** of the tenant (stays logged in;
  no RAM while idle). A session belongs to the connection that opened it: other connections can't see, use or close
  it, and it is closed when that connection goes away or after `IDLE_TIMEOUT_SEC` without use.
- `navigate` and `keepalive_set` accept only `http://` and `https://` URLs (no `file:`, `data:`, `javascript:`,
  `about:`, `chrome:`, `view-source:`, `blob:`, `ftp:` …).
- **Bot-wall detection** after navigation/click (Cloudflare challenge pages, CAPTCHA iframes, "access denied" texts).
  A bot check that keeps reloading itself (IP reputation) is reported as such: `bot check keeps reloading (likely IP
  reputation); try engine chromium + request_human, or another network`.
- **Human handoff:** `request_human` returns a link (15 min) to a **live view** of the tab, made for a phone:
  **Trackpad** mode (cursor, drag to move, tap to click, two fingers scroll, hold and drag for sliders) or **Tap**
  mode, a masked **paste bar** for passwords and codes, a key strip, a desktop mouse works as usual. The link can be
  reopened (one viewer at a time) until **Done** resumes the agent. See [Handoff](#handoff) for what is and isn't
  protected.

## Run

```sh
npm ci                                   # add --omit=optional to skip patchright/camoufox
npx playwright install --with-deps chromium
npx patchright install chromium          # only for ENGINE=patchright
npx camoufox-js fetch                    # only for ENGINE=camoufox (Node 22+)
npm test            # headless, against a local test server; no internet needed
npm run test:engines  # the same suite once per installed engine

# stdio (an MCP client spawns it)
xvfb-run -a node src/server.mjs

# WebSocket service + live view, reachable over a VPN interface (here 100.64.0.10; for a systemd service with
# both listeners on loopback behind a private-network proxy see docs/DEPLOY-SYSTEMD.md)
WS_HOST=100.64.0.10 WS_PORT=7360 BROWSER_TOKEN=<32+ random chars> \
LIVE_HOST=100.64.0.10 LIVE_PORT=7350 LIVE_BASE_URL=http://100.64.0.10:7350 \
  xvfb-run -a -s "-screen 0 1366x900x24" node src/server.mjs
```

Clients authenticate with `Authorization: Bearer <token>` (the old `?token=` query parameter still works but puts
the secret in URLs and logs; prefer the header). The WebSocket listener **refuses to start** on a non-loopback
address without a token; on loopback an unauthenticated listener needs `ALLOW_NO_TOKEN=1` (local development only).
The two listeners are separate: `WS_HOST`/`WS_PORT` carry MCP (token-protected), `LIVE_HOST`/`LIVE_PORT` serve the
human's live view (protected by the handoff link). Both default to `127.0.0.1`; bind them to a VPN/mesh address or
put a TLS reverse proxy in front, and set `LIVE_BASE_URL` to the address the human's phone uses.

### Environment

| variable | default | |
|---|---|---|
| `BROWSER_TOKEN` | – | token for tenant `default` (16+ chars) |
| `BROWSER_TOKENS` | – | more tenants: `alice:<token>,bob:<token>` |
| `BROWSER_TOKEN_POLICIES` | – (all `full`) | per-tenant policy: `swarm=ephemeral` (see [Read-only tokens for subagents](#read-only-tokens-for-subagents)) |
| `BROWSER_EPHEMERAL_MAX_SESSIONS` | 2 | session cap of each `ephemeral` tenant (at most `MAX_SESSIONS_PER_TENANT`) |
| `BROWSER_TENANT_ALLOW` | – (unrestricted) | per-tenant host allowlist, enforced by a per-tenant forward proxy: `ops=*.example.org,127.0.0.1:4848; swarm=*.example.org` (see [Per-tenant host allowlist](#per-tenant-host-allowlist)) |
| `FEATURES_MEETINGS` | `0` in this fork (upstream: `1`) | `1` = wire the meeting tools; `0` = they are not listed and their handlers not wired |
| `FEATURES_UPLOADS` | `1` | `0` = no upload tools and no PUT endpoint |
| `UPLOAD_MAX_BYTES` | 314572800 (300 MB) | largest file one upload may carry |
| `UPLOAD_TENANT_QUOTA_BYTES` | 1073741824 (1 GB) | uploaded bytes one tenant may hold at a time (at least `UPLOAD_MAX_BYTES`) |
| `UPLOAD_TTL_SEC` / `UPLOAD_URL_TTL_SEC` | 3600 / 900 | an uploaded file is deleted this long after it arrived; an upload URL is valid this long |
| `UPLOAD_BASE_URL` | – (the `Host` the client connected with, `http://`) | where tenants reach the MCP port, for the PUT URL; set it behind TLS or another name |
| `FEATURES_ENGINES` | `chromium` in this fork (upstream: all three) | engines a session may ask for, comma list (e.g. `chromium,patchright`); `ENGINE` is always included |
| `CHROMIUM_SANDBOX` | `1` | `0` = run Chromium without its own sandbox (logged at every start); see [Chromium sandbox](#chromium-sandbox) |
| `DOWNLOADS` | `0` | `1` = let pages download files (with the budget below); `0` = the context refuses them |
| `DOWNLOADS_MAX_MB` / `DOWNLOADS_TOTAL_MAX_MB` | 100 / 500 | downloaded bytes a session, and the whole service, may keep |
| `WS_HOST` / `WS_PORT` | `127.0.0.1` / – | WebSocket MCP listener (stdio when `WS_PORT` is unset) |
| `WS_ALLOWED_ORIGINS` | – | comma list of browser Origins allowed to connect (non-browser clients send none) |
| `ALLOW_NO_TOKEN` | – | `1` = no auth, loopback only |
| `MAX_CONNECTIONS` | 32 | concurrent WebSocket connections |
| `MAX_INFLIGHT` | 8 | concurrent tool calls per connection |
| `LIVE_HOST` / `LIVE_PORT` / `LIVE_BASE_URL` | `127.0.0.1` / – / derived | live view listener and the URL put in links |
| `HANDOFF_TTL_SEC` | 900 | handoff link lifetime |
| `BROWSER_DATA` | `./data` | profiles (`profiles/<tenant>/<name>`) and saved screenshots |
| `HEADLESS` | – | `1` = headless browser (more detectable; use for tests) |
| `ENGINE` | `chromium` | default engine: `chromium`, `patchright`, `camoufox` (must be installed, or startup fails) |
| `CAMOUFOX_OS` | host OS | OS of the Camoufox fingerprint: `macos`, `windows`, `linux` |
| `MAX_SESSIONS` | 3 | sessions across all tenants |
| `MAX_SESSIONS_PER_TENANT` | `MAX_SESSIONS` | |
| `IDLE_TIMEOUT_SEC` | 900 | close sessions unused this long (`0` = never; a session in handoff is never idle) |
| `MAX_PAGES_PER_SESSION` | 5 | popups beyond this are closed |
| `KEEPALIVE` | `1` | `0` = don't run scheduled keepalive visits (schedules are kept) |
| `TZ` | `Europe/Vienna` | IANA time zone for keepalive `quiet_hours` |
| `RECORDING_RETENTION_DAYS` | 30 | meeting recordings are deleted this many days after they were written |
| `MEETING_OWNER` | – | name in the meeting announcement ("Hi, I'm Glassy, `<owner>`'s AI notetaker"); unset: "an AI notetaker" |
| `MAX_DOM_NODES` | 60000 | `read` (a11y, whole page) refuses larger pages; pass `selector` |
| `SAVE_SHOTS` / `SHOTS_PER_SESSION` | – / 20 | `1` = also keep screenshots on disk (0600, deleted when the session closes) |

All numbers are validated at startup; a bad value stops the service instead of silently disabling a limit.

### Engines

| engine | process model | live view | notes |
|---|---|---|---|
| `chromium` | one shared browser, a context per session | CDP screencast | Playwright's Chromium |
| `patchright` | a browser per session (persistent context; temp profile for ephemeral sessions) | CDP screencast | patchright's recommended setup: no custom UA, no automation-flag args, window-sized viewport |
| `camoufox` | a browser per session | Playwright screencast + `page.mouse`/`keyboard` | fingerprint (window, screen, fonts, UA) from Camoufox; `humanize` off (hangs clicks with Playwright 1.64) |

Only the engines in `FEATURES_ENGINES` (default in this fork: `chromium`; upstream: all three; `ENGINE` is always
included) can be asked for;
`session_open`'s schema lists exactly those, and the session manager refuses the others. A session asking for an
engine that is enabled but isn't installed gets an error naming the install command; there is no silent
fallback to another engine. A persistent profile remembers its engine family (Chromium or Firefox) and refuses the
other. patchright and camoufox-js are `optionalDependencies`; their browsers are separate downloads.

Chromium spawns many threads: under systemd give the unit a generous `TasksMax` (e.g. 2000).

## Uploading files

Two calls and a `curl` between them:

```text
upload_create { filename: "report.pdf", size_bytes: 48213 }
  -> { file_id: "f3a…", put_url: "http://127.0.0.1:8002/upload/f3a…?t=…",
       curl: "curl -sS --fail-with-body -T 'report.pdf' 'http://127.0.0.1:8002/upload/f3a…?t=…'", valid_min: 15 }
$ curl -sS --fail-with-body -T report.pdf 'http://127.0.0.1:8002/upload/f3a…?t=…'
  -> {"file_id":"f3a…","filename":"report.pdf","size":48213}
upload { session, selector: "input[type=file]", file_id: "f3a…" }      # or ref / role+name / text
  -> { method: "input", input_files: ["report.pdf"], url, title }
click { session, role: "button", name: "Send" }
```

- **Where the bytes go.** The PUT goes to the same host and port as MCP (the URL is built from the `Host` the MCP
  client connected with, or `UPLOAD_BASE_URL`), so whatever reaches MCP reaches it. The body is streamed straight to
  `BROWSER_DATA/uploads/<tenant>/<file_id>/<filename>` (0600): never held in memory, never base64. The browser
  reads the file from there itself; no bytes cross the MCP connection.
- **The URL works once,** for `UPLOAD_URL_TTL_SEC` (15 min), and only for the tenant that asked for it. Its secret
  (`?t=`) is the credential. Instead of it, `PUT /upload/<file_id>` with the tenant's own token in
  `Authorization: Bearer` works too; another tenant's token is refused either way.
  `size_bytes` is optional; when given, the PUT must carry exactly that many bytes.
- **Small files** (up to 1 MB): `upload_create { filename, content_base64 }` stores the file at once, no PUT.
- **Limits.** `UPLOAD_MAX_BYTES` per file (300 MB) and `UPLOAD_TENANT_QUOTA_BYTES` per tenant (1 GB) are checked
  against `Content-Length` before any byte is read, and again while the body streams: past either, the answer is
  `413` and nothing stays on disk. A tenant holds at most 50 uploads at a time (waiting, arriving or ready), and
  streams at most 4 at once (16 across the service); past that a PUT gets `429` and its URL stays valid.
- **Files never cross tenants.** A `file_id` of another tenant answers like one that never existed.
- **Deletion.** A file is deleted when the session that used it closes (the last one, if several did),
  `UPLOAD_TTL_SEC` (1 h) after it arrived, or when the service starts. Submit the form within the hour.
- **Read-only tokens** (policy `ephemeral`) can't upload: the tools are refused, and so is a PUT with such a token.

How `upload` puts the files in:

1. The element is an `<input type=file>`, hidden or not, or the `<label>` of one: the input gets the files
   directly. Several files (`files: [id, id]`) only when it has `multiple`.
2. Anything else (an "Upload" button, a link) is clicked, and the file chooser it opens is answered.
3. If no chooser opens within 5 s, the files are **dropped** on the element: `dragenter`, `dragover`, `drop` with
   the files in a `DataTransfer`. `accepted` says whether something on the page took the drop.

`method: input | chooser | drop` forces one of them.

Drag-and-drop is best effort:
- The events are synthetic (`isTrusted` is false). A drop zone that checks for real user events ignores them.
- On `camoufox`, Firefox hides files dropped from outside the page's own scripts, so Bosun dispatches the drop
  from a script element in the page. A page whose Content-Security-Policy refuses inline scripts gets no files;
  `note` says so. Use `chromium` for that page.
- An element inside a shadow root may not be found by the camoufox drop script; drop on its host, or use another
  engine.

Prefer the page's file input or its "Upload" button where there is one: both are as good as a person picking a
file.

## Handoff

<p><img src="docs/liveview/iphone-trackpad.png" width="240" alt="Live view on an iPhone, trackpad mode">
<img src="docs/liveview/iphone-tap.png" width="240" alt="Live view on an iPhone, tap mode with the key strip"></p>

- **One viewer at a time, reopenable until the end.** While the handoff runs, the link opens the live view whenever
  nobody else is connected — closing a chat app's in-app browser and tapping the link again works. A second viewer
  is refused (its page says the link is open on another device and retries) until the first disconnects or has been
  silent for more than 5 s. Opening the page alone (e.g. a link preview) doesn't connect. Done, Give up, expiry,
  `session_close` and disconnect of the agent end the handoff; from then on the link is dead (404).
- **Controls** (bottom bar): **Tap | Trackpad** (trackpad is the default on touch screens), **Keys** (Tab, Enter, ⌫,
  Esc, arrows, and the phone keyboard), the **paste bar**, **Give up**, **Done**. Trackpad: one finger moves the
  cursor (accelerated), tap clicks at the cursor, two fingers scroll, hold then drag holds the button down. The
  service moves the page's mouse along an interpolated, slightly jittered path rather than jumping.
- **Paste bar:** paste (long-press → Paste on iOS) or type into the masked field, then **Insert** or Enter: the text
  goes into the page's focused field (tap that field first) and the bar is cleared. The eye button shows what's in
  it. The text is not logged, not kept by the service after it is typed, and never sent to the agent — but once it
  is in the page, the page field rules below apply (a password field is masked; an ordinary field is not).
- A reconnecting viewer gets the last frame at once, and a page that doesn't repaint is re-captured every 2 s.
- While a handoff is active **every** page tool (`read`, `screenshot`, `navigate`, `click`, `type`, `select`,
  `press`, `back`, `wait_for`) is refused, and `sessions`/`handoff_wait` report no URL or title. Tool calls that were
  already running when `request_human` came in finish first; the human gets the tab after them.
- `handoff_wait` waits 50 s by default (below the MCP SDK's 60 s request timeout); call it again on `still_waiting`.
  Longer `timeoutSec` needs a longer client-side request timeout.
- After the handoff the agent can read the page again. What the human typed into **password, PIN, OTP and card
  security-code fields** (detected by input type, `autocomplete`, name/id and label, across frames and open shadow
  roots, including show-password toggles) is masked as `[masked]` in `read` output and blacked out in screenshots.
  After **Give up / timeout / cancel** those fields are emptied before the agent resumes; if that fails, the
  session is closed instead. If a frame can't be inspected, `read`/`screenshot` fail rather than return unmasked
  output. The handoff ends only after the human's last input has reached the page.
- A password field that is revealed with a show-password toggle stays masked: an event-driven tracker remembers every
  input that ever was `type=password` (incl. shadow roots), and Bosun also notes them when a handoff starts and every
  500 ms during it. On `chromium` Bosun's helpers run in the page's own JavaScript world, so a page can detect them
  — and replace them, which switches masking off for fields that aren't sensitive by markup (probed, see
  [docs/SECURITY-REVIEW-0.7.0.md](docs/SECURITY-REVIEW-0.7.0.md) finding H2); on `patchright` and `camoufox` they run
  in an isolated world, which stops that and nothing else (details in [docs/ENGINES.md](docs/ENGINES.md)).
- Not protected: text the human types into ordinary fields, secrets the page itself echoes as normal text, custom
  widgets that aren't `<input>`/`<textarea>` (e.g. per-digit OTP boxes built from `div`s), closed shadow roots.
  Those are visible to the agent after Done. Ask the human to finish the login (submit it) before pressing Done.

## Keeping logins alive

A persistent profile stays logged in only as long as the site's session does. Many sites extend the session each
time it is used ("sliding" sessions) and end it after some idle time. Bosun can visit a profile on a schedule so
that idle time never runs out — **without a model**:

```jsonc
// once, after the human logged the profile in (session_open({profile:"shop"}) + request_human)
keepalive_set({ "profile": "shop", "url": "https://shop.example/account",
                "every_hours": 12, "jitter_min": 30,                     // defaults; every_hours >= 1
                "logged_in_check": { "text": "My account" } })          // or selector / url_not_contains
keepalive_list()     // schedule, next run, last results: ok | logged_out | bot_check | error
keepalive_remove({ "profile": "shop" })
```

The interval is `every_hours` (default 12) or `every_minutes` (at least 30), each visit shifted by up to
± `jitter_min` (default 30, or a quarter of a shorter interval). `quiet_hours` (`"22-08"`, `"22:30-07:00"`, local
time in `TZ`, default `Europe/Vienna`) makes the interval **four times longer** while it lasts, so a 30-minute
watch visits about every two hours at night. An interval that starts before a quiet window is stretched only for
its part inside it. Quiet hours follow the wall clock, and on DST nights the time is counted as it really passes. Calling `keepalive_set` again replaces the whole configuration of that profile.

Each visit, at the interval ± `jitter_min` (first one an interval after `keepalive_set`):

- opens the profile with the **engine and mode it was last used with** (recorded in the profile; a profile used
  headful is never opened headless, so the fingerprint stays the same);
- loads `url`, then for 20–60 s moves the mouse along human-looking paths (the live view's trackpad interpolation),
  scrolls 1–3 times and sometimes rests over a link. It **never clicks, types or navigates**;
- checks `logged_in_check` (every given condition must hold: `text` visible, `selector` visible, URL doesn't
  contain `url_not_contains`), reads the [watched value](#watching-a-value) if there is one, closes the profile and
  records the result (time, status, duration; last 10 kept).

Visits run one at a time, a few minutes apart, and never take the last free session slot from agents. A profile an
agent has open is skipped (it's in use anyway); an agent opening a profile during a visit takes it over at once.
Schedules and results live in `BROWSER_DATA/keepalive.json` (mode 0600) and survive restarts. Nothing from the
page is stored or logged beyond the check result and the watched value.

When a visit finds the profile **logged out** or stuck at a **bot check**, Bosun pushes an MCPL event to the
tenant's agent (feature set `bosun.handoff`, tags `bosun:needs-human`, `bosun:source=keepalive`,
`bosun:reason=logged-out|bot-check`, `bosun:profile=<name>`; origin `{profile, url, reason}`), so the agent can open
the profile and call `request_human`. Events are only sent to connections whose host asked for MCPL at
initialize and granted `pushEvents` (`featureSets/update`); if none is connected, up to 20 per tenant wait for the
next one. There is no retry loop: the next attempt is the next scheduled visit.

**Limits — what this can't do:**

- It only helps sites with **sliding sessions**. A cookie with an absolute expiry (e.g. "remember me for 30 days")
  ends on that date however often the profile is visited.
- **Device re-verification, periodic re-login and 2FA prompts** still need a human (that's what the event is for).
- Visits look like a person glancing at the page, but **too-frequent visits can look bot-like**, especially at
  the same time every day — hence the 12 h default and the jitter. Don't go below a few hours unless the site's
  idle timeout requires it.
- The visit runs from Bosun's IP with Bosun's browser; if the site ties the session to a different network or
  device, keeping it alive here doesn't help.

### Watching a value

A visit can read one value from the page after the logged-in check and tell the agent when it changes. For
willhaben's message counter in the header:

```jsonc
keepalive_set({ "profile": "willhaben", "url": "https://www.willhaben.at/iad/myprofile/chat",
                "every_minutes": 30, "quiet_hours": "22-08",
                "logged_in_check": { "url_not_contains": "/login" },
                "watch": { "text_regex": "(\\d+) neue Nachrichten", "kind": "count", "label": "willhaben messages" } })
```

- **What is read:** the `selector`'s `textContent` if given, else the page's visible text. `text_regex` picks the
  value (its first capture group, else the whole match). The regex runs in the page with a 5 s limit, so a
  pathological pattern can't stall the service.
  - `kind: "count"`: the first whole number in the text. Thousands separators inside it are ignored, but the
    regex has to capture them: use `([\d.]+)` rather than `(\d+)` if the site writes "1.234". No match counts
    as **0**, since many badges disappear when nothing is new.
  - `kind: "text"`: the text with whitespace collapsed, at most 200 characters. No match is `null`.
- **When it is reported:** the first successful read is the **baseline** and raises no event. After that, a count
  that **went up** or a text that **differs** raises one `bosun:watch-changed` event. A count that went down (you
  read the messages) is stored silently, and the next rise is measured from there.
  - Nothing is read when the visit isn't logged in.
  - A read that fails is recorded as `watch timeout`, `no number in the watched text` or `watch failed` (say, a
    selector that isn't valid) and leaves the stored value alone. Only a selector or regex that matches nothing
    counts as "no match". An agent taking the profile over mid-read aborts the visit, and nothing is recorded.
  - Changing `selector`, `text_regex`, `kind` or the `url` starts a new baseline; a new `label` doesn't. A visit
    still running for the old configuration records nothing.
- **What is stored:** only the value (a number, or at most 200 characters), when it was read and when it last
  changed, shown under `watch` in `keepalive_list`, plus `baseline` / `unchanged` / `changed` / `lower` per visit
  in `last`. Nothing else from the page.

The event uses its own MCPL feature set **`bosun.watch`**: tags `bosun:watch-changed`, `bosun:source=keepalive`,
`bosun:profile=<name>`; origin `{profile, label, old, new, url}`; text e.g. `Bosun watch "willhaben messages" on
profile "willhaben" changed: 43 -> 45 (https://…)`. Delivery and queueing work as for `bosun:needs-human`.

**Host recipe change:** a recipe without `enabledFeatureSets` for Bosun gets both feature sets. One that lists
`"bosun.handoff"` must add `"bosun.watch"`, or use `"bosun.*"`, otherwise watch events are not delivered (they wait
in the queue, up to 20 per tenant, until a connection grants the set):

```jsonc
"mcpServers": { "bosun": { "url": "wss://bosun.example/mcp", "transport": "websocket",
                           "enabledFeatureSets": ["bosun.handoff", "bosun.watch"] } }
```

Limits: a watch sees only what that one page shows (the visible text, or a selector's text, at visit time).
Between visits nothing is watched, so with `every_minutes: 30` a new message is reported about 15 minutes after it
arrived on average and up to about 40 minutes after (longer in quiet hours). Several changes between two visits make one event, carrying the latest value.

## Meetings (PoC)

> `FEATURES_MEETINGS=0` switches meetings off: the tools are not listed and their handlers are not wired, and nothing
> of the below runs — no recordings directory, no audio server. **That is the default in this fork** (upstream
> defaults to on), so everything below needs `FEATURES_MEETINGS=1`. Read the consent notes before using them.

Bosun can attend a **Google Meet** or a **Zoom** meeting as a notetaker, record its audio and leave.
- **Meet:** as an **unauthenticated guest**, or with a Bosun profile **signed in to a Google account**.
- **Zoom:** in Zoom's web client, with a Bosun profile **signed in to a Zoom account**. Zoom turns most anonymous
  browser guests away, so a guest join usually ends with `sign-in-required` or `captcha`.

Nothing is transcribed live. The agent gets the recording when the meeting ends and transcribes it afterwards with
whatever it likes. Teams is not supported yet. Each platform lives in one file under `src/meetings/platforms/`
(`meet.mjs`, `zoom.mjs`) behind a small interface, and the meeting flow around it is shared.

```jsonc
meeting_join({ "url": "https://meet.google.com/abc-defg-hij" })   // name, announce_text, max_wait_admit_min (10),
                                                                   // profile, engine, leave_on_optout (true)
meeting_join({ "url": "https://us02web.zoom.us/j/81234567890?pwd=…", "profile": "zoom" })
//  -> { "meeting_id": "m1a2b3c4d5e6", "platform": "zoom", "state": "waiting", "joined_as": "account", ... }
meeting_status({ "meeting_id": "m1a2b3c4d5e6" })   // joining | waiting | admitted | recording | ended, participants, recording_seconds
meeting_chat_read({ "meeting_id": "…", "since": 0 })      meeting_chat_send({ "meeting_id": "…", "text": "…" })
meeting_stop_recording({ "meeting_id": "…", "delete": true })   meeting_leave({ "meeting_id": "…" })
meeting_recording_delete({ "meeting_id": "…" })
```

**How a meeting runs:**

1. **Browser:** a fresh browser of its own, or `profile` (Chromium or patchright only; camoufox is refused).
   - Media permission prompts are accepted (`--use-fake-ui-for-media-stream`), but no fake devices are used: the
     microphone is a silent audio source and there is no camera.
   - The browser asks for an **English UI** (Meet: `hl=en`; Zoom: its language cookie; both: Accept-Language
     `en-US`). The account or region can still win, so Meet's texts and labels are also recognized in German,
     Slovak, Ukrainian and Russian, and Zoom's in German and Ukrainian (some Russian).
   - **Zoom links** (`zoom.us/j/<id>?pwd=…`, any `*.zoom.us` subdomain, webinar `/w/` and web client `/wc/`
     links) are rewritten to the web client, `https://app.zoom.us/wc/<id>/join?pwd=…`, so Zoom's "open the app"
     page doesn't come up. If it does anyway, Bosun clicks "Launch Meeting" and then "Join from your browser".
2. **Lobby:**
   - Microphone and camera must be **verifiably off** before joining. Bosun switches a device off and checks it,
     unless Meet shows the device doesn't exist ("Camera not found" / "Kamera nicht gefunden") and no control shows
     it on; then it already counts as off. If neither can be confirmed, Bosun does not join.
   - A guest types its name (default `Glassy (notetaker)`). A signed-in Meet profile has no name field and joins
     under the account's name, so `name` is ignored. Zoom fills in a signed-in account's name, and Bosun keeps it.
   - Tips and dialogs over the lobby ("Do you want people to hear you in the meeting?", "Got it", cookie banners,
     "This meeting is being recorded") are closed. Only buttons inside a dialog or banner are clicked.
   - Then **Ask to join** / **Join now** / **Teilnahme erbitten** (Meet) or **Join** (Zoom). A join button that
     is still disabled ("Getting ready...") is waited for, up to 25 s. Bosun then waits up to
     `max_wait_admit_min` for admission. `meeting_status` shows `joined_as`: `account` or `guest`.
   - **Meet, account already in the call on another device:** Meet offers "Switch here", which would drop the
     other device. Bosun picks **"Join here too"** (directly, or under "Other ways to join") and uses "Switch here"
     only when Meet offers nothing else.
3. **Not getting in:**
   - A denied request or no admission in time ends the meeting with a clear error.
   - **Google turning the guest away** ("You can't join this video call" / "Sie können nicht an diesem Videoanruf
     teilnehmen" after asking, with no waiting room seen) ends with reason `refused_by_google`.
   - That refusal comes with a hint: join with a signed-in profile, or from a residential IP. It is not a captcha,
     and `navigate` reports it as a refusal too.
   - Zoom ends a join early with `invalid-meeting` (wrong meeting ID or passcode, or a link without `?pwd=` for a
     meeting that has one; the link's `pwd` is an encrypted token and is never typed into a passcode field), `sign-in-required` (the host admits only signed-in users) or `captcha` (a visible
     challenge before joining). Being removed from Zoom's waiting room counts as `denied`.
4. Once admitted (Zoom: computer audio joined first, since without it nothing is heard, then microphone and
   camera checked off again), Bosun opens the chat and **posts the announcement first**. On Zoom the chat is set to
   Everyone first, and the announcement has to show up in the chat, not marked as private. If Zoom allows chat with
   the host only, or the message doesn't show up, Bosun leaves without recording. Only then does recording start. The
   default text is in English and German: *"Hi, I'm Glassy, an AI notetaker. I'm recording audio for notes. If you'd
   rather not be recorded, just say so here in chat (e.g. 'please don't record') and I'll stop and delete the
   recording."* With `MEETING_OWNER` set it says whose notetaker it is.
5. While in the call:
   - Every chat message from someone else is pushed to the agent as `bosun:meeting-chat`, with `meeting_id`,
     `sender` and `text`. `meeting_chat_read` returns them too.
   - Bosun leaves by itself when the meeting ends, when it is removed, or after **2 minutes alone**.
   - The agent can leave with `meeting_leave`.
   - On leaving, `bosun:meeting-ended` carries `meeting_id`, `reason`, `duration_s`, `bytes` and the `recording`:
     path, a `file://` URI and size. The payload also has it as an MCP `resource_link`.

**Signed-in profile.** Google turns away anonymous automated guests far more often than signed-in users, and Zoom
admits almost no anonymous browser guests at all.
- **Setup:** `session_open({ "profile": "google" })`, `navigate` to `https://accounts.google.com` (Zoom:
  `https://zoom.us/signin`), `request_human` so a person signs in, `session_close`.
- **Joining:** `meeting_join({ "url": "…", "profile": "google" })` or `{ …, "profile": "zoom" }`.
- **Engine:** the profile is opened with the engine it was last used with. It can't be in use by an agent session at
  the same time.
- **Keep it signed in.** Both sign-ins expire when nobody uses them. Give each profile a keepalive, for example
  `keepalive_set({ "profile": "google", "url": "https://myaccount.google.com/", "every_hours": 24 })` and
  `keepalive_set({ "profile": "zoom", "url": "https://zoom.us/profile", "every_hours": 24 })`, and look at
  `keepalive_list` before an important meeting. A `logged_out` result means a person has to sign in again.
- **Keepalive and meetings share the profile.** A meeting that starts while a keepalive visit has the profile open
  takes it over, and a visit that comes due during a meeting is skipped and runs at its next slot. With
  `MAX_SESSIONS=2`, a meeting and one agent session fill the service, so a keepalive visit then waits too.

The meeting runs in a session of its own, so it outlives the agent's connection. It counts against `MAX_SESSIONS`.
Events use the MCPL feature set **`bosun.meeting`** (tags `bosun:meeting-chat`, `bosun:meeting-optout`,
`bosun:meeting-ended`); host recipes that list `enabledFeatureSets` need to add it (or `bosun.*`).

**Consent.** Recording starts only after the announcement. No slash commands are needed: a plain-language request
not to be recorded is enough, in English, German, Ukrainian, Russian or Slovak (`please don't record`, `stop
recording`, `bitte nicht aufnehmen`, `не записуй`, `не записывай`, `nenahrávaj`, …).
- **What happens:** Bosun **stops the recording and deletes the file at once**, posts "Recording stopped and
  deleted. / Aufnahme gestoppt und gelöscht." in the chat, sends `bosun:meeting-optout` and leaves. With
  `leave_on_optout: false` it stays but never records again in that meeting.
- **The matcher is conservative.** "don't stop recording", "keep recording" or "record the next steps" do not
  trigger it.
- **Because it can miss phrasings,** every chat message also reaches the agent, which can call
  `meeting_stop_recording` itself.

**Recordings:** `BROWSER_DATA/recordings/<tenant>/<meeting_id>.ogg`, mode 0600, Ogg/Opus 16 kHz mono 24 kbps (about
11 MB per hour). They are deleted after `RECORDING_RETENTION_DAYS` (default 30), or with `meeting_recording_delete`.
Chat text is kept only in memory, for the last 50 meetings.

**Audio setup (Linux).** Each meeting gets a private PulseAudio server: its own `XDG_RUNTIME_DIR`, socket and
config, with two null sinks:
- **`bosun_out`:** the browser plays the meeting into it, and ffmpeg records its monitor.
- **`bosun_mic`:** its silent monitor is the browser's microphone.

Meetings never hear each other or the host's sound card. The image needs:

```sh
apt-get install -y pulseaudio pulseaudio-utils ffmpeg
```

Each meeting starts its own `pulseaudio` process, so PipeWire alone (`pipewire-pulse`) isn't enough. Both can be
installed side by side: the private servers don't touch the system one.

Meetings need a **headful** browser (headless Chromium plays no audio), so run the service under Xvfb without
`HEADLESS=1`. On macOS or without these packages, `meeting_join` refuses with the reason.
`docker/meeting-test.Dockerfile` builds an image that runs the audio test:
`docker run --rm --init -v "$PWD":/app -w /app bosun-meeting-test xvfb-run -a node --test test/meeting-audio.test.mjs`.

**Limits — what this can't do (yet):**

- **Guests need a host.** Someone in the meeting has to admit the bot. Meetings that don't allow guests, or that
  only admit people from the organisation, can't be joined.
- **Google reviews bot-like guests.** Join requests from automated browsers can land in a review queue or be refused
  outright ("You can't join this video call", reason `refused_by_google`). Datacenter IPs make this much more
  likely. A signed-in profile or a residential connection works best.
- **Meet's and Zoom's markup changes without notice.** Labels and texts are matched in several languages (English
  is requested), and the chat sender name is a best-effort guess. A change on Google's or Zoom's side breaks the
  join or the chat watch until `platforms/meet.mjs` or `platforms/zoom.mjs` is updated.
- **Tested against stand-ins.** The tests run against local stand-ins (`test/fakemeet.mjs`, `test/fakezoom.mjs`)
  built from how the real pages look. The signed-in Meet lobby (dialogs, "Getting ready...", "Join here too") and
  all of Zoom are new in 0.9.0 and have not had a live run yet. The Zoom chat watch depends most on Zoom's markup
  and is the part most likely to need a fix after the first live meeting.
- **Zoom may connect computer audio with the microphone on.** Bosun mutes it as soon as the control appears. The
  browser's microphone is a silent source, so only silence can go out in that moment, and the server has no camera.
- **An objection in the last second before Zoom leaves the page can be missed.** Bosun reads the chat once more
  when a meeting ends, but if Zoom has already navigated to its end page, messages it hadn't read yet are gone.
  The recording is then kept; the agent can still delete it with `meeting_recording_delete`.
- **One mixed audio track.** There is no speaker separation and no live transcript.
- **Consent is the operator's responsibility.** The announcement and the opt-out are a courtesy, not a legal basis.
  Check what applies where the participants are; some places require everyone's explicit consent before recording.

## Read-only tokens for subagents

Give helper agents (for example `claude -p` subprocesses) a browser without your logins, keepalive, meetings or
handoff: a tenant of their own with policy `ephemeral`.

```sh
BROWSER_TOKENS=me:<token>,swarm:<other token>
BROWSER_TOKEN_POLICIES=swarm=ephemeral       # tenants not named stay "full"
BROWSER_EPHEMERAL_MAX_SESSIONS=2             # default
```

With policy `ephemeral` the server enforces, not just hides:

- `tools/list` shows only `session_open`, `session_close`, `navigate`, `read`, `click`, `type`, `select`, `press`,
  `back`, `wait_for`, `screenshot` and `sessions`. Any other tool answers `not allowed for this token`, whatever its
  arguments; its handler is never wired up for the connection.
- `session_open` refuses `profile` ("profiles are not allowed for this token") and any engine but the default
  (`ENGINE`, which startup checked, so a session never installs a browser). The session manager enforces both for
  the tenant as well, and refuses meeting browsers.
- The tenant has `BROWSER_EPHEMERAL_MAX_SESSIONS` sessions at most, across all its connections. Sessions belong to
  the connection and close when it closes (or after `IDLE_TIMEOUT_SEC`).
- Nothing is written to `BROWSER_DATA`: screenshots are returned but never saved, even with `SAVE_SHOTS=1`. Ephemeral
  sessions use temporary browser profiles that are deleted on close; Playwright keeps downloads in its own temporary
  directory and deletes them with the session. `upload_create` and `upload` are refused, and so is an upload PUT
  that carries this token.
- No MCPL push events.

A policy only narrows what the token can do; the tenant is still separate from yours, so it never sees your profiles
anyway. Egress is not narrowed: block private networks around the service (see [Security notes](#security-notes)).

### stdio bridge

MCP clients that only start stdio servers (such as `claude --mcp-config`) use `bosun-mcp-stdio` (this package's
second bin). It reads `BOSUN_URL` (`ws://` or `wss://`) and `BOSUN_TOKEN`, sends the token as
`Authorization: Bearer` (never in the URL, never printed), and pipes newline-delimited JSON-RPC between
stdin/stdout and the WebSocket, one message per frame.

```json
{ "mcpServers": { "bosun": { "command": "bosun-mcp-stdio",
  "env": { "BOSUN_URL": "ws://127.0.0.1:7360", "BOSUN_TOKEN": "<swarm token>" } } } }
```

Records are split on LF only (CRLF is accepted); a record that is not JSON or is over 2 MiB is dropped with a line
on stderr. The opening handshake times out after 15 s. Exit codes: `0` stdin ended, `1` connection failed or lost,
`2` bad configuration (missing variable, a non-ws URL, credentials in the URL), `3` token refused. The bridge needs
only Node and the `ws` package.

## Chromium sandbox

The browser parses untrusted web content, so it runs with **Chromium's own sandbox** (`chromiumSandbox: true`,
which is what `CHROMIUM_SANDBOX=1`, the default, means). Playwright's default is `--no-sandbox`; Bosun does not use
it (0.7.0 and earlier did).

The sandbox needs something from the host, and startup checks it: Bosun starts the browser once, closes it again,
and **refuses to run** if that fails, printing what to do. On Linux, one of these has to be true:

1. unprivileged user namespaces are allowed —
   `echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-apparmor-userns.conf && sudo sysctl --system`
   (Ubuntu 23.10+ restricts them through AppArmor), or
2. an AppArmor profile grants `userns` to the browser binary, or
3. Chromium's setuid helper next to the browser is root-owned and mode 4755, with `CHROME_DEVEL_SANDBOX` pointing at
   it — and then the service must **not** run with `NoNewPrivileges`.

[docs/DEPLOY-SYSTEMD.md](docs/DEPLOY-SYSTEMD.md) has the commands for each. A container or CI box usually allows
none of them; there, `CHROMIUM_SANDBOX=0` is the explicit way out, and the service says so on every start:

```
bosun: WARNING — CHROMIUM_SANDBOX=0: the browser runs without its own sandbox, …
```

Check what is actually running, not just the setting: `ps -eo args | grep -- --type=renderer` must show no
`--no-sandbox`.

## Per-tenant host allowlist

Keep a tenant to the hosts it has business with — so a page that says "now open this other URL" gets nowhere, and
neither does a redirect, an iframe, a `fetch`, a WebSocket or anything a worker starts:

```sh
BROWSER_TENANT_ALLOW='ops=*.example.org,example.org,127.0.0.1:4848; swarm=*.example.org'
```

Entries are separated by `;` (or newlines), hosts within an entry by `,`. A host pattern is:

| pattern | matches |
|---|---|
| `example.org` | exactly that host, on any port |
| `*.example.org` | any subdomain, on any port — **not** the apex (list it separately) |
| `example.org:8443`, `127.0.0.1:4848`, `[::1]:4848` | that host on that port only |
| `*` | every host (the escape hatch) |

### How it is enforced

A tenant that is named gets **its own forward proxy inside the service** (`src/proxy.mjs`, on loopback, with a
random password of its own), and **each of its sessions runs in a browser of its own** (a temporary profile,
removed with the session), launched with that proxy as its only way out
(`--proxy-bypass-list=<-loopback>`, so not even loopback is exempt; QUIC off and WebRTC's non-proxied UDP off, so
nothing can go around it; Chromium does not fall back to a direct connection when a proxy refuses). Full Chromium
(headful, `patchright`) ignores the WebRTC flag, so the browser's profile also gets the `webrtc.ip_handling_policy`
preference before every proxied launch (a persistent profile loses it again on an unproxied launch, if Bosun set
it).
`camoufox` gets the same as Firefox preferences: loopback through the proxy too
(`network.proxy.allow_hijacking_localhost`), WebRTC through the proxy only, no HTTP/3, no DNS prefetching. Those
settings belong to that browser alone — tenants without an allowlist share a browser launched exactly the way upstream
launches it, so one tenant's allowlist never changes another tenant's networking. Every
connection the browser wants — a navigation, each hop of a redirect, a subresource, XHR, a WebSocket from the page
**or from a worker**, a service-worker fetch, a prefetch — arrives at the proxy as a request or a `CONNECT` and is
checked against the allowlist before a byte leaves the host:

- A denied connection is never made. The browser gets `403` from the proxy, so a denied navigation leaves the tab
  on that URL with the proxy's one-line reason and `navigate` reports `status: 403` and `refused: "host allowlist"`.
  An `https://` hop is refused at `CONNECT`, which fails the navigation in the browser; `navigate` then answers
  "navigation refused by the host allowlist of this token: <host>:<port>".
- Denials are logged as `bosun: tenant <t>: blocked <host>:<port> — <reason>`: host and port, never a path or a
  query. One line per target per tenant (a repeat is counted, not logged again).
- **DNS is resolved by the proxy, once**, and the connection goes to that address, so the address a decision was
  made about is the address that gets used — a name cannot change where it points between the check and the
  connection. A name that resolves into loopback or a private range is only followed if the allowlist names that
  address as well, so `127.0.0.1:4848` has to be in the list for a name that resolves there.
- **Nothing is intercepted.** The proxy tunnels TLS (`CONNECT`) and streams plain HTTP; it never terminates TLS,
  rewrites a response or buffers a body. The browser's own rules therefore all still hold: a redirect to another
  allowed host loads **as that host**, with its own origin, storage and cookies, and the tab shows the URL it
  really ended up on.
- `navigate` and `keepalive_set` also check the allowlist up front, so the agent gets a clear refusal instead of a
  403 page, and `navigate`'s tool description names the hosts it may reach.

A tenant that is not named is unrestricted: no proxy, nothing intercepted, and a browser with upstream's own flags
— exactly upstream behaviour, whatever another tenant's allowlist says.

### What it does not do

- The allowlist is host and port, and a `CONNECT` tunnel is not inspected, so an entry without a port allows a
  tunnel to **any** port on that host. Prefer `host:port` entries.
- It is not a URL filter: a path or a query is never looked at (and never logged).
- Hosts you allow can talk to each other with the browser's normal rules; the allowlist decides reachability, not
  mutual trust. Keep it to the hosts a tenant needs.
- Plain `http://` goes through the proxy as HTTP/1.1 (no h2c, no QUIC); `https://` is end-to-end inside the tunnel.
- A firewall is still the outer boundary: the proxy is a per-tenant rule inside the service, not a replacement for
  network egress policy (see [Security notes](#security-notes) and
  [docs/SECURITY-REVIEW-0.7.0.md](docs/SECURITY-REVIEW-0.7.0.md)).

## Security notes

- One service is one trust domain per **tenant** (token): a tenant's connections share its persistent profiles;
  sessions are private to the connection. For hard isolation run one process (and data dir) per tenant.
- Web content is untrusted (prompt injection). Run the service where it **can't reach private networks**
  (block 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 egress) — otherwise a page can steer it at your LAN.
  The `http(s)`-only check on `navigate` does not replace that boundary. Run it as a user that can't read secrets.
- Live-view links are **bearer tokens for the whole handoff** (up to `HANDOFF_TTL_SEC`): anyone holding the link can
  open the live view whenever nobody else is connected, or 5 s after the connected viewer went silent. Serve them on
  a private network (VPN/mesh) or behind TLS, send them over a private channel, and press Done or Give up when
  finished — that revokes the link for good (no replay afterwards). A connected, responsive viewer can't be pushed
  out by a second one.
- No rate limiting yet beyond the connection, in-flight and session caps.
- A named tenant can be kept to a list of hosts, enforced by a per-tenant forward proxy that is the browser's only
  way out (see [Per-tenant host allowlist](#per-tenant-host-allowlist)). That narrows what the agent, the page, its
  workers and its service workers can reach; it does not replace the egress boundary above.
- The browser runs with its own sandbox (see [Chromium sandbox](#chromium-sandbox)). Without it (0.7.0 and earlier,
  or `CHROMIUM_SANDBOX=0`) Chromium runs with `--no-sandbox`: then a renderer compromise is directly on the service user,
  which is where the profiles and the service's environment (tokens included) are.
- Downloads are off by default (`DOWNLOADS=0`), and bounded by a disk budget when enabled, so a page cannot fill
  the volume.
- Uploads are written to `BROWSER_DATA/uploads` (on the data volume, not a RAM-backed `/tmp`) under a per-file cap
  and a per-tenant quota, and deleted after use, after an hour and at every start. Once a file is in a page, the page
  can send it anywhere it can reach: upload only what you would hand that site.
- Credential masking around a handoff covers credential **fields** — their value, and values Bosun saw in them. A
  page that copies what the human typed into ordinary text, or into something it reads later, is not masked on
  **any** engine, and on `chromium` a page can also neutralize the masking helpers outright (they run in its own
  JavaScript world; `patchright` uses an isolated one, which stops that technique and nothing more). Treat the page
  where a credential is typed as trusted, or don't type it there. Details, probes and the standing test:
  [docs/SECURITY-REVIEW-0.7.0.md](docs/SECURITY-REVIEW-0.7.0.md) (finding H2).

## Roadmap

M1 meetings beyond the PoC (Teams, speaker separation), tenant quotas/audit log, mobile viewport for handoff, more push events (handoff done/timeout) · M2 vault (`fill_credential`), downloads as content
references, watching pages outside keepalive visits · M3 macros.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

**Status: early preview (0.x).** APIs, tool names and config may change without notice.
