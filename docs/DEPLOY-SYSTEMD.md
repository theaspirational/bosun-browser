# Deploying Bosun on Linux with systemd

A single-host deployment: Bosun as its own unprivileged user, headful Chromium under Xvfb, both listeners on
loopback, the live view published to a private network only, and every secret outside this repository.

Example files: [`deploy/bosun.service`](../deploy/bosun.service) and
[`deploy/bosun.env.example`](../deploy/bosun.env.example). Placeholders (`example.org`, `bosun.example.ts.net`) are
meant to be replaced; nothing in this repository knows your hostnames or tokens, and nothing here should learn
them.

Threat model behind these choices: the browser runs untrusted web content, so it keeps **Chromium's own sandbox**
(§3a — this needs host configuration, and the service refuses to start without it), and the user it runs as must
own nothing else and reach nothing else. See [FORK-SECURITY-REVIEW.md](FORK-SECURITY-REVIEW.md) — in particular H1
(where the browser may go), H3 (the sandbox), M1 (the live-view link is a bearer token), M4 (child processes inherit
the service's environment, tokens included) and M5 (downloads on disk).

## 1. User, directories, packages

```sh
sudo useradd --system --create-home --home-dir /var/lib/bosun --shell /usr/sbin/nologin bosun
sudo install -d -o bosun -g bosun -m 0700 /var/lib/bosun/data /var/lib/bosun/pw-browsers
sudo install -d -o root  -g bosun -m 0750 /etc/bosun

sudo apt-get install -y nodejs npm xvfb   # Node 20+; use nodesource if the distro ships an older one
sudo install -d -o root -g root -m 0755 /opt/bosun
sudo git clone <this fork> /opt/bosun     # or unpack a release tarball
sudo chown -R root:root /opt/bosun        # code is read-only to the service user
```

Install dependencies and the browser **as the service user**, so the browser lands in the data volume and not in
root's cache:

```sh
cd /opt/bosun
sudo npm ci --omit=optional               # skips patchright/camoufox; this fork only enables chromium
sudo -u bosun env HOME=/var/lib/bosun PLAYWRIGHT_BROWSERS_PATH=/var/lib/bosun/pw-browsers \
  npx playwright install chromium
sudo npx playwright install-deps chromium # the shared libraries Chromium needs (root, once)
```

`npm ci` writes `node_modules` under `/opt/bosun`; keep it root-owned. The service user needs write access to
`/var/lib/bosun` only.

## 2. Secrets

```sh
openssl rand -hex 32        # one token per tenant
sudo install -o root -g bosun -m 0640 deploy/bosun.env.example /etc/bosun/bosun.env
sudo editor /etc/bosun/bosun.env
```

- Tokens live only in `/etc/bosun/bosun.env` (`root:bosun`, `0640`), never in the unit file, never in a shell
  history, never in this repository, never in a URL (`?token=` still works but puts the token in logs — use the
  `Authorization: Bearer` header).
- One token per consumer, so revoking one does not disturb the others. Rotation = edit the file,
  `systemctl restart bosun`.
- The browser, `ffmpeg` and `pulseaudio` children inherit this environment, so anything able to read
  `/proc/<pid>/environ` as the `bosun` user can read the tokens — every tenant's token, since `BROWSER_TOKENS` is
  one variable. That is why `bosun` runs nothing else, why the browser keeps its sandbox (§3a), and why hard
  tenant isolation means one service per tenant.

## 3. The unit

```sh
sudo install -o root -g root -m 0644 deploy/bosun.service /etc/systemd/system/bosun.service
sudo systemctl daemon-reload
sudo systemctl enable --now bosun
journalctl -u bosun -f
```

Expect two lines and no token:

```
bosun: MCP over WebSocket on 127.0.0.1:7360
bosun: live view on 127.0.0.1:7350
```

What the unit does, and why:

| directive | why |
|---|---|
| `User=bosun` | the browser's blast radius is one user that owns nothing else |
| `xvfb-run -a -s "-screen 0 1366x900x24 -nolisten tcp"` | headful Chromium on a private display; no X over TCP |
| `TasksMax=2000` | Chromium spawns a lot of threads; the default limit is easy to hit |
| `MemoryMax=6G` | ~0.3–0.6 GB per headful session plus the shared browser; keep the host from swapping |
| `EnvironmentFile=/etc/bosun/bosun.env` | secrets stay in a root-owned file |
| `ProtectSystem=strict` + `ReadWritePaths=/var/lib/bosun` | the only writable path is the data volume |
| `ProtectHome=yes`, `PrivateTmp=yes`, `NoNewPrivileges=yes` | no access to other users' data, private `/tmp` |
| `RestrictAddressFamilies=… AF_NETLINK` | Chromium needs netlink for network-change notifications |
| no `SystemCallFilter`, no `RestrictNamespaces`, no `PrivateUsers` | Chromium's **own** sandbox needs `clone()`/`unshare()` and user namespaces; filtering them makes the browser fail to start (§3a) |

Bosun locates leftover browser processes with `ps` and kills them by their profile directory
(`src/sessions.mjs`), so do not hide its own children from it (no `PrivatePIDs=yes`).

These directives bound what the service **user** may do. They are not a renderer sandbox: that is §3a, and without
it a page that breaks the renderer is already inside everything the unit allows.

## 3a. Chromium's sandbox (the service will not start without it)

`CHROMIUM_SANDBOX` defaults to `1`, and startup starts the browser once to prove the sandbox works. If it cannot,
the service exits with the list below instead of running unprotected. Pick **one** of the three:

**1. Allow unprivileged user namespaces (simplest; Ubuntu 23.10+ restricts them via AppArmor).**

```sh
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-apparmor-userns.conf
sudo sysctl --system
sysctl kernel.apparmor_restrict_unprivileged_userns    # expect 0
```

**2. Or grant `userns` to the browser binary with an AppArmor profile** (keeps the restriction for everything else).
Create `/etc/apparmor.d/bosun-chromium`:

```
abi <abi/4.0>,
include <tunables/global>

profile bosun-chromium /var/lib/bosun/pw-browsers/**/{chrome,chrome-headless-shell,headless_shell} flags=(unconfined) {
  userns,
  include if exists <local/bosun-chromium>
}
```

then `sudo apparmor_parser -r /etc/apparmor.d/bosun-chromium`. Re-run it after a Playwright update changes the
browser path.

**3. Or use Chromium's setuid helper** (if your policy keeps user namespaces restricted):

```sh
sudo chown root:root /var/lib/bosun/pw-browsers/chromium-*/chrome-linux64/chrome_sandbox
sudo chmod 4755 /var/lib/bosun/pw-browsers/chromium-*/chrome-linux64/chrome_sandbox
```

and add `Environment=CHROME_DEVEL_SANDBOX=/var/lib/bosun/pw-browsers/chromium-<build>/chrome-linux64/chrome_sandbox`
to the unit. A setuid binary cannot gain privileges under `NoNewPrivileges=yes`, so this option also means
**removing `NoNewPrivileges=yes` from the unit** — a worse trade than options 1 and 2, so use it only if you must.

Verify what actually runs, not the setting:

```sh
ps -eo args | grep -- --type=renderer | grep -c -- --no-sandbox   # expect 0
```

A container or CI box that allows none of the three can only run with `CHROMIUM_SANDBOX=0`, which the service
prints a warning about at every start. Do not do that on a host that also holds persistent profiles.

## 4. Network: loopback plus `tailscale serve`

Both listeners bind `127.0.0.1`. Nothing is published by Bosun itself.

- **MCP (WebSocket)** stays on loopback. Agents on the same host connect to `ws://127.0.0.1:7360`; stdio-only
  clients use the `bosun-mcp-stdio` bridge (README › stdio bridge). If a remote agent needs it, publish it on the
  private network with its own path and keep the token requirement:
  `tailscale serve --bg --https=443 --set-path=/mcp http://127.0.0.1:7360`.
- **Live view** is published for the human's phone:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:7350
tailscale serve status
```

Then set `LIVE_BASE_URL=https://<node>.<tailnet>.ts.net` so the links Bosun hands out point at the proxy, not at
`127.0.0.1`. The live-view page derives its WebSocket origin from that URL, so it must match exactly (scheme and
host), without a trailing path.

- **Never `tailscale funnel`.** A handoff link is a bearer token for the whole handoff (TTL `HANDOFF_TTL_SEC`,
  default 900 s): anyone who has it can drive that tab while nobody else is connected. Keep it inside the tailnet,
  send it over a private channel, and press **Done** when finished — that revokes it for good.
- Egress: the service should not be able to reach your private networks. Block `10/8`, `172.16/12`, `192.168/16`,
  `100.64/10` (except the tailnet addresses you need) and `169.254/16` for the `bosun` user or its network
  namespace. The host allowlist below narrows what the agent asks for; the firewall is what makes it a boundary.

## 5. Host allowlist and feature switches

```sh
BROWSER_TENANT_ALLOW=ops=*.example.org,example.org,127.0.0.1:4848; swarm=*.example.org
FEATURES_MEETINGS=0
FEATURES_ENGINES=chromium
```

- `BROWSER_TENANT_ALLOW` is per tenant: entries separated by `;`, hosts within an entry by `,`. Patterns are
  `host` (any port), `*.host` (subdomains only — add the apex separately), `host:port`, `[::1]:port`, or `*`.
- A named tenant gets **its own forward proxy inside the service**, on loopback with a password of its own, and its
  browser contexts are launched with that proxy as their only way out. Every connection — navigations, each
  redirect hop, subresources, XHR, WebSockets from the page or from a worker, service-worker fetches, prefetches —
  is checked there before anything is sent, and the proxy resolves DNS itself so a name cannot point somewhere else
  between the check and the connection. Nothing is intercepted: TLS is tunnelled, so the browser's origins,
  cookies and CORS stay exactly as the network says.
- A denied connection is logged as `bosun: tenant <t>: blocked <host>:<port> — <reason>` (host and port only, one
  line per target) and answered with `403`, so a denied navigation shows the proxy's reason and `navigate` reports
  `refused: "host allowlist"`.
- Name an address as an address: a name in the allowlist that resolves into loopback or a private range is refused
  unless the allowlist also names that address (this is what DNS rebinding runs into). For a local service, list
  `127.0.0.1:4848`, not only the name that points at it.
- The allowlist is host and port, and a `CONNECT` tunnel is not inspected, so an entry without a port allows a
  tunnel to any port on that host. Prefer `host:port`.
- Remember the hosts a login actually needs: an identity provider, a CDN that serves the page's scripts, the
  CAPTCHA vendor. A handoff can only reach what the tenant may reach.
- A tenant that is not named is unrestricted and gets no proxy at all.
- This is a per-tenant rule inside the service, not a replacement for the egress policy in §4.
- `FEATURES_MEETINGS=0` (the default here) means the meeting tools are not listed and their handlers are not wired:
  no recordings directory, no PulseAudio server, no `ffmpeg`. Turning it on adds a recording consent surface — read
  README › Meetings first.
- `FEATURES_ENGINES=chromium` (the default here) means a session cannot ask for the anti-detect engines. Enable
  them deliberately (`FEATURES_ENGINES=chromium,patchright`) and install them first. `patchright` runs Bosun's
  masking helpers in an isolated world, which stops a page from switching masking off — but not from copying what
  the human typed somewhere masking does not look (review finding H2). No engine makes an untrusted page safe to
  type a credential into.
- `DOWNLOADS=0` (the default here) means the browser context refuses downloads, so a page cannot write files at
  all. With `DOWNLOADS=1`, `DOWNLOADS_MAX_MB` (per session) and `DOWNLOADS_TOTAL_MAX_MB` (service-wide) bound what
  is kept; one download may still use its own size transiently before it is measured, and Playwright keeps download
  files under `/tmp` — which is RAM-backed on most systems and, with `PrivateTmp=yes`, private to this unit. Give
  the volume a quota, or keep downloads off.

## 6. Operating it

- Logs: `journalctl -u bosun`. Bosun never logs tokens or query strings; a denied request is logged as origin plus
  path only.
- Data: `/var/lib/bosun/data` holds `profiles/<tenant>/<name>` (cookies — treat it as credential material),
  `keepalive.json` and, with `SAVE_SHOTS=1`, screenshots (`0600`, deleted with the session). Back it up like a
  password store, or not at all.
- Upgrade: `git -C /opt/bosun pull`, `sudo npm ci --omit=optional`, re-run `playwright install chromium` as `bosun`
  when the pinned Playwright version changed, `systemctl restart bosun`. Restarting ends every session and handoff.
- Restart behaviour: `Restart=on-failure` with a 45 s stop timeout. Bosun closes sessions and handoffs on SIGTERM
  within its own bounded deadlines; a browser that survives SIGKILL keeps its session slot and says so in the log.
- Health check: `systemctl is-active bosun` plus one `tools/list` call over the WebSocket with a real token.
- After every upgrade, re-check the sandbox: the journal must carry no `CHROMIUM_SANDBOX=0` warning, and
  `ps -eo args | grep -- --type=renderer | grep -c -- --no-sandbox` must print `0` while a session is open. A
  Playwright update moves the browser path, which an AppArmor profile (§3a option 2) or `CHROME_DEVEL_SANDBOX`
  (option 3) has to follow.

## 7. Checklist before you call it done

- [ ] `/etc/bosun/bosun.env` is `root:bosun 0640` and holds real tokens; the repository holds none.
- [ ] `ss -ltnp` shows both Bosun ports bound to `127.0.0.1` only.
- [ ] `tailscale serve status` shows the live view, and `tailscale funnel status` shows nothing.
- [ ] `LIVE_BASE_URL` matches the `tailscale serve` address; a link opens on a phone in the tailnet.
- [ ] Every tenant that should be restricted appears in `BROWSER_TENANT_ALLOW`; a `navigate` to another host is
      refused, and the refusal shows up in the journal without the query.
- [ ] `FEATURES_MEETINGS=0`, `FEATURES_ENGINES` lists only what is installed, `DOWNLOADS=0` (or a quota on the
      volume).
- [ ] The service started without a `CHROMIUM_SANDBOX=0` warning, and no renderer process shows `--no-sandbox`.
- [ ] Egress to private ranges is blocked for the service.
- [ ] `ALLOW_NO_TOKEN` is unset.
