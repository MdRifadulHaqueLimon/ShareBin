import test from 'node:test';
import assert from 'node:assert/strict';
import { createShare, createUpload, fetchShare, makeCode, validCode, normCode, encrypt, decrypt, LIMITS } from '../lib/service.js';
import { store } from '../lib/store.js';

const ip = () => 'ip-' + Math.random();
const share = (o, i = ip()) => createShare({ type: 'text', content: 'hello', ttl: 120, ...o }, i);

// ---------------------------------------------------------------- codes
test('codes: 5 chars, always upper + lower + digit + symbol, case-sensitive, mostly unique', () => {
  const s = new Set();
  for (let i = 0; i < 5000; i++) {
    const c = makeCode();
    assert.equal(c.length, 5, c);
    assert.ok(validCode(c), c);
    assert.match(c, /[A-Z]/, c); assert.match(c, /[a-z]/, c); assert.match(c, /\d/, c); assert.match(c, /[@#$!*?+=&_-]/, c);
    assert.doesNotMatch(c, /[IOlo01%]/, c);
    s.add(c);
  }
  assert.ok(s.size > 4950);
});

test('codes: every position and every character class gets used (no positional bias)', () => {
  const pos = [0, 1, 2, 3, 4].map(() => ({ u: 0, l: 0, d: 0, s: 0 }));
  for (let i = 0; i < 4000; i++) [...makeCode()].forEach((ch, p) => {
    if (/[A-Z]/.test(ch)) pos[p].u++; else if (/[a-z]/.test(ch)) pos[p].l++; else if (/\d/.test(ch)) pos[p].d++; else pos[p].s++;
  });
  for (const p of pos) for (const k of ['u', 'l', 'd', 's']) assert.ok(p[k] > 200, JSON.stringify(pos));
});

test('codes: the examples from the spec are valid; bad ones are not; URL-encoded form decodes', () => {
  for (const c of ['2Y@xG', 'gK#7v']) assert.ok(validCode(c), c);
  for (const c of ['', 'abc', '2Y@xGz', 'O0I1l', '2Y%xG', '../x/y', '2Y xG']) assert.ok(!validCode(c), c);
  assert.equal(normCode(encodeURIComponent('gK#7v')), 'gK#7v');
  assert.equal(normCode('2Y@xG'), '2Y@xG');
  assert.equal(normCode('%E0%A4%A'), '%E0%A4%A');   // malformed escape does not throw
});

// ---------------------------------------------------------------- crypto + storage
test('AES-256-GCM roundtrip, random IV, tamper detection', () => {
  const a = encrypt('secret ✓'), b = encrypt('secret ✓');
  assert.notEqual(a, b);
  assert.equal(decrypt(a), 'secret ✓');
  const buf = Buffer.from(a, 'base64'); buf[buf.length - 1] ^= 1;
  assert.throws(() => decrypt(buf.toString('base64')));
});

test('stored value is encrypted at rest', async () => {
  const r = await share({ content: 'PLAINTEXT-MARKER' });
  const raw = await store.get(`s:${r.json.code}`);
  assert.ok(!raw.includes('PLAINTEXT-MARKER'));
});

// ---------------------------------------------------------------- text / code
test('code snippet: language is detected automatically, survives repeated reads, code is case-sensitive', async () => {
  const html = '<!DOCTYPE html><html><head><style>body { margin: 0; }</style></head><body><p>hi</p><script>const a = 1; console.log(a);</script></body></html>';
  const r = await share({ type: 'code', content: html });
  assert.equal(r.status, 200);
  assert.ok(validCode(r.json.code));
  for (let i = 0; i < 2; i++) {
    const f = await fetchShare(r.json.code, ip());
    assert.equal(f.status, 200);
    assert.equal(f.json.content, html);
    assert.deepEqual(f.json.langs, ['html', 'css', 'javascript']);
    assert.equal(f.json.lang, 'html');
    assert.ok(f.json.ttl > 0 && f.json.ttl <= 120);
  }
  const swapped = r.json.code.replace(/[a-zA-Z]/, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));
  assert.equal((await fetchShare(swapped, ip())).status, 404);          // different case = different code
});

test('code snippet: a client-supplied lang is honoured only if it is a known language', async () => {
  const ok = await share({ type: 'code', content: 'print("hi")', lang: 'python' });
  assert.equal((await fetchShare(ok.json.code, ip())).json.lang, 'python');
  const bad = await share({ type: 'code', content: 'const a = 1; console.log(a);', lang: '<script>', langs: ['evil', 'css'] });
  const f = (await fetchShare(bad.json.code, ip())).json;
  assert.equal(f.lang, 'javascript');
  assert.deepEqual(f.langs, ['css']);                                    // unknown ids filtered, known ones kept
});

test('URL-encoded code works for fetch (symbols like # and @ in links)', async () => {
  let r, code;
  for (let i = 0; i < 200; i++) { r = await share({}); code = r.json.code; if (/[#$&+=?@]/.test(code)) break; }
  const f = await fetchShare(encodeURIComponent(code), ip());
  assert.equal(f.status, 200, code);
});

// ---------------------------------------------------------------- inline file fallback (R2 not configured)
test('without R2: files up to 700 KB use the inline path, bigger ones get a clear error', async () => {
  assert.equal((await createUpload({ name: 'a.png', mime: 'image/png', size: 500_000 }, ip())).json.mode, 'inline');
  const big = await createUpload({ name: 'a.mp4', mime: 'video/mp4', size: 5 * 1024 * 1024 }, ip());
  assert.equal(big.status, 413);
  assert.match(big.json.error, /R2/);
  const data = Buffer.from('PNGDATA').toString('base64');
  const r = await share({ type: 'file', content: data, name: 'a/b"c.png', mime: 'image/png' });
  const f = await fetchShare(r.json.code, ip());
  assert.equal(f.json.mime, 'image/png');
  assert.equal(f.json.name, 'a_b_c.png');
  assert.equal(Buffer.from(f.json.content, 'base64').toString(), 'PNGDATA');
});

test('upload size limit is 10 MB everywhere', async () => {
  assert.equal(LIMITS.maxFileBytes, 10 * 1024 * 1024);
  for (const size of [10 * 1024 * 1024 + 1, 50_000_000]) assert.equal((await createUpload({ size }, ip())).status, 413);
  for (const size of [0, -1, 1.5, 'x', null]) assert.equal((await createUpload({ size }, ip())).status, 400, String(size));
});

// ---------------------------------------------------------------- behaviour kept from before
test('burn-after-read: second fetch is 404, and it is atomic under concurrent reads', async () => {
  const r = await share({ burn: true });
  assert.equal((await fetchShare(r.json.code, ip())).status, 200);
  assert.equal((await fetchShare(r.json.code, ip())).status, 404);
  const r2 = await share({ burn: true });
  const res = await Promise.all(Array.from({ length: 10 }, () => fetchShare(r2.json.code, ip())));
  assert.equal(res.filter((x) => x.status === 200).length, 1);
});

test('data disappears after TTL expires', async () => {
  const r = await share({ ttl: 60 });
  const real = Date.now;
  Date.now = () => real() + 61_000;
  try {
    assert.equal((await fetchShare(r.json.code, ip())).status, 404);
    assert.equal(await store.get(`s:${r.json.code}`), null);
  } finally { Date.now = real; }
});

test('expiry must be 1-10 minutes', async () => {
  for (const ttl of [59, 601, 0, -5, 'x', 90.5, null]) assert.equal((await share({ ttl })).status, 400, String(ttl));
  for (const ttl of [60, 600]) assert.equal((await share({ ttl })).status, 200, String(ttl));
});

test('validation: bad type, empty, oversize, bad base64, bad codes', async () => {
  assert.equal((await share({ type: 'zip' })).status, 400);
  assert.equal((await share({ content: '' })).status, 400);
  assert.equal((await share({ content: 'x'.repeat(LIMITS.maxText + 1) })).status, 413);
  assert.equal((await share({ type: 'file', content: '***' })).status, 400);
  const big = Buffer.alloc(LIMITS.maxInlineBytes + 1).toString('base64');
  assert.equal((await share({ type: 'file', content: big })).status, 413);
  for (const c of ['', 'ABC', 'ABCDEF', 'O0I1L', '../x', '2Y%xG']) assert.equal((await fetchShare(c, ip())).status, 400, c);
  assert.equal((await fetchShare('Zz@9k', ip())).status, 404);
});

test('rate limits: 20 shares/min and 60 fetches/min per IP, other IPs unaffected', async () => {
  const a = ip();
  for (let i = 0; i < LIMITS.shareRate; i++) assert.equal((await share({}, a)).status, 200);
  assert.equal((await share({}, a)).status, 429);
  assert.equal((await share({}, ip())).status, 200);
  const b = ip();
  for (let i = 0; i < LIMITS.fetchRate; i++) assert.equal((await fetchShare('Zz@9k', b)).status, 404);
  assert.equal((await fetchShare('Zz@9k', b)).status, 429);
});

test('Upstash adapter sends correct REST commands (incl. sorted-set cleanup queue)', async () => {
  const calls = [], realFetch = globalThis.fetch;
  process.env.UPSTASH_REDIS_REST_URL = 'https://x.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  globalThis.fetch = async (url, o) => {
    const body = JSON.parse(o.body); calls.push({ url, auth: o.headers.Authorization, body });
    return { json: async () => ({ result: body[0] === 'INCR' ? 1 : body[0] === 'SET' ? 'OK' : body[0] === 'ZRANGEBYSCORE' ? [] : 1 }) };
  };
  try {
    const r = await share({ ttl: 300 });
    assert.equal(r.status, 200);
    const set = calls.find((c) => c.body[0] === 'SET');
    assert.deepEqual(set.body.slice(0, 1).concat(set.body.slice(3)), ['SET', 'EX', 300, 'NX']);
    assert.ok(set.body[1].startsWith('s:'));
    assert.equal(set.auth, 'Bearer tok');
    assert.ok(calls.some((c) => c.body[0] === 'EXPIRE'));
    await store.zadd('q', 123, 'm'); await store.zrangeByScore('q', 200, 3); await store.zrem('q', 'm');
    assert.deepEqual(calls.find((c) => c.body[0] === 'ZADD').body, ['ZADD', 'q', 123, 'm']);
    assert.deepEqual(calls.find((c) => c.body[0] === 'ZRANGEBYSCORE').body, ['ZRANGEBYSCORE', 'q', '-inf', 200, 'LIMIT', 0, 3]);
    assert.deepEqual(calls.find((c) => c.body[0] === 'ZREM').body, ['ZREM', 'q', 'm']);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});
