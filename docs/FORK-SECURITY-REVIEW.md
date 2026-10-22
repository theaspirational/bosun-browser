# Security review of Bosun 0.7.0 (upstream `e0504b2`)

Reviewed 2026-10-22 against upstream commit `e0504b2` ("read-only tokens for subagents"), as the basis for this
fork. Line references are to that commit; `file:line` points at the code the finding is about.

**Scope.** Authentication and tenant isolation, the live-view handoff link, masking of credential fields around a
handoff, URL handling on `navigate`, WebSocket origin checks, resource caps, dependency pinning, anything that runs
page-controlled code where Bosun or the agent can be affected by it, and any call home / telemetry.

**Method.** Read of `src/**`, `bin/**`, `package.json` / `package-lock.json` and the docs; `grep` for outbound
network use; live probes against headless Chromium (below, under H2, H3 and M5). Two further independent review
rounds then attacked this fork's own changes, and between them corrected three of the conclusions below and two of
the mechanisms: the first version of the host allowlist let ordinary HTTP redirects and WebSockets straight past,
the second broke the browser's origin isolation while fixing that, Chromium had been running with `--no-sandbox`
all along, and engine choice is a much weaker credential boundary than H2 first claimed. All of it is corrected
here (H1 — including what the two failed mechanisms were — H2 and H3), and the enforcement now sits at the network
layer, where it does not have to re-implement anything the browser already does. Not done: fuzzing,
a review of the Playwright/Chromium/`ws`/`zod` dependencies themselves, no test against a real hostile site, no
review of `src/meetings/**` beyond the parts that touch the service's security properties (meetings are off in this
fork).

**Verdict.** Nothing found that makes the service unsafe to run for our use (UI checks and human-finished logins on
hosts we control) **provided** three things hold: the service cannot reach anything it has no business reaching
(network egress policy plus the per-tenant host allowlist this fork adds), a handoff where the human types real
credentials happens on a page we trust — on any engine (H2) — and the browser keeps its own sandbox (H3). None of
the HIGH findings is a code defect in the service's own logic: upstream states the egress requirement in
`README.md` › Security notes but ships no in-process control for it, leaves Playwright's default `--no-sandbox` in
place, and documents the page-world limitation in `docs/ENGINES.md:101-105` without spelling out that it is
defeatable.

Severity: **HIGH** = can expose credentials or reach systems outside the intended blast radius. **MEDIUM** = narrows
an important guarantee or depends entirely on the deployment to be safe. **LOW** = hardening, bounded impact.
**INFO** = verified, no action.

| # | Severity | Finding | Status in this fork |
|---|---|---|---|
| H1 | HIGH | `navigate` and page requests may go to any host (SSRF; cloud metadata, private LAN) | mitigated: per-tenant host allowlist (`BROWSER_TENANT_ALLOW`) enforced by a per-tenant forward proxy — every connection, including redirect hops, worker WebSockets and DNS |
| H2 | HIGH | A page can defeat credential masking and the post-handoff clearing on engine `chromium` | documented; engine choice stops only the helper tampering — the page must be trusted either way |
| H3 | HIGH | Chromium runs with `--no-sandbox`: a renderer compromise lands on the service user | fixed: `chromiumSandbox: true`, `CHROMIUM_SANDBOX=0` to opt out loudly, startup preflight |
| M1 | MEDIUM | The live-view link is a bearer token for the whole handoff, retakeable after 5 s of viewer silence | accepted: live view on loopback behind a private-network proxy |
| M2 | MEDIUM | Masking covers the page dump, not the URL and title returned with it | documented |
| M3 | MEDIUM | One shared Chromium browser process serves every tenant; the global session cap is shared | narrowed: a tenant with an allowlist gets its own browser process; the rest still share one, caps still global |
| M4 | MEDIUM | Service secrets are inherited by every browser child process | deploy guidance: own user, own `EnvironmentFile` |
| M5 | MEDIUM | A page's downloads are written to disk with no budget at all | fixed: `DOWNLOADS=0` by default, per-session and service-wide byte budgets |
| L1 | LOW | Legacy `?token=` query parameter still accepted | deploy guidance: header only |
| L2 | LOW | No rate limiting, lockout or log on failed authentication | accepted |
| L3 | LOW | `ALLOW_NO_TOKEN=1` gives any local process a full-policy tenant | deploy guidance: never set |
| L4 | LOW | The per-meeting PulseAudio socket is `auth-anonymous=1` | meetings off by default in this fork |
| L5 | LOW | Page and meeting text reaches the agent unsanitized (prompt injection) | inherent; agent side must treat it as data |
| L6 | LOW | An agent-supplied regex is compiled and run inside the page | accepted |
| I1 | INFO | No telemetry and no call home | verified |
| I2 | INFO | Token handling and tenant namespacing are sound | verified |
| I3 | INFO | WebSocket origin checks, live-view CSP and input validation are in place | verified |
| I4 | INFO | Resource caps are broad; gaps noted (downloads: M5) | verified |
| I5 | INFO | Dependencies are exactly pinned, no install scripts | verified |
| I6 | INFO | No tool runs agent- or page-supplied code in the service process | verified |

