# ShareBin

Share code, text or a file (up to 10 MB) with a 5-character code. It deletes itself after 1 to 10 minutes. No accounts.

Stack: Next.js 14 (App Router), Tailwind, Framer Motion, Monaco Editor, Upstash Redis, Cloudflare R2.

## Run locally
```bash
npm install
npm test          # backend tests, no network needed
npm run dev       # http://localhost:3000
```
Copy `.env.example` to `.env.local` and fill it in. With no Upstash variables the server keeps data in memory (fine for dev, resets on restart).

## Environment variables
| Variable | Purpose |
|---|---|
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Redis database (share records, rate limits, cleanup queue) |
| `SERVER_SECRET` | Key for AES-256-GCM and IP hashing. Use 32+ random characters. Changing it makes live shares unreadable |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2, for files up to 10 MB |

`.env.local` is git-ignored and is **not** read by Vercel. Add the same variables in Vercel under Settings -> Environment Variables. The secrets are read from `process.env` only and are never written into source code.

## Set up Cloudflare R2 (files up to 10 MB)
1. Cloudflare dashboard -> R2 -> **Create bucket** (for example `sharebin`).
2. R2 -> **Manage R2 API Tokens** -> create a token with *Object Read & Write* for that bucket. Copy the Access Key ID and Secret. Your Account ID is on the R2 overview page.
3. Bucket -> Settings -> **CORS policy**. The browser uploads and downloads directly, so this is required:
```json
[
  {
    "AllowedOrigins": ["https://your-domain.com", "http://localhost:3000"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```
4. Bucket -> Settings -> **Object lifecycle rules**: delete objects after 1 day. This is only a safety net (see "Cleanup" below).
5. Put the four `R2_*` values in `.env.local` and in Vercel.

## How it works
**Text and code**: `POST /api/share` encrypts the content (AES-256-GCM) and stores it in Redis with `SET ... EX ttl NX`, which gives auto-delete and collision-free codes.

**Files** (3 steps, the file bytes never pass through the Next.js server):
1. `POST /api/upload {name, mime, size}` checks the 10 MB limit and returns a presigned R2 upload URL.
2. The browser encrypts the file with a one-off AES-256-GCM key (Web Crypto) and `PUT`s the ciphertext straight to R2, with a progress bar.
3. `POST /api/share {type:'file', key, k, ttl}` makes the server confirm the object exists and has the declared size (+28 bytes for IV and tag), then stores the file key inside the encrypted Redis record and returns the code.

`GET /api/fetch/:code` returns a short-lived presigned download URL plus the file key. The receiver's browser downloads and decrypts. R2 only ever holds ciphertext, and when the Redis record expires the key is gone, so the file is unreadable even before it is deleted from the bucket.

**Without R2 configured**, files up to 700 KB still work (stored inline, encrypted, in Redis). Bigger files get a clear message that R2 is required.

**Language detection**: `lib/detect.js` runs in the browser as you type and shows tags such as `[HTML] [CSS] [JS]`. The server runs the same code to validate the result. There is no language dropdown.

**Codes**: 5 characters, always at least one uppercase letter, lowercase letter, digit and symbol (`@#$!*?+=&_-`), for example `2Y@xG`. Look-alikes (`I O l o 0 1`) are left out. Codes are case-sensitive. About 204 million combinations; the lookup rate limit (60 per minute per IP) slows guessing. Share links URL-encode the code, so symbols such as `#` and `?` are safe.

**Other**: "Delete after the first view" uses `GETDEL`, so only one reader can get it. Rate limits: 20 shares, 20 uploads and 60 lookups per minute per IP, using only a salted hash of the IP for 60 seconds.

## Cleanup of R2 objects
Redis expires records by itself, but it cannot delete R2 objects. Each object is queued in a Redis sorted set with its delete time, and every upload request deletes up to 3 due objects. Abandoned uploads are queued for 15 minutes. After a "delete after first view" read, the object is queued for 2 minutes later. The 1-day lifecycle rule catches anything left over on a quiet site.

## Tests
`npm test` runs 43 tests: code generator, encryption, language detection (including a speed check), the R2 request signer (checked against AWS's published test vector), and the full file flow against a simulated R2 bucket.
