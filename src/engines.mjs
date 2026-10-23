// Browser engines. chromium: Playwright's Chromium (shared browser, one context per session). patchright: Playwright
// fork that hides CDP/automation leaks (one persistent-context process per session, its recommended mode).
// camoufox: anti-detect Firefox via camoufox-js launch options, driven by our Playwright (one process per session).
// patchright and camoufox-js are optional dependencies, loaded on first use.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const ENGINE_NAMES = ['chromium', 'patchright', 'camoufox'];
export const CHROMIUM_ARGS = ['--disable-blink-features=AutomationControlled'];
// Extra flags for a browser that serves a proxied tenant (host allowlist): QUIC would not go through an HTTP proxy, and
// WebRTC must not open UDP of its own. Chromium does not fall back to a direct connection when a configured proxy
// refuses or fails. They are Chromium flags, and they are added only where a proxy is in play: a browser serving
// tenants without an allowlist is launched exactly the way upstream launches it.
export const PROXY_ARGS = ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
const chromiumArgs = (proxy, extra = []) => [...CHROMIUM_ARGS, ...(proxy ? PROXY_ARGS : []), ...extra];
// A persistent Chromium profile ignores --force-webrtc-ip-handling-policy (full Chromium reads the profile preference
// instead; only the headless shell honours the flag), so a proxied tenant's profile directory also gets the
// preference before launch. Bosun notes that it set it (MARKER, with the value it replaced), and an unproxied launch
// restores exactly that, so an allowlist that is taken away later does not stay behind in the profile, and a
// preference Bosun did not set is never touched.
const WEBRTC_POLICY = 'disable_non_proxied_udp';
const WEBRTC_MARKER = '.bosun-webrtc-policy';
export function applyWebrtcPolicy(dir, proxied) {
  const file = path.join(dir, 'Default', 'Preferences');
  const marker = path.join(dir, WEBRTC_MARKER);
  const owned = fs.existsSync(marker);
  if (!proxied && !owned) return;
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) prefs = {};
  const current = prefs.webrtc?.ip_handling_policy;
  if (proxied) {
    if (current === WEBRTC_POLICY) return; // already restricted (by us, or by whoever set it)
    fs.writeFileSync(marker, JSON.stringify({ previous: current ?? null }), { mode: 0o600 });
    prefs.webrtc = { ...prefs.webrtc, ip_handling_policy: WEBRTC_POLICY };
  } else {
    let previous = null;
    try { ({ previous = null } = JSON.parse(fs.readFileSync(marker, 'utf8'))); } catch {}
    if (current === WEBRTC_POLICY) {
      if (previous === null) delete prefs.webrtc.ip_handling_policy;
      else prefs.webrtc.ip_handling_policy = previous;
    }
    fs.rmSync(marker, { force: true });
    if (current !== WEBRTC_POLICY) return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(prefs), { mode: 0o600 });
}

// The same for Firefox (camoufox), as preferences: Firefox never sends loopback through a proxy unless told to
// (Chromium's "<-loopback>" bypass rule means nothing to it), WebRTC may only use the proxy, and HTTP/3 (QUIC) and
// DNS prefetching stay off so nothing leaves the browser except through the proxy.
export const PROXY_FIREFOX_PREFS = {
  'network.proxy.allow_hijacking_localhost': true,
  'network.proxy.no_proxies_on': '',
  'media.peerconnection.ice.proxy_only': true,
  'network.http.http3.enable': false,
  'network.dns.disablePrefetch': true,
  'network.predictor.enabled': false,
};

const INSTALL = {
  chromium: 'npx playwright install chromium',
  patchright: 'npm install patchright@1.64.1 && npx patchright install chromium',
  camoufox: 'npm install camoufox-js@0.13.0 && npx camoufox-js fetch',
};

export class EngineUnavailableError extends Error {}

// What an operator has to do when Chromium refuses to start with its sandbox (CHROMIUM_SANDBOX=1, the default).
// Ubuntu 23.10+ restricts unprivileged user namespaces through AppArmor, which is what Chromium's namespace sandbox
// needs; the alternative is its setuid helper.
export const SANDBOX_HELP = [
  'Chromium could not start with its own sandbox. One of these has to be true on this host:',
  '  1. unprivileged user namespaces are allowed:',
  "     echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-apparmor-userns.conf && sudo sysctl --system",
  '  2. or an AppArmor profile grants "userns" to the browser binary (see docs/DEPLOY-SYSTEMD.md),',
  '  3. or the setuid helper next to the browser is root-owned and mode 4755, with CHROME_DEVEL_SANDBOX pointing at',
  '     it and NoNewPrivileges unset in the unit (see docs/DEPLOY-SYSTEMD.md).',
  'Running the browser unsandboxed is a deliberate choice: set CHROMIUM_SANDBOX=0 (logged at every start).',
].join('\n');

