import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { encryptFile, decryptFile, OVERHEAD } from '../lib/clientCrypto.js';

globalThis.crypto ??= webcrypto;

test('encrypt/decrypt roundtrip, size overhead, key is 32 bytes', async () => {
  const plain = new Uint8Array(100_000).map((_, i) => i % 251);
  const { data, key } = await encryptFile(plain.buffer);
  assert.equal(data.length, plain.length + OVERHEAD);
  assert.equal(Buffer.from(key, 'base64').length, 32);
  assert.match(key, /^[A-Za-z0-9+/]{43}=$/);
  assert.deepEqual(await decryptFile(data.buffer, key), plain);
});

test('ciphertext differs per call; wrong key or tampering fails', async () => {
  const plain = new TextEncoder().encode('secret').buffer;
  const a = await encryptFile(plain), b = await encryptFile(plain);
  assert.notDeepEqual(a.data, b.data);
  await assert.rejects(decryptFile(a.data.buffer, b.key), /Could not decrypt/);
  const bad = a.data.slice(); bad[bad.length - 1] ^= 1;
  await assert.rejects(decryptFile(bad.buffer, a.key), /Could not decrypt/);
});

test('handles a 10 MB file quickly', async () => {
  const big = new Uint8Array(10 * 1024 * 1024);
  const t = performance.now();
  const { data, key } = await encryptFile(big.buffer);
  const out = await decryptFile(data.buffer, key);
  assert.equal(out.length, big.length);
  assert.ok(performance.now() - t < 2000);
});
