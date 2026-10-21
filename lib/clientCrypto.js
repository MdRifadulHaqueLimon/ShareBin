// Client-side AES-256-GCM for files going to R2. The browser encrypts BEFORE upload, so R2 only
// ever holds ciphertext. The one-off key travels via the server, which stores it inside the
// encrypted Redis record: when the share expires the key is gone and the object is unreadable
// even if it has not been swept from the bucket yet.
//
// Blob layout: [12-byte IV][ciphertext + 16-byte GCM tag]   (so stored size = file size + 28)
export const OVERHEAD = 28;

const subtle = () => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('Your browser cannot encrypt files here. Use HTTPS or a current browser.');
  return c;
};
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

export async function encryptFile(arrayBuffer) {
  const c = subtle();
  const key = await c.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = c.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer));
  const data = new Uint8Array(12 + ct.length);
  data.set(iv, 0); data.set(ct, 12);
  const raw = new Uint8Array(await c.subtle.exportKey('raw', key));
  return { data, key: toB64(raw) };
}

export async function decryptFile(arrayBuffer, keyB64) {
  const c = subtle();
  const bytes = new Uint8Array(arrayBuffer);
  const key = await c.subtle.importKey('raw', fromB64(keyB64), 'AES-GCM', false, ['decrypt']);
  try {
    return new Uint8Array(await c.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)));
  } catch {
    throw new Error('Could not decrypt this file. It may be damaged or expired.');
  }
}
