import crypto from 'node:crypto';
import { store } from './store.js';
import { r2 } from './r2.js';
import { detectLanguages, isLang } from './detect.js';
import { OVERHEAD } from './clientCrypto.js';

export const LIMITS = {
  minTtl: 60, maxTtl: 600,
  maxText: 200_000,
  maxFileBytes: 10 * 1024 * 1024,   // 10 MB, stored in Cloudflare R2
  maxInlineBytes: 700_000,          // fallback while R2 is not configured (Upstash request cap is 1 MB)
  shareRate: 20, fetchRate: 60, uploadRate: 20,   // per IP per minute
};
const SWEEP = 'r2:sweep';           // sorted set: R2 object key -> delete-after (ms)
const UPLOAD_URL_SECONDS = 300;     // presigned PUT/GET validity
const KEY_RE = /^u\/[0-9a-f]{32}$/;
const B64_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;   // 32 raw bytes

// ---- share codes -----------------------------------------------------------------------------
// 5 characters, always at least one uppercase, lowercase, digit and symbol, e.g. "2Y@xG", "gK#7v".
// Look-alikes are left out (I O l o 0 1). Codes are case-sensitive.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '@#$!*?+=&_-';      // no "%" (breaks URL decoding); all safe once URL-encoded
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;
const pick = (set) => set[crypto.randomInt(set.length)];

export function makeCode() {
  const c = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS), pick(ALL)];
  for (let i = c.length - 1; i > 0; i--) {            // Fisher-Yates with a CSPRNG
    const j = crypto.randomInt(i + 1);
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c.join('');
}
export const normCode = (c) => {
  let s = String(c ?? '').trim();
  try { s = decodeURIComponent(s); } catch { /* not URL-encoded */ }
  return s;
};
export const validCode = (c) => typeof c === 'string' && c.length === 5 && [...c].every((ch) => ALL.includes(ch));

