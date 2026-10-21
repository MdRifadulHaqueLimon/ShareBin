import { NextResponse } from 'next/server';
import { createUpload } from '../../../lib/service.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Step 1 of a file share: validates size and returns a presigned Cloudflare R2 upload URL,
// so the browser sends the file straight to storage instead of through this server.
export async function POST(req) {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const r = await createUpload(body, ip);
  return NextResponse.json(r.json, { status: r.status, headers: { 'Cache-Control': 'no-store' } });
}