// Startup preflight for the Chromium family: start the browser the way sessions will and close it again, so a host
// where the sandbox cannot work is refused at startup instead of at the first session (explain() turns the failure
// into SANDBOX_HELP). Never falls back silently.
async function sandboxPreflight(bt, cfg) {
  if (!cfg.chromiumSandbox || process.platform !== 'linux') return;
  let b = null;
  try {
    b = await bt.launch({ headless: cfg.headless, args: CHROMIUM_ARGS, chromiumSandbox: true, timeout: 60_000 });
  } finally {
    await b?.close().catch(() => {});
  }
}

const missingModule = (e) => e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND';
const missingBinary = (e) => e?.binary || ['CamoufoxNotInstalled', 'FileNotFoundError'].includes(e?.constructor?.name) ||
  /Executable doesn't exist|camoufox fetch/i.test(String(e?.message || e));
// Chromium refusing to start because its sandbox cannot be set up on this host.
const sandboxFailure = (e) => /Chromium sandboxing failed|Failed to move to new namespace|chrome[-_]sandbox|SUID sandbox|setuid sandbox/i.test(String(e?.message || e));

// Rethrow launch failures caused by a missing install, or by an unusable sandbox, as a clear, actionable error.
function explain(name, e) {
  if (missingModule(e)) return new EngineUnavailableError(`engine ${name} is not installed — run: ${INSTALL[name]}`);
  if (missingBinary(e)) return new EngineUnavailableError(`engine ${name}: browser binary missing — run: ${INSTALL[name]}`);
  if (sandboxFailure(e)) return new EngineUnavailableError(`engine ${name}: ${SANDBOX_HELP}`);
  return e;
}

const defaultImporter = (spec) => import(spec);

const hostOs = () => ({ darwin: 'macos', win32: 'windows' })[process.platform] || 'linux';

// Each engine: { name, family, cdp, shared, tracker, load(), check(bt, cfg), open(bt, {cfg, dir, locale, timezone,
// shared, media}) -> {ctx, browser?} }. media ({args, env}, meetings only, Chromium family): extra browser flags and the
// environment of a browser process of its own (its audio server). proxy: the tenant's forward proxy (host allowlist),
// or null. shared: ephemeral sessions of tenants without a proxy are contexts of one shared browser (manager.getBrowser);
// every other session is a persistent context in a directory Bosun owns (a profile or a temp dir), so its browser
// processes can be found by that directory. tracker: how the password tracker gets into Bosun's evaluation world
// ('init' script, or 'navigate': evaluate after every frame navigation). check: throws if the browser binary is absent.
const exists = (exe) => { if (!exe || !fs.existsSync(exe)) throw Object.assign(new Error(`Executable doesn't exist at ${exe}`), { binary: true }); };
function definitions(importer) {
  return {
    chromium: {
      name: 'chromium', family: 'chromium', cdp: true, shared: true, tracker: 'init',
      async load() { return (await importer('playwright')).chromium; },
      // Headless runs use Playwright's separate headless shell, whose path the API doesn't expose: checked at launch.
      async check(bt, cfg) { if (!cfg.headless) exists(bt.executablePath()); await sandboxPreflight(bt, cfg); },
      launchShared: (bt, cfg) => bt.launch({ headless: cfg.headless, args: CHROMIUM_ARGS, chromiumSandbox: cfg.chromiumSandbox }),
      async open(bt, { cfg, dir, locale, timezone, shared, media, proxy }) {
        const o = { viewport: { width: 1366, height: 900 }, locale, timezoneId: timezone, acceptDownloads: cfg.downloads, ...(proxy ? { proxy } : {}) };
        if (dir) applyWebrtcPolicy(dir, !!proxy);
        if (dir) return { ctx: await bt.launchPersistentContext(dir, { headless: cfg.headless, chromiumSandbox: cfg.chromiumSandbox, args: chromiumArgs(proxy, media?.args || []), ...(media?.env ? { env: media.env } : {}), ...o }) };
        const browser = await shared();
        return { ctx: await browser.newContext(o), browser };
      },
    },
    patchright: {
      name: 'patchright', family: 'chromium', cdp: true, shared: false, tracker: 'navigate',
      async load() { return (await importer('patchright')).chromium; },
      async check(bt, cfg) { exists(bt.executablePath()); await sandboxPreflight(bt, cfg); },
      // Recommended patchright setup: persistent context, no custom UA/headers, no automation-flag args, the
      // browser's own window size (viewport: null).
      async open(bt, { cfg, dir, locale, timezone, media, proxy }) {
        applyWebrtcPolicy(dir, !!proxy);
        const ctx = await bt.launchPersistentContext(dir, {
          channel: 'chromium', headless: cfg.headless, viewport: null, locale, timezoneId: timezone,
          args: ['--window-size=1366,900', ...(proxy ? PROXY_ARGS : []), ...(media?.args || [])],
          chromiumSandbox: cfg.chromiumSandbox, acceptDownloads: cfg.downloads, ...(proxy ? { proxy } : {}),
          ...(media?.env ? { env: media.env } : {}),
        });
        return { ctx };
      },
    },
    camoufox: {
      name: 'camoufox', family: 'firefox', cdp: false, shared: false, tracker: 'init',
      async load() {
        const [{ launchOptions }, { firefox }] = await Promise.all([importer('camoufox-js'), importer('playwright')]);
        return { launchOptions, firefox };
      },
      async check({ launchOptions }) { exists((await launchOptions({ headless: true })).executablePath); },
      // Fingerprint (window, screen, fonts, UA) comes from Camoufox (viewport: null keeps Playwright out of it); the
      // OS matches the host unless CAMOUFOX_OS says otherwise, so fonts and rendering stay consistent with the claimed
      // platform. humanize stays off: with Playwright 1.64 its cursor patch makes actionability checks hang.
      // A proxied tenant's Firefox gets the proxy and PROXY_FIREFOX_PREFS (PROXY_ARGS are Chromium flags).
      async open({ launchOptions, firefox }, { cfg, dir, locale, timezone, proxy }) {
        const opts = await launchOptions({ headless: cfg.headless, os: cfg.camoufoxOs || hostOs(), locale, humanize: false });
        const prefs = proxy ? { firefoxUserPrefs: { ...opts.firefoxUserPrefs, ...PROXY_FIREFOX_PREFS } } : {};
        return { ctx: await firefox.launchPersistentContext(dir, { ...opts, ...prefs, viewport: null, timezoneId: timezone, acceptDownloads: cfg.downloads, ...(proxy ? { proxy } : {}) }) };
      },
    },
  };
}