---

## H1 — HIGH: `navigate` and every request the page makes may go to any host

`httpUrl` checks the scheme and nothing else (`src/sessions.mjs:20-25`), so `navigate` (`src/tools.mjs:137-145`)
and `keepalive_set` (`src/keepalive.mjs:268-270`) accept `http://127.0.0.1:…`, `http://10.0.0.5/…`,
`http://169.254.169.254/…` and any other host that resolves. There is no check at all on the requests the page
itself makes: a page can redirect, `fetch`, or embed an iframe anywhere, so a single prompt injection in page
content ("open this URL") or a hostile redirect turns the browser into a proxy into whatever network the service
sits in. There is no DNS-rebinding protection either; only the scheme is validated, once, before the navigation.

Impact: read access to link-local metadata services and internal HTTP endpoints from the service's network
position, exfiltration of what it reads via a following request.

Upstream's position (`README.md:412-414`) is that the deployment must block private ranges on egress; the
`http(s)`-only check explicitly does not replace that boundary.

**In this fork:** `BROWSER_TENANT_ALLOW` gives a tenant a host allowlist, and the tenant's browser reaches the
network **only through a forward proxy the service runs for that tenant** (`src/proxy.mjs`). That tenant also gets
a **browser instance of its own**, launched with that proxy (`--proxy-bypass-list=<-loopback>`, QUIC off, WebRTC's
non-proxied UDP off, and Chromium does not fall back to a direct connection when a proxy refuses). Those are
browser-wide flags, so they stay in that browser: tenants without an allowlist share a browser launched the way
upstream launches it, and configuring one tenant's allowlist does not change another tenant's transports
(`test/transport-isolation.test.mjs`). Every connection the browser wants arrives there
as a request or a `CONNECT` and is checked before a byte leaves the host: navigations, **each hop of a redirect**,
subresources, XHR, WebSockets from a page **and from a worker**, service-worker fetches, prefetches. The proxy
resolves DNS itself, once, and connects to that address, so the address the decision was made about is the address
that is used; a name that resolves into loopback or a private range is only followed if the allowlist names that
address too (DNS rebinding). Denials are answered with `403` and logged as `host:port` and a reason — never a path
or a query. `navigate` and `keepalive_set` check the list up front as well, so the agent gets a clear refusal. A
tenant with no allowlist gets no proxy and keeps upstream behaviour. The proxy listens on loopback with a random
password of its own, so another local process cannot use it as an open proxy into the tenant's hosts.

Nothing is intercepted: TLS is tunnelled, plain HTTP is streamed, no response is terminated, rewritten or
buffered. That is the point of this layer — the browser keeps its own semantics, so a redirect to another allowed
host loads **as that host** (its own origin, storage and cookies) and the tab shows where it really ended up.

### Two mechanisms that did not work, and why (worth not repeating)

The first two attempts enforced this *inside* the page, with Playwright's request routing, and both were taken
apart by review:

1. **`route.continue()`** checks only the first request of a chain: Playwright's network manager continues every
   redirect hop whose request has a `redirectedFrom` without consulting the handler again, so an allowed host could
   move the browser anywhere with a `302`. Probed for all five redirect codes.
