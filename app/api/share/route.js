import { NextResponse } from 'next/server';
import { createShare } from '../../../lib/service.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req) {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const r = await createShare(body, ip);
  return NextResponse.json(r.json, { status: r.status, headers: { 'Cache-Control': 'no-store' } });
}
