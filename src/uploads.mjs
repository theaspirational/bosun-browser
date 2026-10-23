// Files an agent puts into a web page (the upload tool). The bytes come in over a one-time HTTP PUT on the MCP port,
// streamed straight to BROWSER_DATA/uploads/<tenant>/<id>/<filename> (never buffered whole, never base64), or as a
// small base64 shortcut. Every lookup is by tenant: a file id of another tenant is "no such file". Files go away when
// the session that used them closes, an hour after they arrived, and all of them when the service starts.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';

export const BASE64_MAX_BYTES = 1024 * 1024;
const FILES_PER_TENANT = 50; // files a tenant holds at a time, in any state (waiting, arriving, ready)
const FILES_TOTAL = 500; // and across the service
const PUTS_PER_TENANT = 4; // PUTs streaming at once, per tenant
const PUTS_TOTAL = 16; // and across the service
const PUT_IDLE_MS = 60_000; // a PUT that sends nothing for this long is dropped
const PUT_MAX_MS = 60 * 60_000; // and none may take longer than an hour
const ID_RE = /^f[0-9a-f]{16}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

// A file name a page will see (File.name): the last path segment, no control characters, at most 200 bytes.
export function safeName(raw) {
  let n = String(raw ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').trim();
  while (Buffer.byteLength(n) > 200) n = n.slice(0, -1);
  if (!n || n === '.' || n === '..') throw new Error('filename must name a file (e.g. "report.pdf")');
  return n;
}

const mb = (n) => `${Math.round(n / 1024 / 1024)} MB`;

export class Uploads {
  constructor(cfg) {
    this.cfg = cfg;
    this.root = path.join(cfg.dataDir, 'uploads');
    this.files = new Map(); // id -> {id, tenant, name, dir, file, state: pending|receiving|ready, size, …}
    this.usage = new Map(); // tenant -> bytes on disk or arriving
    // Anything left here is from an earlier process: nobody holds a file id for it any more.
    fs.rmSync(this.root, { recursive: true, force: true });
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  used(tenant) { return this.usage.get(tenant) || 0; }
  count(tenant, state = null) { let n = 0; for (const f of this.files.values()) if (f.tenant === tenant && (!state || f.state === state)) n++; return n; }
  addUse(tenant, n) { this.usage.set(tenant, Math.max(0, this.used(tenant) + n)); }

  // Room left for a file of this tenant: the per-file cap and the tenant's quota, whichever is smaller.
  room(tenant) { return Math.max(0, Math.min(this.cfg.uploadMaxBytes, this.cfg.uploadQuotaBytes - this.used(tenant))); }

  // A new file slot. With content (a Buffer, the base64 shortcut) the file is written at once; without, it waits for
  // its PUT (secret in the URL) for UPLOAD_URL_TTL_SEC.
  async create(tenant, { filename, sizeBytes = null, content = null }) {
    if (this.closed) throw new Error('service is shutting down');
    const name = safeName(filename);
    const size = content ? content.length : sizeBytes;
    if (size !== null && size > this.cfg.uploadMaxBytes) throw new Error(`file is larger than the upload limit (${mb(this.cfg.uploadMaxBytes)}, UPLOAD_MAX_BYTES)`);
    if (size !== null && size > this.room(tenant)) throw new Error(`upload quota of this token is used up (${mb(this.used(tenant))} of ${mb(this.cfg.uploadQuotaBytes)} held; files are deleted when the session that used them closes, or after ${Math.round(this.cfg.uploadTtlMs / 60000)} min)`);
    if (this.files.size >= FILES_TOTAL) throw new Error(`the service holds ${FILES_TOTAL} uploads already; try again later`);
    if (this.count(tenant) >= FILES_PER_TENANT) {
      throw new Error(`this token holds ${FILES_PER_TENANT} uploads already (waiting, arriving or ready); close the sessions that used them, or let them expire`);
    }
    const id = `f${crypto.randomBytes(8).toString('hex')}`;
    const dir = path.join(this.root, tenant, id);
    const f = {
      id, tenant, name, dir, file: path.join(dir, name), state: 'pending', expected: sizeBytes, size: 0,
      secret: crypto.randomBytes(24).toString('base64url'), urlExpiresAt: Date.now() + this.cfg.uploadUrlTtlMs, expiresAt: null,
      sessions: new Set(), // sessions that put this file into a page; it is deleted when the last of them closes
    };
    this.files.set(id, f);
    if (!content) return f;
    try {
      this.addUse(tenant, content.length);
      f.state = 'receiving';
      f.size = content.length;
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(f.file, content, { mode: 0o600, flag: 'wx' });
      this.ready(f);
      return f;
    } catch (e) {
      await this.remove(f);
      throw e;
    }
  }

  ready(f) {
    f.state = 'ready';
    f.secret = null;
    f.expiresAt = Date.now() + this.cfg.uploadTtlMs;
    if (this.closed) this.remove(f);
  }

  // Same message for "never existed", "another tenant's" and "already deleted", so ids can't be probed.
  get(tenant, id) {
    const f = this.files.get(id);
    if (!f || f.tenant !== tenant || f.state === 'deleted') throw new Error(`no uploaded file ${String(id).slice(0, 40)} (deleted after use when its session closed, after ${Math.round(this.cfg.uploadTtlMs / 60000)} min, or on a service restart)`);
    if (f.state !== 'ready') throw new Error(`file ${id} has not arrived yet: PUT it first (curl -T from upload_create), then call upload`);
    return f;
  }

  // Paths for the page, and the session that is now using each file.
  use(tenant, ids, sessionId) {
    const files = ids.map((id) => this.get(tenant, id));
    for (const f of files) f.sessions.add(sessionId);
    return files;
  }

  // A session closed: its files go, unless a session still open used them as well.
  async sessionClosed(sessionId, isOpen) {
    for (const f of [...this.files.values()]) {
      if (!f.sessions.delete(sessionId)) continue;
      if (![...f.sessions].some(isOpen)) await this.remove(f);
    }
  }

  // The file is unusable at once; its bytes (quota) and its slot (file caps) are released only once the directory is
  // gone. A removal that fails is retried by the sweep.
  remove(f) {
    if (f.state !== 'deleted') {
      f.state = 'deleted';
      f.secret = null;
      f.abort?.();
    }
    f.removing ??= fs.promises.rm(f.dir, { recursive: true, force: true }).then(() => {
      if (this.files.get(f.id) !== f) return;
      this.files.delete(f.id);
      this.addUse(f.tenant, -f.size);
    }, (e) => {
      console.error(`bosun: upload ${f.id} of tenant ${f.tenant} not deleted yet (${e.code || e.message}); retrying`);
    }).finally(() => { f.removing = null; });
    return f.removing;
  }

  sweep(now = Date.now()) {
    for (const f of [...this.files.values()]) {
      if (f.state === 'deleted' || (f.state === 'pending' && now > f.urlExpiresAt) || (f.state === 'ready' && now > f.expiresAt)) this.remove(f);
    }
  }

  // PUT /upload/<id>?t=<secret>, or PUT /upload/<id> with the tenant's token in Authorization. Answers the request
  // itself; returns true when the path was ours. authTenant(req): the tenant of an Authorization header, null
  // without one, false for a token that doesn't authenticate. With both, both must hold.
  async handle(req, res, { authTenant, policyOf }) {
    const u = new URL(req.url, 'http://x');
    const m = /^\/upload\/([^/]+)$/.exec(u.pathname);
    if (!m) return false;
    const reply = (code, body) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(code, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(body) + '\n');
      req.resume(); // drain whatever the client still sends (bounded by the socket close)
    };
    if (req.method !== 'PUT') { reply(405, { error: 'PUT only' }); return true; }
    const f = ID_RE.test(m[1]) ? this.files.get(m[1]) : null;
    const secret = u.searchParams.get('t');
    const okSecret = secret === null || (!!f?.secret && Buffer.byteLength(secret) === f.secret.length && crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(f.secret)));
    const hdr = authTenant(req);
    if (secret === null && !hdr) { reply(401, { error: 'give the URL from upload_create (with ?t=), or your token in Authorization: Bearer' }); return true; }
    if (!f || !okSecret || f.state !== 'pending' || Date.now() > f.urlExpiresAt) { reply(404, { error: 'no such upload URL (used, expired, or never issued); call upload_create again' }); return true; }
    if (hdr === false || (hdr !== null && hdr !== f.tenant)) { reply(403, { error: 'this token may not upload to that URL' }); return true; }
    if (policyOf(f.tenant) === 'ephemeral') { reply(403, { error: 'uploads are not allowed for this token' }); return true; }
    const len = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : null;
    if (len !== null && (!Number.isSafeInteger(len) || len < 0)) { reply(400, { error: 'bad Content-Length' }); return true; }
    if (f.expected !== null && len !== null && len !== f.expected) { reply(400, { error: `size_bytes was ${f.expected}, the request has ${len}` }); return true; }
    if (len !== null && len > this.cfg.uploadMaxBytes) { reply(413, { error: `file is larger than the upload limit (${mb(this.cfg.uploadMaxBytes)}, UPLOAD_MAX_BYTES)` }); return true; }
    if (len !== null && len > this.room(f.tenant)) { reply(413, { error: `upload quota of this token is used up (${mb(this.cfg.uploadQuotaBytes)}, UPLOAD_TENANT_QUOTA_BYTES)` }); return true; }
    if (req.headers.expect && !/^100-continue$/i.test(req.headers.expect)) { reply(417, { error: 'unsupported Expect' }); return true; }
    // Too many at once: the URL stays valid, try again shortly.
    if (this.count(f.tenant, 'receiving') >= PUTS_PER_TENANT || [...this.files.values()].filter((x) => x.state === 'receiving').length >= PUTS_TOTAL) {
      reply(429, { error: `too many uploads in progress (${PUTS_PER_TENANT} per token, ${PUTS_TOTAL} in all); retry this URL in a moment` });
      return true;
    }

    // The URL is spent from here on: a second PUT, even while this one runs, gets 404.
    f.state = 'receiving';
    f.secret = null;
    if (req.headers.expect) res.writeContinue();
    // Too many bytes: answer 413 at once and close the connection once the answer is out; nothing more is written.
    let received = 0, over = null;
    const refuse = (why) => {
      over = why;
      if (res.headersSent) return req.socket?.destroy();
      res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: why }) + '\n', () => req.socket?.destroy());
    };
    const counter = new Transform({
      transform: (chunk, _enc, cb) => {
        if (f.state !== 'receiving') return cb(new Error('upload was cancelled')); // its bytes are being released
        if (over) return cb();
        received += chunk.length;
        if (f.expected !== null && received > f.expected) refuse(`more bytes than size_bytes (${f.expected})`);
        else if (received > this.cfg.uploadMaxBytes) refuse(`file is larger than the upload limit (${mb(this.cfg.uploadMaxBytes)}, UPLOAD_MAX_BYTES)`);
        else if (this.used(f.tenant) + chunk.length > this.cfg.uploadQuotaBytes) refuse(`upload quota of this token is used up (${mb(this.cfg.uploadQuotaBytes)}, UPLOAD_TENANT_QUOTA_BYTES)`);
        if (over) return cb();
        this.addUse(f.tenant, chunk.length);
        f.size = received;
        cb(null, chunk);
      },
    });
    const ac = new AbortController();
    f.abort = () => ac.abort();
    req.setTimeout(PUT_IDLE_MS, () => ac.abort());
    const deadline = setTimeout(() => ac.abort(), PUT_MAX_MS);
    try {
      await fs.promises.mkdir(f.dir, { recursive: true, mode: 0o700 });
      await pipeline(req, counter, fs.createWriteStream(f.file, { mode: 0o600, flags: 'wx' }), { signal: ac.signal });
      if (over) throw new Error(over);
      if (f.state !== 'receiving') throw new Error('upload was cancelled');
      if (f.expected !== null && received !== f.expected) throw Object.assign(new Error(`size_bytes was ${f.expected}, received ${received}`), { status: 400 });
      this.ready(f);
      reply(201, { file_id: f.id, filename: f.name, size: received, next: `call upload with file_id ${f.id}` });
    } catch (e) {
      await this.remove(f);
      if (over) { if (!res.writableEnded) refuse(over); }
      else if (e.status === 400) reply(400, { error: e.message });
      else if (!req.socket?.destroyed) reply(400, { error: 'upload interrupted; call upload_create again' });
    } finally {
      clearTimeout(deadline);
      f.abort = null;
    }
    return true;
  }

  async close() {
    this.closed = true;
    clearInterval(this.sweeper);
    await Promise.allSettled([...this.files.values()].map((f) => this.remove(f)));
    await Promise.race([fs.promises.rm(this.root, { recursive: true, force: true }).catch(() => {}), sleep(5000)]);
  }
}