2. **Walking the chain with `route.fetch({maxRedirects: 0})` and fulfilling the final response** closed that, and
   broke something worse: a response fetched from another origin was fulfilled **under the URL that was asked
   for**, so its scripts ran with the first origin's authority. The review's probe read origin A's `localStorage`
   from a page that came from origin B (`stolen=A-only-probe-secret`), which is a storage-confidentiality
   regression, not a trade-off — an allowlist grants reachability, never mutual trust between an app, its CDN and
   its identity provider. The same mechanism also left every fetched response buffered in the service
   (`APIRequestContext` keeps the bodies until disposal: 8 MiB retained after eight 1 MiB fetches) and still did
   not cover a WebSocket opened inside a dedicated `Worker`, because Playwright's WebSocket routing lives in the
   page.

Both are reverted. The lesson is the layer, not the patch: an allowlist is a network rule, and anything that
enforces it by answering *for* the network ends up re-implementing the browser's own guarantees badly.
`test/allowlist-proxy.test.mjs` keeps the adversarial cases as regression tests — every redirect code, a page
WebSocket, a **Blob-worker** WebSocket, a subresource redirect, a cross-origin redirect that must load as its own
origin, and a name that resolves into loopback.

What the proxy costs, and what it still does not do:

- The allowlist is host and port, and a `CONNECT` tunnel is not inspected, so an entry without a port permits a
  tunnel to any port on that host; prefer `host:port`. Paths and queries are never examined (nor logged).
- Plain `http://` is proxied as HTTP/1.1 (no h2c, no QUIC); `https://` is end-to-end inside the tunnel.
- Hosts that are allowed can still talk to each other under the browser's normal rules. Reachability is not trust.
- The proxy is per tenant inside one service; network egress policy remains the outer boundary, as upstream says.

## H2 — HIGH: on engine `chromium`, the page can defeat credential masking and the post-handoff clearing

Bosun's sensitive-field scans (`src/redact.mjs:17-52`) and the "was once a password field" tracker
(`src/redact.mjs:76-102`, installed as an init script at `src/sessions.mjs:183`) run **in the page's own JavaScript
world** on the default engine. Both sides share state through `window[Symbol.for('bosun.sensitive')]`, an ordinary
writable property. A page that overwrites it with a stub keeps the scans from recognizing any field that is not
sensitive by markup at the moment of the scan — in particular a field that *was* `type=password` and was switched to
`type=text` (a "show password" toggle, the case the tracker exists for).

Probed against this commit, headless Chromium 156, engine `chromium`:

```
# page: <input id=x type=password> + window[Symbol.for('bosun.sensitive')] = {add(){}, has(){return false}}
#       and, 300 ms later, x.type = 'text'
control: a11y leaks=false text leaks=false masked=true    - textbox: [masked]
defeat:  a11y leaks=true  text leaks=false masked=false   - textbox: Probe-Secret-9981

# same override, then clearSensitive() as sessions.mjs calls it after Give up / timeout
defeat=false sensitiveValues=["half-typed-password"] valueAfterClear=""
defeat=true  sensitiveValues=[]                     valueAfterClear="half-typed-password"
```

So on a page that wants to, (a) `read` returns what the human typed into the credential field, and (b) the cleanup
after **Give up / timeout / cancel** (`src/sessions.mjs:284-287`) reports success while leaving the half-typed
credential in the form for the agent to read. (a) also applies to `screenshot`, whose mask comes from the same scan
(`src/redact.mjs:121-128`). Label-based masking of the page dump (`src/redact.mjs:130-143`) still applies and is not
page-controlled, so a field whose accessible name looks like a password stays masked; the leak is the field whose
name does not.

`docs/ENGINES.md:101-105` and `README.md` › Handoff state that the helpers run in the page's world on plain
Chromium and that a page can *detect* them; that they can be neutralized is not stated. `patchright` and `camoufox`
run the scans in an isolated world (upstream's own test asserts this and skips it for `chromium`:
`test/handoff.test.mjs:326`).

**How far another engine helps — corrected.** An earlier version of this review recommended `ENGINE=patchright`
for credentials on sites "we do not control". That is too strong a promise, and the second review round showed
why. An isolated world only stops a page from *replacing Bosun's own objects*; it shares the page's DOM, and
masking works on fields — their current value, and the values Bosun has seen in them. A page that simply moves what
the human typed somewhere else defeats masking on every engine, with no tampering at all:

