// Storage adapter: Upstash Redis (REST, no SDK needed) in production,
// in-memory Map with TTL when env vars are missing (local dev / tests).
const mem = new Map();
const zsets = new Map();   // name -> Map(member -> score), in-memory sorted sets
const live = (k) => {
  const e = mem.get(k);
  if (!e) return null;
  if (e.exp <= Date.now()) { mem.delete(k); return null; }
  return e;
};
const remote = () => {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
};
async function cmd(r, args) {
  const res = await fetch(r.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    cache: 'no-store',
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

export const store = {
  isRemote: () => !!remote(),
  // SET key value EX ttl NX -> true if created
  async setNX(k, v, ttl) {
    const r = remote();
    if (r) return (await cmd(r, ['SET', k, v, 'EX', ttl, 'NX'])) === 'OK';
    if (live(k)) return false;
    mem.set(k, { v, exp: Date.now() + ttl * 1000 });
    return true;
  },
  async get(k) {
    const r = remote();
    if (r) return cmd(r, ['GET', k]);
    return live(k)?.v ?? null;
  },
  async getdel(k) {
    const r = remote();
    if (r) return cmd(r, ['GETDEL', k]);
    const e = live(k);
    mem.delete(k);
    return e?.v ?? null;
  },
  async ttl(k) {
    const r = remote();
    if (r) return cmd(r, ['TTL', k]);
    const e = live(k);
    return e ? Math.ceil((e.exp - Date.now()) / 1000) : -2;
  },
  async incr(k, ttl) {
    const r = remote();
    if (r) {
      const n = await cmd(r, ['INCR', k]);
      if (n === 1) await cmd(r, ['EXPIRE', k, ttl]);
      return n;
    }
    const e = live(k);
    const n = (e ? Number(e.v) : 0) + 1;
    mem.set(k, { v: String(n), exp: e ? e.exp : Date.now() + ttl * 1000 });
    return n;
  },
  // Sorted set, used as the cleanup queue for R2 objects (score = delete-after timestamp in ms)
  async zadd(k, score, member) {
    const r = remote();
    if (r) { await cmd(r, ['ZADD', k, score, member]); return; }
    if (!zsets.has(k)) zsets.set(k, new Map());
    zsets.get(k).set(member, score);
  },
  async zrangeByScore(k, max, limit) {
    const r = remote();
    if (r) return cmd(r, ['ZRANGEBYSCORE', k, '-inf', max, 'LIMIT', 0, limit]);
    return [...(zsets.get(k) ?? [])].filter(([, sc]) => sc <= max).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([m]) => m);
  },
  async zrem(k, member) {
    const r = remote();
    if (r) { await cmd(r, ['ZREM', k, member]); return; }
    zsets.get(k)?.delete(member);
  },
};