export function createEngines({ importer = defaultImporter, overrides = {} } = {}) {
  const defs = { ...definitions(importer), ...overrides };
  const loaded = new Map(); // name -> Promise<browserType>
  const get = (name) => {
    const def = defs[name];
    if (!def) throw new EngineUnavailableError(`unknown engine ${name} (known: ${ENGINE_NAMES.join(', ')})`);
    return def;
  };
  const load = (name) => {
    const def = get(name);
    if (!loaded.has(name)) {
      const p = def.load().catch((e) => { loaded.delete(name); throw explain(name, e); });
      loaded.set(name, p);
    }
    return loaded.get(name);
  };
  return {
    get,
    load,
    // Package and browser binary present? (startup preflight of the default engine)
    async check(name, cfg) {
      const bt = await load(name);
      try { await get(name).check?.(bt, cfg); } catch (e) { throw explain(name, e); }
    },
    // Opens a context. Ephemeral sessions of non-shared engines, of meetings and of proxied tenants get a private temp
    // profile (tmpDir, removed on close): a proxied tenant's browser needs its own launch flags and profile
    // preferences (applyWebrtcPolicy: full Chromium ignores the WebRTC flag), so it never shares a browser.
    async open(name, { cfg, profileDir, locale, timezone, shared, media, proxy = null }) {
      const def = get(name);
      if (media && def.family !== 'chromium') throw new EngineUnavailableError(`meetings need a Chromium engine (chromium or patchright), not ${name}`);
      const bt = await load(name);
      let dir = profileDir, tmpDir = null;
      if (!dir && (!def.shared || media || proxy)) { // media, proxy: a browser process of its own
        tmpDir = dir = path.join(cfg.dataDir, 'tmp', `${name}-${crypto.randomBytes(6).toString('hex')}`);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      // The caller owns dir/tmpDir from here on, also on failure: a launch that timed out may have left processes.
      try {
        const r = await def.open(bt, { cfg, dir, locale, timezone, shared: () => shared(def, bt), media, proxy });
        return { ...r, dir: r.browser ? null : dir, tmpDir };
      } catch (e) {
        throw Object.assign(explain(name, e), { dir, tmpDir });
      }
    },
  };
}

const META = 'bosun-profile.json';
export function readProfileMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8')); } catch { return null; }
}

// After a successful open: remember the engine and mode (headless or not) the profile was last used with, so
// background work (keepalive) opens it the same way and its fingerprint stays consistent.
export function recordProfileUse(dir, { engine, headless }) {
  const meta = { ...(readProfileMeta(dir) || {}), engine, headless };
  const tmp = path.join(dir, `${META}.${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, META));
}

// Undo a fresh claim if nothing but the marker was written (the open failed before a browser touched the profile).
export function unclaimProfile(dir) {
  try { if (fs.readdirSync(dir).join() === 'bosun-profile.json') fs.rmSync(path.join(dir, 'bosun-profile.json')); } catch {}
}

// A persistent profile remembers which engine family created it; Chromium and Firefox profiles aren't interchangeable.
export function claimProfile(dir, def) {
  const meta = path.join(dir, 'bosun-profile.json');
  let family = 'chromium'; // profiles from before engines existed are Chromium profiles
  try { family = JSON.parse(fs.readFileSync(meta, 'utf8')).family || family; } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const fresh = fs.readdirSync(dir).length === 0;
    family = fresh ? def.family : 'chromium';
    fs.writeFileSync(meta, JSON.stringify({ family }), { mode: 0o600 });
    if (family === def.family) return fresh; // true: marker created for an empty profile (caller may roll it back)
  }
  if (family !== def.family) throw new Error(`profile was created with a ${family} engine; open it with engine ${family === 'firefox' ? 'camoufox' : 'chromium or patchright'}`);
}