```
# page: <input type=password> and a button that copies the value into a <p> and clears the input
MIRROR VALUES []                                 # nothing is in a credential field any more
MIRROR READ  … submit | Mirror-probe-secret …    # the MCP read returns it as ordinary page text
```

That is reproduced as a standing test (`test/masking-limits.test.mjs`), together with the case that *is* masked, so
the two documents and the behaviour cannot drift apart. Screenshots have the same shape: the mask covers the
inputs, not a copy of their contents elsewhere on the page. Upstream says as much for the page's own doing
(`README.md` › Handoff: "secrets the page itself echoes as normal text" are not protected); the mistake was ours,
in presenting an engine switch as a boundary.

**In this fork:** the helper-tampering hole is not fixed in code — fixing it upstream-compatibly means moving the
scans off the page world for `chromium` too, which is upstream's design decision, not ours. What holds instead:
`ENGINE=patchright` stops that one technique (an isolated world), the host allowlist (H1) keeps a handoff on hosts
the tenant may reach at all, and **the page where a human types a credential has to be one we trust, whatever the
engine**. If that is not true for some flow, the credential does not belong in this browser.

## H3 — HIGH: Chromium runs without its own sandbox

Neither Chromium launch path passes `chromiumSandbox` (`src/engines.mjs:49-55` upstream), and the pinned Playwright
adds `--no-sandbox` unless that option is explicitly `true`. Probed on a real session of the service: both the
browser process and the renderer carried `--no-sandbox`.

```
# ps -eo args, while a session was open
… chrome-headless-shell … --no-sandbox --disable-blink-features=AutomationControlled --user-data-dir=/…
… chrome-headless-shell --type=renderer --headless=old --no-sandbox --disable-dev-shm-usage …
```

So the process that parses untrusted HTML, CSS, images and JavaScript has nothing between it and the service user:
one renderer bug, and the attacker is reading `profiles/<tenant>/…` (every tenant's cookies), the tokens in the
service's environment (M4) and whatever else that user can reach. The systemd hardening in a deployment is a
different boundary — it limits what the *user* may do, not what a compromised renderer may do inside it — and the
first version of this review discussed "escaping the browser sandbox" without noticing there was none. That was a
review defect; the launch behaviour itself is upstream's.

**In this fork:** both Chromium-family engines launch with `chromiumSandbox: true` (`src/engines.mjs`), which is
also what `CHROMIUM_SANDBOX` defaults to. Because the sandbox needs host configuration, startup runs a preflight on
Linux — it starts the browser the way sessions will and closes it again — and **refuses to start** with the three
things an operator can do about it (unprivileged user namespaces, an AppArmor profile that grants `userns`, or the
setuid helper) rather than falling back. Running unsandboxed stays possible, but only as `CHROMIUM_SANDBOX=0`,
which is printed as a warning at every start. `docs/DEPLOY-SYSTEMD.md` carries the exact commands, including that
the setuid-helper route needs `NoNewPrivileges` **off** in the unit. Tests: `test/features.test.mjs` ("with the
sandbox on, the service either runs sandboxed or refuses to start" — it asserts there is no `--no-sandbox` on any
renderer when the sandbox works, and the instructive refusal when it cannot).

Note for this repository's CI and for containers: unprivileged user namespaces are often unavailable there (on the
machine this fork was built on, `kernel.apparmor_restrict_unprivileged_userns=1` and Playwright's `chrome_sandbox`
is not setuid), which is exactly when the service now refuses to start. The test suite sets `CHROMIUM_SANDBOX=0`
deliberately and says so.

## M1 — MEDIUM: the live-view link is a bearer token for the whole handoff

`createLiveView` keys handoffs by a 128-bit random token (`src/liveview.mjs:553`) and serves `/v/<token>` and
`/ws/<token>` to whoever presents it (`src/liveview.mjs:306-349`). There is no second factor, no binding to a device
or address, and the link stays valid for `HANDOFF_TTL_SEC` (default 900 s, configurable up to 24 h,
`src/config.mjs:22`). One viewer at a time is enforced, but a viewer that has not been heard from for `STALE_MS`
(5 s, `src/liveview.mjs:179`, `:343`) can be replaced, so an attacker holding the link only has to wait for a quiet
moment to take over the session — with whatever the tenant's profile is logged into. The agent (an LLM) is given the
link, so it also flows wherever the agent's output flows.

