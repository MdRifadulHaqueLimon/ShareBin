// Cloudflare R2 over the S3 API, with no SDK: presigned URLs are plain AWS Signature V4
// (query-string auth). The browser PUTs the (already encrypted) file straight to R2 and later
// GETs it straight back, so file bytes never pass through the Next.js server.
import crypto from 'node:crypto';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
// RFC 3986 encoding as required by SigV4 (encodeURIComponent leaves !'()* alone)
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Generic SigV4 presigner (S3 query auth, host-only signed headers, unsigned payload). */
export function presignUrl({ method, host, path, accessKeyId, secretAccessKey, region, service = 's3', expires, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');           // 20130524T000000Z
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const query = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
  const canonicalPath = path.split('/').map(enc).join('/');
  const canonicalRequest = [method, canonicalPath, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, date), region), service), 'aws4_request');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  return `https://${host}${canonicalPath}?${query}&X-Amz-Signature=${signature}`;
}

function config() {
  const e = process.env;
  const c = { account: e.R2_ACCOUNT_ID, accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY, bucket: e.R2_BUCKET };
  if (!Object.values(c).every(Boolean)) return null;
  // EU / FedRAMP buckets use a different host, e.g. <account>.eu.r2.cloudflarestorage.com
  return { ...c, host: e.R2_ENDPOINT_HOST || `${c.account}.r2.cloudflarestorage.com` };
}

export const r2 = {
  enabled: () => !!config(),

  /** Presigned URL for PUT (browser upload), GET (browser download), HEAD or DELETE (server). */
  presign(method, key, expires = 300) {
    const c = config();
    if (!c) throw new Error('Cloudflare R2 is not configured');
    return presignUrl({ method, host: c.host, path: `/${c.bucket}/${key}`, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: 'auto', expires });
  },

  /** Size in bytes of the stored object, or null if it does not exist. */
  async head(key) {
    const res = await fetch(this.presign('HEAD', key, 60), { method: 'HEAD', cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 HEAD failed (${res.status})`);
    return Number(res.headers.get('content-length'));
  },

  /** Delete an object. Deleting something that is already gone counts as success. */
  async del(key) {
    const res = await fetch(this.presign('DELETE', key, 60), { method: 'DELETE', cache: 'no-store' });
    return res.ok || res.status === 404;
  },
};
