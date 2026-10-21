// End-to-end file flow against a fake Cloudflare R2 bucket (no network).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createShare, createUpload, fetchShare, LIMITS } from '../lib/service.js';
import { encryptFile, decryptFile } from '../lib/clientCrypto.js';
import { store } from '../lib/store.js';

globalThis.crypto ??= webcrypto;
const ip = () => 'ip-' + Math.random();
const bucket = new Map();                 // object key -> Uint8Array
const calls = [];
const realFetch = globalThis.fetch;
const keyOf = (url) => new URL(url).pathname.replace('/sharebin/', '');

before(() => {
  Object.assign(process.env, { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AK', R2_SECRET_ACCESS_KEY: 'SK', R2_BUCKET: 'sharebin' });
  globalThis.fetch = async (url, o = {}) => {
    const u = String(url);
    if (!u.includes('r2.cloudflarestorage.com')) return realFetch(url, o);
    const k = keyOf(u); calls.push([o.method, k]);
    if (o.method === 'HEAD') return bucket.has(k) ? { ok: true, status: 200, headers: { get: () => String(bucket.get(k).length) } } : { ok: false, status: 404 };
    if (o.method === 'DELETE') { bucket.delete(k); return { ok: true, status: 204 }; }
    if (o.method === 'GET') return bucket.has(k) ? { ok: true, status: 200, arrayBuffer: async () => bucket.get(k).buffer } : { ok: false, status: 404 };
    throw new Error('unexpected ' + o.method);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) delete process.env[k];
});

// what the browser does: ask for a URL, encrypt, PUT
async function browserUpload(plain, meta = {}) {
  const up = await createUpload({ name: 'pic.png', mime: 'image/png', size: plain.length, ...meta }, ip());
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.mode, 'r2');
  const { data, key } = await encryptFile(plain.buffer);
  bucket.set(up.json.key, data);                           // the PUT to the presigned URL
  return { up: up.json, k: key };
}

test('10 MB file: upload URL -> encrypted PUT -> share -> fetch -> decrypt', async () => {
  const plain = new Uint8Array(LIMITS.maxFileBytes).map((_, i) => (i * 7) % 256);
  const { up, k } = await browserUpload(plain);
  assert.match(up.uploadUrl, /^https:\/\/acct\.r2\.cloudflarestorage\.com\/sharebin\/u\/[0-9a-f]{32}\?X-Amz-Algorithm=/);
  assert.match(up.uploadUrl, /X-Amz-Signature=[0-9a-f]{64}$/);

  const r = await createShare({ type: 'file', key: up.key, k, ttl: 300 }, ip());
  assert.equal(r.status, 200);
  const f = await fetchShare(r.json.code, ip());
  assert.equal(f.status, 200);
  assert.equal(f.json.storage, 'r2');
  assert.equal(f.json.name, 'pic.png'); assert.equal(f.json.mime, 'image/png'); assert.equal(f.json.size, plain.length);
  assert.ok(!('key' in f.json) && !('content' in f.json), 'bucket key and bytes must not be returned');
  assert.match(f.json.url, /X-Amz-Signature=/);

  const res = await realFetchLike(f.json.url);                // the browser GET
  assert.deepEqual(await decryptFile(res, f.json.k), plain);
});
const realFetchLike = async (url) => (await globalThis.fetch(url, { method: 'GET' })).arrayBuffer();

test('bucket holds ciphertext only, and Redis record does not contain the bytes or key in clear', async () => {
  const plain = new TextEncoder().encode('TOP-SECRET-MARKER'.repeat(50));
  const { up, k } = await browserUpload(plain);
  assert.ok(!Buffer.from(bucket.get(up.key)).includes('TOP-SECRET-MARKER'));
  const r = await createShare({ type: 'file', key: up.key, k, ttl: 120 }, ip());
  assert.ok(!(await store.get(`s:${r.json.code}`)).includes(k));
});

test('an upload can only be claimed once, and forged keys are rejected', async () => {
  const { up, k } = await browserUpload(new Uint8Array(1000));
  assert.equal((await createShare({ type: 'file', key: up.key, k, ttl: 120 }, ip())).status, 200);
  const again = await createShare({ type: 'file', key: up.key, k, ttl: 120 }, ip());
  assert.match(again.json.error, /expired/i);                                    // the claim is single-use
  for (const key of ['u/' + 'a'.repeat(32)]) assert.match((await createShare({ type: 'file', key, k, ttl: 120 }, ip())).json.error, /expired/i);   // well-formed but never issued
  for (const key of ['../etc/passwd', 'u/xyz', 5]) assert.match((await createShare({ type: 'file', key, k, ttl: 120 }, ip())).json.error, /Invalid upload/);
  const { up: up2 } = await browserUpload(new Uint8Array(1000));
  assert.match((await createShare({ type: 'file', key: up2.key, k: 'short', ttl: 120 }, ip())).json.error, /Invalid file key/);
});

test('size verification: object bigger than declared is rejected and deleted; missing object is rejected', async () => {
  const { key: k } = await encryptFile(new Uint8Array(5).buffer);
  const up = (await createUpload({ name: 'x.bin', size: 1000 }, ip())).json;
  bucket.set(up.key, new Uint8Array(1_000_000));              // client lied about the size
  const r = await createShare({ type: 'file', key: up.key, k, ttl: 120 }, ip());
  assert.equal(r.status, 400);
  assert.match(r.json.error, /size mismatch/i);
  assert.ok(!bucket.has(up.key), 'mismatched object must be deleted');

  const up2 = (await createUpload({ name: 'x.bin', size: 1000 }, ip())).json;   // never uploaded
  const r2 = await createShare({ type: 'file', key: up2.key, k, ttl: 120 }, ip());
  assert.equal(r2.status, 400);
  assert.match(r2.json.error, /did not finish uploading/i);

  const up3 = (await createUpload({ name: 'x.bin', size: 1000 }, ip())).json;
  bucket.set(up3.key, new Uint8Array(LIMITS.maxFileBytes + 5000));
  const r3 = await createShare({ type: 'file', key: up3.key, k, ttl: 120 }, ip());
  assert.equal(r3.status, 413);
  assert.match(r3.json.error, /10 MB/);
  assert.ok(!bucket.has(up3.key));
});

test('over 10 MB is refused before any upload URL is issued', async () => {
  const r = await createUpload({ name: 'big.mov', mime: 'video/quicktime', size: LIMITS.maxFileBytes + 1 }, ip());
  assert.equal(r.status, 413);
  assert.match(r.json.error, /10 MB/);
});

test('burn-after-read file: one reader gets the URL and key, the second gets 404', async () => {
  const { up, k } = await browserUpload(new Uint8Array(2000));
  const r = await createShare({ type: 'file', key: up.key, k, ttl: 300, burn: true }, ip());
  assert.equal((await fetchShare(r.json.code, ip())).status, 200);
  assert.equal((await fetchShare(r.json.code, ip())).status, 404);
});

test('expired shares: the R2 object is swept on a later request; fresh ones are kept', async () => {
  const a = await browserUpload(new Uint8Array(500));
  const shared = await createShare({ type: 'file', key: a.up.key, k: a.k, ttl: 60 }, ip());
  assert.equal(shared.status, 200);
  const b = await browserUpload(new Uint8Array(500));
  await createShare({ type: 'file', key: b.up.key, k: b.k, ttl: 600 }, ip());
  assert.ok(bucket.has(a.up.key));

  const real = Date.now;
  Date.now = () => real() + 200_000;                          // 60 s share (+60 s grace) is over, 600 s one is not
  try {
    await createUpload({ name: 'trigger.txt', size: 10 }, ip());   // any upload request runs the sweep
  } finally { Date.now = real; }
  assert.ok(!bucket.has(a.up.key), 'expired object should be deleted');
  assert.ok(bucket.has(b.up.key), 'live object must stay');
});

test('abandoned uploads (never shared) are swept after 15 minutes, a few objects per request', async () => {
  const up = (await createUpload({ name: 'x.bin', size: 100 }, ip())).json;
  bucket.set(up.key, new Uint8Array(128));
  const real = Date.now;
  Date.now = () => real() + 16 * 60_000;
  let requests = 0;
  try {
    while (bucket.has(up.key) && requests < 15) { await createUpload({ name: 'trigger.txt', size: 10 }, ip()); requests++; }
  } finally { Date.now = real; }
  assert.ok(!bucket.has(up.key), 'abandoned object should be deleted');
  assert.ok(requests < 15, 'backlog should drain');
});