Verified good: `finish()` deletes the token from the map before anything else (`src/liveview.mjs:518-523`), so Done,
Give up, timeout, cancel, `session_close` and agent disconnect all revoke the link for good — afterwards `/v/` is
404 and `/ws/` is rejected; the last frame is dropped (`:521`), and the handoff only resolves once the human's input
has drained (`:530-537`), with `drainFailed` closing the session if it cannot (`src/sessions.mjs:282`).

Documented upstream (`README.md:415-419`). Accepted for this fork: the live view listens on loopback and is reached
only over a private network (see `docs/DEPLOY-SYSTEMD.md`), `HANDOFF_TTL_SEC` stays at the default, and the human
presses Done when finished.

## M2 — MEDIUM: masking covers the page dump, not the URL and title returned with it

`read` masks the snapshot and only then prepends the URL and title (`src/tools.mjs:164-166`); `navigate`, `click`,
`type`, `press`, `back`, `wait_for` and `sessions` return `pageInfo` / `page.url()` unmasked
(`src/tools.mjs:143,173,180,191,196,203,300`). A credential that reaches the query string (a form that submits with
GET) or the page title is therefore visible to the agent even while the field itself is masked. Upstream treats the
title after Done as intentional (`test/handoff.test.mjs:49`), and navigation history is deliberately stored without
the query (`src/sessions.mjs:16`), so this is a known boundary rather than an oversight — but it is worth knowing
before pointing a handoff at a login form that uses GET.

## M3 — MEDIUM: one shared browser process for all tenants; the global session cap is shared

With the default engine every ephemeral session is a context of **one** shared Chromium
(`src/sessions.mjs:97-106`, `src/engines.mjs:49-55`). Contexts separate cookies and storage, but a compromise at
browser-process level, or any Chromium bug that crosses contexts, crosses tenants. `MAX_SESSIONS` is global and
`MAX_SESSIONS_PER_TENANT` defaults to it (`src/config.mjs:42`), so one tenant can occupy every slot and starve the
others (keepalive leaves one slot free for agents, `src/keepalive.mjs:346-349`, but an agent does not).

Upstream says hard isolation means one process and data dir per tenant (`README.md:410-411`). Accepted for one
team; set `MAX_SESSIONS_PER_TENANT` below `MAX_SESSIONS` when more than one tenant shares a service.

**In this fork, partly narrowed as a side effect of H1:** a tenant with a host allowlist runs in a browser process
of its own (it has to, because the flags that keep it inside its proxy are browser-wide), so such a tenant no
longer shares a process with anyone. Tenants without an allowlist still share one browser, and the session caps are
still global.

## M4 — MEDIUM: service secrets are inherited by every child process

Playwright launches the browser with the service's environment by default, and the meeting path passes it on
explicitly (`{ ...process.env, … }`, `src/meetings/audio.mjs:38`). `BROWSER_TOKEN` / `BROWSER_TOKENS` are therefore
readable in `/proc/<browser pid>/environ` by any process running as the same user, and by anything that escapes the
browser sandbox. Mitigation is deployment-side: a dedicated unprivileged user that runs nothing else, tokens in a
root-owned `0640` `EnvironmentFile` outside the repo (`docs/DEPLOY-SYSTEMD.md`), and Chromium's own sandbox between
the page and that environment (H3). Separate tokens per tenant do **not** contain this one: `BROWSER_TOKENS` holds
every tenant's token in a single variable, which every child process inherits whole. They help with rotation, not
with containment; one service process per tenant is what contains it.

## M5 — MEDIUM: a page's downloads are written to disk with no budget

Playwright contexts accept downloads unless told otherwise, and upstream never says otherwise: no
`acceptDownloads`, no cancellation, no byte or count cap. Probed by the second review round on a real session — a
click on an attachment link saved 65 536 bytes without anyone asking — and the resource-cap inventory in the first
version of this review missed it entirely (I4 listed screenshots, DOM size and meeting recordings, not downloads).

