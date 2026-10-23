# This fork: what it changes, and a review of the features upstream added in 0.9.0 and 0.10.0

Upstream is [The-Glassy/bosun-browser](https://github.com/The-Glassy/bosun-browser). This file holds the two
things that are this fork's own: the small set of defaults it changes, and the reviews it does of upstream code
before running it. The review of 0.7.0 that started this fork, and the record of what 0.8.0 changed in response,
are upstream's own document now: [SECURITY-REVIEW-0.7.0.md](SECURITY-REVIEW-0.7.0.md).

## 1. Where this fork stands

| | |
|---|---|
| Upstream merged | our hardening as **0.8.0** (`cb4906a`, PR #9), adapting it |
| Then added | **0.9.0** signed-in Google Meet / Zoom joins (#11), **0.10.0** file uploads into pages (#12) |
| This fork's `main` | upstream `main` (`39ee518`, 0.10.0) + the delta in §2, and nothing else |

The 0.8.0 adaptation was taken **whole**: it is a superset of what this fork had, and it lost none of the security
properties. Where it differs it is stronger — read side by side (`git diff 7837f1f cb4906a -- src/`):

| Where | What upstream changed about our patch | Verdict |
|---|---|---|
| `src/allow.mjs` | a host pattern is normalized through `new URL` before it is compared, so `0:0:0:0:0:0:0:1`, `::ffff:127.0.0.1` and `127.1` match the form a URL gives the same host | stronger: closes a way to write a pattern that never matches |
| `src/proxy.mjs` | `isPrivateAddress` also covers `198.18/15`, `192.0.0/24`, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16`; `close()` ends open tunnels under a deadline; every client and upstream socket is tracked; `deniedSince(t)` keeps the last denials so `navigate` can tell a refusal from a network error; a connection that closed or a proxy closing while DNS resolved is handled | stronger |
| `src/sessions.mjs` | a proxied tenant no longer gets one browser **per tenant** but one **per session**, on a temp profile of its own; a download that lands after its session closed is not counted; a download cancelled too late is deleted | stronger: more isolation, not less |
| `src/engines.mjs` | a persistent Chromium profile ignores `--force-webrtc-ip-handling-policy` (only the headless shell honours it), so a proxied launch also writes `webrtc.ip_handling_policy` into the profile and takes it back out again when the allowlist goes away; a proxied Firefox gets `network.proxy.allow_hijacking_localhost`, `media.peerconnection.ice.proxy_only`, no HTTP/3, no DNS prefetch | **fixes two holes this fork had**: full Chromium and camoufox could still open non-proxied UDP / direct loopback |
| `src/bosun.mjs` | the one Playwright Firefox driver assertion that no caller can catch is logged instead of ending the service; everything else still ends the process | neutral, narrow |
| `src/tools.mjs` | `navigate` reports a refusal that happened inside a CONNECT tunnel as the allowlist refusing, naming host and port only | stronger: the agent gets a clear reason instead of a network error |

So this fork keeps **nothing** of its own in `src/` except §2. There is no security property to propose back
upstream from the 0.8.0 merge: upstream already has all of them.

## 2. The fork delta

Two defaults, and the documentation that states them. Everything else is upstream's.

| | upstream default | here | why |
|---|---|---|---|
| `FEATURES_MEETINGS` | `1` | **`0`** | meetings are not used here. They add a recording-consent surface, a PulseAudio server per meeting with `auth-anonymous=1` (0.7.0 review, L4), `ffmpeg`, and — since 0.9.0 — a browser driving a signed-in Google or Zoom account unattended (§4). A default that fails safe also covers an `EnvironmentFile` that lost the line. |
| `FEATURES_ENGINES` | all three | **`chromium`** | `patchright` and `camoufox` are not installed here (`npm ci --omit=optional`), and engine choice is a much weaker credential boundary than it looks (0.7.0 review, H2). |

`FEATURES_UPLOADS` stays **on**, as upstream has it: §3 found the confinement sound. A deployment that has no
agent uploading files should still set `FEATURES_UPLOADS=0` — `deploy/bosun.env.example` says so.

Files: `src/config.mjs` (the two defaults), `test/features.test.mjs` and `test/helpers.mjs` (the assertions, and
the suites that exercise upstream's feature surface), `README.md`, `docs/DEPLOY-SYSTEMD.md`,
`deploy/bosun.env.example` (so the documented default is the real one), and this file.

## 3. Review: file uploads (0.10.0, `src/uploads.mjs`, `upload_create` / `upload`)

**Scope.** Which local paths an agent can get into a page; who may PUT bytes; the caps and the quota; what the
page can see; deletion. Not reviewed: Playwright's `setInputFiles` / file-chooser internals.

**Method.** Read of `src/uploads.mjs`, the `upload_create` / `upload` tools and `src/wsserver.mjs`, plus live
probes against the running service over its real MCP port (below). Upstream's own `test/uploads.test.mjs` (13
cases) covers the caps, the quota, cross-tenant lookups, expiry, the 200 MB stream and `FEATURES_UPLOADS=0`.

**Verdict.** The confinement the deployment needs holds: **an agent names a file name, never a path.** Nothing
found that makes uploads unsafe to run here: one MEDIUM, about the PUT URL, and one LOW, about the drop fallback
— neither about where the bytes may come from.

| # | Severity | Finding | Status |
|---|---|---|---|
| U1 | INFO | an agent cannot name a host path: only `BROWSER_DATA/uploads/<tenant>/<file_id>/<name>` | verified by probe |
| U2 | MEDIUM | the one-time PUT URL carries its credential in the query string, and its scheme/host come from the `Host` header unless `UPLOAD_BASE_URL` is set — behind the TLS proxy this deployment uses, the agent is handed a cleartext `http://` URL with the secret in it | deploy guidance; `UPLOAD_BASE_URL` added to the deploy checklist; upstream PR candidate |
| U3 | LOW | `method: auto` falling through to `drop` puts the files into a real `<input type=file>` in the page's own DOM, so a page that is not a drop zone can still read them before `accepted: false` is reported | documented |
| U4 | INFO | caps, quota and counters are enforced before and during the stream, and released correctly | verified |
| U5 | INFO | `srv.requestTimeout = 0` does **not** open a slow-body window on the MCP port | verified by probe |
| U6 | INFO | a `file_id` of another tenant is indistinguishable from one that never existed; read-only (`ephemeral`) tokens are refused the tools **and** the PUT | verified by probe |

### U1 — INFO: which local paths can an agent upload?

Only files that arrived through `upload_create`. The agent supplies `filename`, which `safeName`
(`src/uploads.mjs:23-28`) reduces to a single path segment — last segment after `/` and `\`, control characters
stripped, trimmed, at most 200 bytes, and `.`, `..` and the empty string refused. The directory is
`BROWSER_DATA/uploads/<tenant>/<file_id>/`, with `<tenant>` taken from the authenticated token and `<file_id>`
from `crypto.randomBytes(8)`. The file is opened `wx` (so nothing is overwritten and a symlink in the way fails),
mode `0600`, under a `0700` directory. `upload` then takes `file_id`s and hands Playwright the **server-side**
path; the agent never passes a path at any point.

Probed against the running service, headless Chromium, engine `chromium`:

```
--- filenames an agent may ask for ---
  "../../../../tmp/probe-escape"     -> stored as "probe-escape"
  "..\\..\\..\\probe-escape-win"     -> stored as "probe-escape-win"
  "/etc/cron.d/probe-escape"         -> stored as "probe-escape"
  "....//....//probe-esc"            -> stored as "probe-esc"
  "."                                -> REFUSED (filename must name a file (e.g. "report.pdf"))
  ".."                               -> REFUSED (filename must name a file (e.g. "report.pdf"))
  "dir/"                             -> REFUSED (filename must name a file (e.g. "report.pdf"))
  "ok.txt"                           -> stored as "ok.txt"
--- everything that is on disk under BROWSER_DATA/uploads ---
  uploads/alice/f01bc0f2547d0f000/ok.txt            mode 600
  uploads/alice/f01fe8719ed97ce05/probe-escape      mode 600
  uploads/alice/f0b8259bd7658e950/probe-escape-win  mode 600
  uploads/alice/f55b8d8ffc5cf0712/probe-esc         mode 600
  uploads/ itself: mode 700
--- outside BROWSER_DATA ---
  new /tmp/*probe-escape*: 0
  /etc/cron.d/probe-escape exists: false
--- the page gets the file from disk; the agent never names the path ---
  upload -> ["report.pdf"]
  the page received: {"size":200,"names":["report.pdf"]}
--- the file is gone when the session that used it closes ---
  on disk now: []
```

Size: `UPLOAD_MAX_BYTES` (300 MB) per file and `UPLOAD_TENANT_QUOTA_BYTES` (1 GB) per tenant, checked against
`Content-Length` before a byte is read and again on every chunk, so a body without a `Content-Length` is bounded
too; 50 files per tenant and 500 in all; 4 PUTs streaming at once per tenant and 16 in all. Files go when the
session that used them closes, an hour after they arrived (`UPLOAD_TTL_SEC`), and at every service start.

### U2 — MEDIUM: the PUT URL is a credential in a query string, and its scheme defaults to `http://`

`upload_create` returns a URL whose `?t=` is the only thing the PUT needs (`src/uploads.mjs:156-161`): no tenant
token, no session. That is deliberate — it is what makes `curl -T` from the agent's own shell work — and it is
narrow: one file, one use, 15 minutes, write-only. But the URL is built from the `Host` header the MCP client
connected with, always as `http://`, unless `UPLOAD_BASE_URL` is set (`src/wsserver.mjs:102-109`):

```
no UPLOAD_BASE_URL:
  put_url = http://127.0.0.1:34917/upload/f70f80ac4ba072fa2?t=jLLck0juZOKtk_faGStKJZzSo1_a9mMI
  curl    = curl -sS --fail-with-body -T 'x.bin' 'http://127.0.0.1:34917/upload/...?t=...'
UPLOAD_BASE_URL=https://bosun.example.ts.net/mcp:
  put_url = https://bosun.example.ts.net/mcp/upload/f4846b728637d4122?t=vuTzdGi6s9funC1Rqg0YLljv7F_nl8x_
a client that sends Host: someone-elses-name.example:443 is handed:
  put_url = http://someone-elses-name.example:443/upload/fb077ac06258163c7?t=Le9hRn6d0uuSfBGLfa_y8iS420wYDdi4
```

The `Host` echo is only ever shown back to the client that sent it, so it is not a way to aim another tenant's
upload anywhere. What matters is the default: this deployment publishes MCP behind TLS on a path
(`tailscale serve --https=443 --set-path=/mcp`, `docs/DEPLOY-SYSTEMD.md` §4), so without `UPLOAD_BASE_URL` the
agent is handed `http://<node>.ts.net:443/upload/<id>?t=<secret>` — the wrong scheme, the wrong path, and a
bearer secret that a client following it would send in cleartext. Secondary: in a query string the secret lands in
the access log of any proxy in front, and the suggested `curl` line puts it in a process argument list, which on
Linux is readable from `/proc/<pid>/cmdline` by anything running as the same user.

Impact if it leaks: whoever has the URL within its 15 minutes can replace the bytes of that one file before the
agent puts it into a page. No read access to anything.

**In this fork:** `UPLOAD_BASE_URL` is in the pre-flight checklist of `docs/DEPLOY-SYSTEMD.md` §7 (it was only in
the prose of §4). Where the host is shared with other local users, prefer the header form that
`src/uploads.mjs:141-143` also accepts — `PUT /upload/<file_id>` with the tenant's own token in
`Authorization: Bearer` — over the `?t=` line. Upstream PR candidate: emit the base URL's scheme (and warn once at
start when `UPLOAD_BASE_URL` is unset and the `Host` is not a loopback address), and offer the
`Authorization`-header `curl` line as well.

Note that the query-string token the 0.7.0 review found as L1 is *not* accepted here: the PUT reads
`Authorization` only (`tokenFromRequest(req, new URLSearchParams())`, `src/wsserver.mjs:65-68`).

### U3 — LOW: the drop fallback shows the files to a page that is not a drop zone

With `method` unset, `upload` tries the element as a file input, then clicks it and waits 5 s for a file chooser,
and if neither happens **drops** the files on it (`src/tools.mjs:85-176`). The drop works by creating a real
hidden `<input type=file>` in the page's own DOM, filling it, and dispatching `DragEvent`s with its `files` in a
`DataTransfer`. For as long as that input exists the page's own scripts can find it and read the bytes
(`FileReader`), whether or not anything there handles the drop — and `accepted: false`, which says nothing on the
page took the drop, is only reported afterwards. On `camoufox` the dispatch is additionally done from a `<script>`
element in the page's main world, because Firefox hides files an isolated world put into a `DataTransfer`.

This is inherent to simulating drag-and-drop, and the files were being offered to that page anyway. It matters
only when the agent aimed at the wrong element: pass `method: 'input'` or `method: 'chooser'` when the page must
not get the file unless it really has an upload control. README › Uploading files states the best-effort nature;
it does not state this.

### U4/U5/U6 — INFO, verified

- **Caps and accounting.** Every check that matters runs synchronously between `this.files.get(id)` and
  `f.state = 'receiving'`, so the "URL is spent" transition is atomic and a second concurrent PUT gets `404`. Bytes
  are added to the tenant's usage per chunk and released when the directory is actually gone; a removal that fails
  keeps the quota and the slot until a sweep retries it (upstream tests this).
- **`srv.requestTimeout = 0`** (`src/wsserver.mjs:78`) is the most suspicious line in 0.10.0: it removes Node's
  5-minute total-request deadline for **every** request on the MCP port, not only an upload PUT. Probed: it does
  not open a slow-body window, because every other handler answers and closes rather than waiting for a body the
  client never sends. Two sockets sending request headers with `Content-Length: 1000` and then nothing:

  ```
  control server: requestTimeout = 300000 headersTimeout = 60000
    t+ 30s  bosun MCP port   closed after 6s  reply="HTTP/1.1 426 Upgrade Required"
    t+ 30s  stock Node http  closed after 6s  reply="HTTP/1.1 200 OK"
  ```

  `headersTimeout` (60 s) is untouched, and an accepted PUT is bounded by `uploads.mjs` itself: 60 s idle, 1 h
  total, 4 per tenant and 16 in all.
- **Tenants and read-only tokens.** `get(tenant, id)` answers "no uploaded file" for never-existed, another
  tenant's and already-deleted alike, so ids cannot be probed. `upload_create` / `upload` are not in
  `EPHEMERAL_TOOLS`, so an `ephemeral` token gets the refusing stub, and `uploads.handle` refuses a PUT for such a
  tenant even with a valid secret.
- **Where the bytes go next.** Once a file is in a page, the page can send it anywhere it can reach — which, for a
  tenant with `BROWSER_TENANT_ALLOW`, is the allowlist and nothing else.

## 4. Review: signed-in meeting joins (0.9.0, Google Meet and Zoom)

Meetings are **off** in this fork (§2), so this review answers two questions only: does the switch really disable
them, and — if a deployment turns them on — what is new in 0.9.0 that it should know.

**Verdict.** The switch disables everything, verified end to end. `meeting_join` cannot be turned into an
unrestricted navigation: both URL parsers are strict. Two things a deployment that enables meetings should know
(Z2, Z3).

| # | Severity | Finding | Status |
|---|---|---|---|
| Z1 | INFO | `FEATURES_MEETINGS=0` leaves no meeting tool, handler, directory or audio server | verified by probe |
| Z2 | MEDIUM | a signed-in join drives a browser holding a real Google/Zoom session unattended, while the meeting's chat reaches the agent as text | inherent; use a dedicated account, not a person's own |
| Z3 | LOW | `meeting_join` is the one navigation that does not check the tenant's host allowlist up front, so a tenant whose list omits `meet.google.com` / `app.zoom.us` gets a page-load error instead of a clear refusal | enforcement still holds at the proxy; upstream PR candidate |
| Z4 | INFO | neither parser can be made to reach another host; microphone and camera are granted to Meet/Zoom origins only | verified by probe |
| Z5 | INFO | the Zoom link's `pwd` / `tk` stay inside the tenant's own `meeting_status`; they are not logged and not pushed as events | verified by reading |

### Z1 — INFO: the switch really disables them

`cfg.features.meetings` gates the one `new Meetings(...)` (`src/bosun.mjs:28`), and `manager.meetings` gates the
whole tool block (`src/tools.mjs:432`), so the tools are **never registered** — not even as refusing stubs. The
recordings directory is created in the `Meetings` constructor and the PulseAudio server only from `join`, so
neither exists. Probed with nothing but tokens and paths in the environment, so the fork's own defaults apply:

```
--- loadConfig with nothing set: this fork's own defaults ---
  features.meetings = false | features.uploads = true | engines = ["chromium"]
  FEATURES_MEETINGS=1 still turns it on: true
--- the running service, FEATURES_MEETINGS unset ---
  svc.meetings        = null | manager.meetings = undefined
  recordings dir      = absent
  BROWSER_DATA holds  = profiles uploads
  meeting tools listed= none
  meeting_join             -> refused: MCP error -32602: Tool meeting_join not found
  … all seven refused the same way …
  session_open engine enum = ["chromium"]
  session_open{engine:patchright} -> refused: Input validation error
  session_open{engine:camoufox}   -> refused: Input validation error
```

### Z2 — MEDIUM: what a signed-in join means

0.9.0's point is to get past the lobby by joining **as an account**: `meeting_join({profile})` reuses a Bosun
profile a human signed in to Google or Zoom through a handoff. For the length of the meeting, a browser holding
that account's live session is driven by an agent, unattended, on a page full of other people's text — and the
chat reaches the agent as ordinary text, which is the 0.7.0 review's L5 (prompt injection) with a wider audience:
anyone in the meeting can write into it. Bosun's own chat handling is defensive (an opt-out stops and deletes the
recording; the announcement goes out before recording starts; state is read from dialogs, not from captions, so a
caption saying "meeting ended" changes nothing), but the account is as exposed as whatever the agent can be talked
into doing with that browser.

If meetings are enabled: give them a **dedicated account** with access to nothing else, not a person's own, and
keep the profile out of every other tenant (profiles are per-tenant already).

### Z3 — LOW: `meeting_join` does not check the allowlist up front

`navigate` and `keepalive_set` call `manager.checkAllowed` and refuse with the host and port. `Meetings.join`
(`src/meetings/index.mjs:134-176`) checks the scheme, the platform, the profile, the engine, audio and the session
caps, but never the tenant's allowlist. Enforcement is unaffected — the tenant's browser reaches the network only
through its proxy, so the join simply fails — but it fails as "could not load the meeting page", which sends the
operator looking in the wrong place. Upstream PR candidate: one `manager.checkAllowed(tenant, target)` next to the
platform check.

### Z4 — INFO: `meeting_join` cannot reach another host

It is worth checking, because this is the one tool that navigates without the up-front allowlist check (Z3).
Probed with meetings on:

```
  https://meet.google.com/abc-defg-hij       -> refused: pulseaudio is not installed (apt-get install pulseaudio …
  https://zoom.us/j/123456789?pwd=abc        -> refused: pulseaudio is not installed (apt-get install pulseaudio …
  https://sub.zoom.us/w/987654321?pwd=x&tk=y -> refused: pulseaudio is not installed (apt-get install pulseaudio …
  http://169.254.169.254/latest/meta-data/   -> refused: only Google Meet (https://meet.google.com/abc-defg-hij) …
  http://127.0.0.1:22/                       -> refused: only Google Meet (https://meet.google.com/abc-defg-hij) …
  file:///etc/passwd                         -> refused: only http:// and https:// URLs are allowed (got file:)
  https://meet.google.com.evil.test/abc-…    -> refused: only Google Meet (https://meet.google.com/abc-defg-hij) …
  https://evil.test/meet.google.com/abc-…    -> refused: only Google Meet (https://meet.google.com/abc-defg-hij) …
  https://meet.google.com@evil.test/abc-…    -> refused: only Google Meet (https://meet.google.com/abc-defg-hij) …
  http://zoom.us/j/123456789                 -> refused: only Google Meet (https://meet.google.com/abc-defg-hij) …
  https://zoom.us:8443/j/123456789           -> refused: only Google Meet (https://meet.google.com/abc-defg-hij) …
  https://zoom.us@evil.test/j/123456789      -> refused: only Google Meet (https://meet.google.com/abc-defg-hij) …
--- the URL parsers, directly ---
  meet.matches(https://meet.google.com/abc-defg-hij)           = true
  meet.matches(https://meet.google.com.evil.test/abc-defg-hij) = false
  meet.matches(http://meet.google.com/abc-defg-hij)            = false
  parseZoomUrl(https://zoom.us/j/123456789?pwd=p)              = {"id":"123456789","pwd":"p"}
  parseZoomUrl(https://zoom.us:8443/j/123456789)               = null
  parseZoomUrl(https://zoom.us@evil.test/j/123456789)          = null
  parseZoomUrl(https://notzoom.us/j/123456789)                 = null
  parseZoomUrl(https://a.b.zoom.us/wc/123456789/join)          = {"id":"123456789"}
```

(Lines are cut at the right; the gate log has them whole.) So `http://` instead of `https://`, a port, userinfo
and a lookalike host are all "not a meeting link" — and "pulseaudio is not installed" is the *next* check after
the platform one, which is how you can tell a genuine meeting URL got past it and nothing else did. `grantPermissions(['microphone', 'camera'])` is called for the link's own origin plus
`https://app.zoom.us` only (`src/meetings/index.mjs:195-197`, `zoom.mjs:131`), both constrained by the parsers.

## 5. The hardening still holds after the merge

Re-verified at this commit, with the probes the 0.7.0 review used, on the real service. The blocks below are cut
at the right and have ephemeral ports written as `<port>`; the gate logs carry them whole.

- **tests** — `npm test` headless: see the gate log. `test/allowlist-proxy.test.mjs` (every redirect code, a page
  WebSocket, a Blob-worker WebSocket, a subresource redirect, a cross-origin redirect that must load as its own
  origin, a name that resolves into loopback), `test/allowlist.test.mjs`, `test/transport-isolation.test.mjs`,
  `test/downloads.test.mjs`, `test/features.test.mjs` (including "with the sandbox on, the service either runs
  sandboxed or refuses to start").
- **the sandbox fails loudly** — this host allows no usable Chromium sandbox, which is exactly the case that must
  not fall back. `CHROMIUM_SANDBOX=1` (the default): the service **refuses to start**, naming the three host
  configurations that would work and the one explicit way out.

  ```
  loadConfig({}).chromiumSandbox = true
  engine chromium: Chromium could not start with its own sandbox. One of these has to be true on this host:
    1. unprivileged user namespaces are allowed: …
    2. or an AppArmor profile grants "userns" to the browser binary …
    3. or the setuid helper next to the browser is root-owned and mode 4755 …
  Running the browser unsandboxed is a deliberate choice: set CHROMIUM_SANDBOX=0 (logged at every start).
  ```

- **the allowlist proxy** — a tenant with `BROWSER_TENANT_ALLOW` reaches the allowed host and nothing else;
  a request the **page** starts to a host off the list never arrives there; a tenant without an allowlist is
  untouched. Denials name `host:port` and a reason, never a path or a query.

  ```
  alice -> the allowed host: Probe
  alice -> http://127.0.0.1:<port>/                 refused: 127.0.0.1:<port> is not in the host allowlist of …
  alice -> http://169.254.169.254/latest/meta-data/ refused: 169.254.169.254 is not in the host allowlist of …
  alice -> http://[::1]:80/                         refused: [::1] is not in the host allowlist of this token …
  alice -> http://10.0.0.5/                         refused: 10.0.0.5 is not in the host allowlist of this to…
  a fetch the PAGE starts to a host off the list: the other server was reached 0 time(s)
  bob (no allowlist) -> the same host: Other (reached it 1 time(s))
  denials the proxy logged:
     bosun: tenant alice: blocked 127.0.0.1:<port> — not in the host allowlist
  any denial carrying a path or a query? false
  ```

- **the per-tenant browser** — 0.8.0 goes further than this fork did: a browser per *session* of a proxied
  tenant, on its own temp profile, with the proxy, `--disable-quic`, the WebRTC flag **and** the profile
  preference full Chromium reads instead of the flag. A tenant without an allowlist still shares the one browser
  upstream launches, with upstream's flags.

  ```
  alice session: shared browser = null | own profile dir = true
  bob   session: shared browser = yes (the one shared browser) | own profile dir = false
  two alice sessions share a browser? no — a browser each
  browsers this probe launched:
    proxy=true  quic-off=true  webrtc=true  nosandbox=true  profile=$DATA/tmp/chromium-<hex>
    proxy=false quic-off=false webrtc=false nosandbox=true  profile=/tmp/playwright_chromiumdev_profile-<x>
    proxy=true  quic-off=true  webrtc=true  nosandbox=true  profile=$DATA/tmp/chromium-<hex>
  alice profile webrtc.ip_handling_policy: disable_non_proxied_udp
  ```

  (`nosandbox=true` on all three because this part of the probe runs with `CHROMIUM_SANDBOX=0`, as the test suite
  does on a host that cannot sandbox at all — what the default does here is the block above.)

- **the download budget** — `DOWNLOADS=0` by default; a page that starts one writes nothing.

  ```
  loadConfig({}).downloads = false
  with DOWNLOADS=0 — files under BROWSER_DATA/downloads: [] | session dlBytes = 0
  ```

## 6. Upstream PR candidates

1. **U2** — build the PUT URL with the scheme the deployment really uses: warn once at start when
   `UPLOAD_BASE_URL` is unset and the `Host` a client connects with is not loopback, and offer the
   `Authorization: Bearer` `curl` line next to the `?t=` one, so the secret need not travel in a query string or a
   process argument list. (`UPLOAD_BASE_URL` in the `docs/DEPLOY-SYSTEMD.md` §7 checklist is in this fork already.)
2. **Z3** — `Meetings.join` should call `manager.checkAllowed(tenant, target)` next to the platform check, so a
   tenant with a host allowlist that does not name `meet.google.com` / `app.zoom.us` gets the same clear refusal
   `navigate` gives.
3. **U3** — say in README › Uploading files that the `drop` fallback hands the files to the page's own DOM whether
   or not anything there handles the drop, and that `method: 'input'` / `'chooser'` avoids it.
