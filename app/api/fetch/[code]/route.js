import { NextResponse } from 'next/server';
import { fetchShare } from '../../../../lib/service.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { params }) {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const r = await fetchShare(params.code, ip);
  return NextResponse.json(r.json, { status: r.status, headers: { 'Cache-Control': 'no-store' } });
}