A page can therefore write as much as it likes, as often as it likes, for as long as the session lives.
`MAX_SESSIONS`, `MemoryMax` and `PrivateTmp` do not bound disk: files land in Playwright's artifacts directory
(under `/tmp`, which is commonly a tmpfs, so it is RAM) and live until the context closes.

**In this fork:** downloads are off by default (`DOWNLOADS=0` → `acceptDownloads: false`, so a download is refused
by the context and nothing is written). With `DOWNLOADS=1`, each session keeps at most `DOWNLOADS_MAX_MB` (default
100) and the service at most `DOWNLOADS_TOTAL_MAX_MB` (default 500) of downloaded bytes: a download that would pass
either budget is cancelled before it is written, or deleted again if its size was only known afterwards, and the
refusal is logged without the URL's query. Closing a session releases its share, since the context takes its files
with it. Tests: `test/downloads.test.mjs`. What this does *not* bound: a single download transiently uses its own
size on disk before it can be measured — so give the volume a real quota if you turn downloads on.

## L1 — LOW: the legacy `?token=` query parameter is still accepted

`tokenFromRequest` falls back to the query parameter (`src/auth.mjs:26-30`, used at `src/wsserver.mjs:76`), which
puts the token into URLs, proxy logs and anything that keeps request lines. Documented and deprecated upstream
(`README.md:60-62`); use the `Authorization: Bearer` header only.

## L2 — LOW: no rate limiting, lockout or logging on failed authentication

The upgrade handler answers 401 and destroys the socket (`src/wsserver.mjs:69-83`); nothing counts failures, delays
retries or logs them, so there is no audit trail of a token being probed. `MAX_CONNECTIONS` (32) and TCP setup cost
are the only brake. With 16+-character tokens (`src/auth.mjs:5`) guessing is not the risk; the missing log is.
Upstream acknowledges the gap (`README.md:420`).

## L3 — LOW: `ALLOW_NO_TOKEN=1`

Permitted only on a loopback bind and only when set explicitly (`src/config.mjs:56-60`), but then any local process
of any local user gets tenant `default` with policy `full` — profiles, keepalive, meetings, handoff. Never set it on
a shared host.

## L4 — LOW: the per-meeting PulseAudio server accepts anonymous connections

`module-native-protocol-unix … auth-anonymous=1` (`src/meetings/audio.mjs:43`) on a socket inside a `0700` temp
directory: the directory is the only protection, so any process of the same user can play into or record from a
meeting's audio server. Meetings are disabled by default in this fork (`FEATURES_MEETINGS=0`).

## L5 — LOW: page and meeting content reaches the agent unsanitized

Inherent to a browser tool: `read` returns page text, `wall()` reads the body (`src/tools.mjs:20-32`), Playwright
error messages are truncated to 500 characters but can still quote the page (`src/tools.mjs:69`), and every meeting
chat message becomes a push event (`src/meetings/index.mjs:284-287`). Everything a page says is untrusted input to
the agent; the service cannot fix that, the agent's prompt must.

## L6 — LOW: an agent-supplied regex is compiled and run inside the page

`keepalive`'s `watch.text_regex` is validated in the service and then compiled with `new RegExp` and executed in the
page over up to 200 000 characters (`src/keepalive.mjs:125-131`). A catastrophic pattern burns that session's
renderer; the 5 s race rejects Bosun's promise (`:131`) but does not stop the page. Bounded to the tenant's own
session.

## I1 — INFO: no telemetry, no call home

`grep` over `src/` and `bin/` for `fetch(`, `http(s)://`, `axios`, `request(`: the only outbound network use is the
pages the agent asks for, the MCPL `push/event` request back to the already-connected client
(`src/events.mjs:187`), and the one `fetch` inside the live-view page's own HTML, which polls its own URL
(`src/liveview.mjs:72`). Third-party URLs exist only in `scripts/measure-engines.mjs` (fingerprinting test sites,
run by hand) and as install instructions for the optional engines (`src/engines.mjs:12-16`). Browser binaries are
fetched at install time from Microsoft's and Camoufox's CDNs.

## I2 — INFO: token handling and tenant namespacing are sound

- Every configured token is compared as a fixed-length SHA-256 digest with `crypto.timingSafeEqual`, with no
  short-circuit on match (`src/auth.mjs:11-23`); upstream's test asserts the call count and digest length
  (`test/config.test.mjs:49-64`).