// ---- crypto / helpers ------------------------------------------------------------------------
function secret() {
  const s = process.env.SERVER_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('SERVER_SECRET is not set');
  return 'dev-only-secret-not-for-production';
}
const aesKey = () => crypto.createHash('sha256').update(secret()).digest();

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function decrypt(b64) {
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// IP is only used as a salted hash for a 60s rate-limit counter. Never logged.
const ipKey = (scope, ip) =>
  `rl:${scope}:` + crypto.createHash('sha256').update(secret() + String(ip)).digest('hex').slice(0, 24);
async function limited(scope, ip, max) {
  return (await store.incr(ipKey(scope, ip), 60)) > max;
}
const err = (status, error) => ({ status, json: { error } });
const cleanName = (n) => String(n ?? '').replace(/[\\/\x00-\x1f"]/g, '_').slice(0, 120) || 'file';
const cleanMime = (m) => (/^[\w.+-]+\/[\w.+-]+$/.test(m ?? '') ? m : 'application/octet-stream');

/** Delete R2 objects whose share has expired (or whose upload was never finished). */
async function sweepExpired(limit = 3) {
  if (!r2.enabled()) return;
  try {
    const keys = await store.zrangeByScore(SWEEP, Date.now(), limit);
    await Promise.all(keys.map(async (key) => { if (await r2.del(key)) await store.zrem(SWEEP, key); }));
  } catch (e) {
    console.error('sweep failed:', e.message);
  }
}

// ---- step 1 of a file share: ask where to upload ---------------------------------------------
export async function createUpload(body, ip = 'unknown') {
  try {
    if (await limited('upload', ip, LIMITS.uploadRate)) return err(429, 'Too many requests. Wait a minute and try again.');
    if (!body || typeof body !== 'object') return err(400, 'Invalid request');
    const size = Number(body.size);
    if (!Number.isInteger(size) || size < 1) return err(400, 'That file is empty');
    if (size > LIMITS.maxFileBytes) return err(413, 'File is over the 10 MB limit');

    if (!r2.enabled()) {
      if (size > LIMITS.maxInlineBytes)
        return err(413, 'Large file storage is not set up on this server yet, so files are limited to 700 KB until Cloudflare R2 is configured.');
      return { status: 200, json: { mode: 'inline' } };
    }
    await sweepExpired();
    const key = 'u/' + crypto.randomBytes(16).toString('hex');
    await store.setNX(`up:${key}`, JSON.stringify({ name: cleanName(body.name), mime: cleanMime(body.mime), size }), 900);
    await store.zadd(SWEEP, Date.now() + 900_000, key);        // orphaned uploads get cleaned up too
    return { status: 200, json: { mode: 'r2', key, uploadUrl: r2.presign('PUT', key, UPLOAD_URL_SECONDS), maxBytes: LIMITS.maxFileBytes } };
  } catch (e) {
    console.error('createUpload failed:', e.message);
    return err(500, 'Server error');
  }
}

// ---- step 2: create the share and its code ---------------------------------------------------
export async function createShare(body, ip = 'unknown') {
  let uploadedKey = null;
  try {
    if (await limited('share', ip, LIMITS.shareRate)) return err(429, 'Too many requests. Wait a minute and try again.');
    if (!body || typeof body !== 'object') return err(400, 'Invalid request');
    const { type, content, name = '', mime = '', burn = false } = body;
    const ttl = Number(body.ttl);
    if (!Number.isInteger(ttl) || ttl < LIMITS.minTtl || ttl > LIMITS.maxTtl)
      return err(400, 'Expiry must be between 1 and 10 minutes');
    if (!['code', 'text', 'file'].includes(type)) return err(400, 'Unknown content type');

    const meta = { type, burn: !!burn };
    let payload;
    if (type === 'file' && body.key !== undefined) {
      // ---- R2: the browser already uploaded the encrypted file; verify it, then record it
      if (!r2.enabled()) return err(400, 'File storage is not configured');
      if (typeof body.key !== 'string' || !KEY_RE.test(body.key)) return err(400, 'Invalid upload');
      if (typeof body.k !== 'string' || !B64_KEY_RE.test(body.k)) return err(400, 'Invalid file key');
      uploadedKey = body.key;
      const pendingRaw = await store.getdel(`up:${body.key}`);              // single use
      if (!pendingRaw) { uploadedKey = null; return err(400, 'This upload expired. Choose the file and share again.'); }
      const pending = JSON.parse(pendingRaw);
      const actual = await r2.head(body.key);
      if (actual === null) return err(400, 'The file did not finish uploading. Try again.');
      if (actual > LIMITS.maxFileBytes + OVERHEAD) { await r2.del(body.key); uploadedKey = null; return err(413, 'File is over the 10 MB limit'); }
      if (actual !== pending.size + OVERHEAD) { await r2.del(body.key); uploadedKey = null; return err(400, 'Upload size mismatch. Try again.'); }
      Object.assign(meta, { storage: 'r2', key: body.key, k: body.k, name: pending.name, mime: pending.mime, size: pending.size });
      payload = meta;
    } else if (type === 'file') {
      // ---- inline fallback (no R2): base64 stored encrypted in Redis
      if (typeof content !== 'string' || !content.length) return err(400, 'Nothing to share');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content)) return err(400, 'File data is not valid base64');
      if (Buffer.byteLength(content, 'base64') > LIMITS.maxInlineBytes) return err(413, 'File is over the 700 KB limit');
      meta.name = cleanName(name);
      meta.mime = cleanMime(mime);
      payload = { ...meta, content };
    } else {
      if (typeof content !== 'string' || !content.length) return err(400, 'Nothing to share');
      if (content.length > LIMITS.maxText) return err(413, 'Text is over the 200,000 character limit');
      if (type === 'code') {
        // language comes from automatic detection; a valid client-side result is accepted as-is
        const det = detectLanguages(content);
        const langs = Array.isArray(body.langs) ? body.langs.filter(isLang).slice(0, 4) : det.langs;
        meta.lang = isLang(body.lang) ? body.lang : det.primary;
        meta.langs = langs.length ? langs : (meta.lang === 'plaintext' ? [] : [meta.lang]);
      } else {
        meta.lang = 'plaintext';
      }
      payload = { ...meta, content };
    }
    const raw = (burn ? 'B' : 'K') + encrypt(JSON.stringify(payload));

    for (let i = 0; i < 8; i++) {
      const code = makeCode();
      if (await store.setNX(`s:${code}`, raw, ttl)) {
        if (meta.key) await store.zadd(SWEEP, Date.now() + ttl * 1000 + 60_000, meta.key);   // delete the object shortly after expiry
        return { status: 200, json: { code, ttl } };
      }
    }
    if (uploadedKey) await r2.del(uploadedKey);
    return err(503, 'Could not allocate a code. Try again.');
  } catch (e) {
    console.error('createShare failed:', e.message);
    return err(500, 'Server error');
  }
}

export async function fetchShare(codeIn, ip = 'unknown') {
  try {
    if (await limited('fetch', ip, LIMITS.fetchRate)) return err(429, 'Too many attempts. Wait a minute and try again.');
    const code = normCode(codeIn);
    if (!validCode(code)) return err(400, 'Codes are 5 characters, like 2Y@xG');
    const key = `s:${code}`;
    let raw = await store.get(key);
    if (!raw) return err(404, 'Code not found. It may have expired.');
    const ttl = Math.max(0, await store.ttl(key));
    const burned = raw[0] === 'B';
    if (burned) {                                // burn after read: atomic delete
      raw = await store.getdel(key);
      if (!raw) return err(404, 'Code not found. It may have expired.');
    }
    const data = JSON.parse(decrypt(raw.slice(1)));
    if (data.storage === 'r2') {
      const { key: objectKey, ...rest } = data;
      if (burned) await store.zadd(SWEEP, Date.now() + 120_000, objectKey);   // gone two minutes after the single read
      return { status: 200, json: { ...rest, url: r2.presign('GET', objectKey, UPLOAD_URL_SECONDS), ttl } };
    }
    return { status: 200, json: { ...data, ttl } };
  } catch (e) {
    console.error('fetchShare failed:', e.message);
    return err(500, 'Server error');
  }
}