- Startup refuses tokens under 16 characters, bad tenant names and two tenants sharing a token
  (`src/auth.mjs:46-52`), and refuses to listen on a non-loopback address without a token (`src/config.mjs:56-58`).
- Authentication happens in the HTTP upgrade, before a WebSocket or an MCP server exists (`src/wsserver.mjs:69-79`);
  the tenant is fixed per connection and the connection owns its sessions (`src/wsserver.mjs:85-100`).
- Session lookup uses the same error for "unknown" and "not yours", so IDs cannot be probed
  (`src/sessions.mjs:221-229`), and a disconnect disposes the owner's sessions (`src/sessions.mjs:385-390`).
- Tenant and profile names are `^[a-z0-9_-]{1,40}$` (`src/auth.mjs:4`, enforced on the tool schema), so the
  per-tenant paths for profiles, screenshots and recordings cannot traverse (`src/sessions.mjs:170,325`,
  `src/meetings/index.mjs:105`).
- Policy `ephemeral` is enforced server-side, not merely hidden: unlisted tools get a refusing stub whose handler is
  never wired (`src/tools.mjs:113-120`), and the session manager repeats the profile/engine checks
  (`src/sessions.mjs:118-121`).

## I3 — INFO: origin checks, live-view CSP and input validation

A browser-originated WebSocket must present an allowed `Origin` (`src/wsserver.mjs:75`; with
`WS_ALLOWED_ORIGINS` unset no browser origin is allowed, non-browser clients send none), and the live-view
WebSocket must match the live view's own origin when one is sent (`src/liveview.mjs:338`). The live-view page is
served `no-store`, `no-referrer`, `nosniff`, `X-Frame-Options: DENY` and a CSP with a per-response script nonce,
`default-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`
(`src/liveview.mjs:314-323`); the reason string is HTML-escaped (`:10`, `:43`). Viewer input is whitelist-parsed
(`src/liveview.mjs:263-276`): coordinates bounded, pasted text truncated to 500 characters, keys restricted to a
fixed table, and text is dropped from the queue as soon as it is dispatched (`:482`, `:505`).

## I4 — INFO: resource caps

Per connection: 1 MiB frames, 64 open requests, 8 MiB send buffer, `MAX_INFLIGHT` tool calls
(`src/wsserver.mjs:9-12`, `src/tools.mjs:116`), heartbeat eviction (`src/wsserver.mjs:91`). Per service:
`MAX_CONNECTIONS`, `MAX_SESSIONS`, `MAX_SESSIONS_PER_TENANT`, `IDLE_TIMEOUT_SEC` reaping,
`MAX_PAGES_PER_SESSION` (extra popups closed, `src/sessions.mjs:206`), eight queued operations per session
(`src/sessions.mjs:194`), `MAX_DOM_NODES` before a whole-page `read`, screenshot clipping and a per-session
screenshot ring (`src/tools.mjs:206-222`, `src/sessions.mjs:335`). Live view: 16 KiB frames, 64 queued inputs,
frame drops then disconnect for a slow viewer, drain deadline (`src/liveview.mjs:174-183`). The stdio bridge bounds
line length and pending bytes (`bin/bosun-mcp-stdio.mjs:8-10`). Gaps: **downloads had no budget at all** (M5 — the
first version of this inventory missed them); a meeting recording has no size cap, only `RECORDING_RETENTION_DAYS`
and the sweeper (`src/meetings/index.mjs:68-82`) — it grows at ~11 MB/h while the meeting lasts; and nothing bounds
how often an agent may open and close sessions (no rate limit, L2).

## I5 — INFO: dependencies are exactly pinned, no install scripts

`package.json:20-30` pins `@modelcontextprotocol/sdk` 1.32.1, `playwright` 1.64.1, `ws` 8.22.0, `zod` 4.6.7 and the
optional `camoufox-js` 0.13.0 / `patchright` 1.64.1 without ranges; `package-lock.json` is lockfile v3 with 161
entries — the root project plus 160 dependencies, each with an `integrity` hash and an `https` resolve URL — and no
`postinstall`/`preinstall` anywhere in the tree. Node `>=20`. The flip side of exact pins: a fix in `ws` or `zod` needs a manual bump, so advisories for
these six packages have to be watched.

## I6 — INFO: nothing runs agent- or page-supplied code in the service process

There is no `evaluate` tool (upstream's design lists it as opt-in and has not built it, `docs/DESIGN.md:52,133`).
What an agent can supply is a URL, a CSS selector / role / text target (`src/tools.mjs:71-78`), a keepalive check and
a watch regex (L6) — all of it goes to Playwright or into the page, never to `eval` in the service. Bosun's own
injected helpers are the exception that H2 is about. `procsUsing` shells out via `execFileSync` with a fixed argv and
no shell (`src/sessions.mjs:31-38`), and `terminate` only ever signals PIDs whose command line carries the session's
own directory.

---

## What this fork changed in response

1. **H1** — `BROWSER_TENANT_ALLOW=<tenant>=<host>,<host>;…`: a per-tenant host allowlist, enforced by a forward
   proxy the service runs for that tenant and launches its browser contexts with, so it is the browser's only way
   out. Checked there: navigations, every redirect hop, subresources, XHR, WebSockets from pages and from workers,
   service-worker fetches, prefetches — before anything is sent, with DNS resolved by the proxy and pinned to the
   address the decision was made about. Nothing is intercepted, so the browser's origins, cookies and CORS are
   untouched. `navigate` and `keepalive_set` also refuse up front. A tenant without an allowlist gets no proxy.
2. **H3** — `chromiumSandbox: true` for both Chromium engines, `CHROMIUM_SANDBOX` on by default, a startup
   preflight that refuses to run when the sandbox cannot be set up, and a warning at every start if it is switched
   off.
3. **M5** — `DOWNLOADS=0` by default; with downloads on, `DOWNLOADS_MAX_MB` per session and
   `DOWNLOADS_TOTAL_MAX_MB` across the service, enforced by cancelling or deleting what goes past them.
4. **L4 / consent surface** — `FEATURES_MEETINGS=0` by default: the meeting tools are not listed and their handlers
   are not wired; no recordings directory, no audio server, no PulseAudio socket.
5. **anti-detect surface** — `FEATURES_ENGINES=chromium` by default: a session can only pick `chromium` (plus
   whatever `ENGINE` is set to), so `patchright` and `camoufox` have to be enabled deliberately.
6. **M1 / M4 / L1 / L3** — `docs/DEPLOY-SYSTEMD.md`: own unprivileged user, Xvfb, `TasksMax`, both listeners on
   loopback, live view published over a private network only, secrets in a root-owned `EnvironmentFile` outside the
   repository, bearer header only, `ALLOW_NO_TOKEN` never set, and what the Chromium sandbox needs from the host.

Residual risk after those changes, in order:

- **H2**, and more generally: a page that handles a credential can hand it to the agent, on any engine. Only trust
  decides this.
- What the allowlist is: host and port. A `CONNECT` tunnel is not inspected, so an entry without a port permits a
  tunnel to any port on that host (prefer `host:port`); paths and queries are never examined; and hosts that are
  allowed can talk to each other under the browser's normal rules — reachability is not mutual trust. Network
  egress policy stays the outer boundary.
- Plain `http://` is proxied as HTTP/1.1, so no h2c and no QUIC for proxied tenants; `https://` is end-to-end.
  Every connection of a proxied tenant passes through one extra local hop, and each proxied tenant runs a browser
  process of its own (that is what keeps its transport flags out of everybody else's browser, and it costs the RAM
  of one more browser per such tenant).
- **M1** for as long as a handoff link is live; **M2** on a login form that submits with GET; **M3** while several
  tenants share one process (and one browser); **M5**'s transient single-download size if downloads are enabled.
- **H3** on a host where the operator chooses `CHROMIUM_SANDBOX=0`: then M4's inherited tokens and every tenant's
  profile are one renderer bug away, and only the systemd user boundary is left.
- Verified by probe but worth re-checking after a Playwright or Chromium upgrade, because they are properties of
  the browser rather than of this code: that a context without a proxy still goes direct, that
  `--proxy-bypass-list=<-loopback>` keeps loopback inside the proxy, and that no traffic (QUIC, WebRTC, a worker's
  WebSocket) finds a way around a configured proxy. `test/allowlist-proxy.test.mjs` is where those live.
