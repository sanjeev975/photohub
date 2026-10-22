'use strict';

/**
 * Tiny key-value store.
 *   - Production: Upstash Redis (free tier) through its REST API.
 *       Vercel -> Storage -> Upstash Redis adds UPSTASH_REDIS_REST_URL / _TOKEN
 *       (or KV_REST_API_URL / KV_REST_API_TOKEN) automatically.
 *   - Local tests only: in-memory store, enabled with TRIAL_STORE=memory.
 * Only the handful of Redis commands this app needs are used.
 */

const { getConfig } = require('./config');

// ---------------- in-memory (tests / local dev) ----------------
class MemoryStore {
  constructor() { this.m = new Map(); }

  _live(key) {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.x && e.x <= Date.now()) { this.m.delete(key); return undefined; }
    return e;
  }

  run(cmd) {
    const op = String(cmd[0]).toUpperCase();
    const a = cmd.slice(1).map(String);
    switch (op) {
      case 'GET': { const e = this._live(a[0]); return e ? e.v : null; }
      case 'SET': {
        const nx = a.slice(2).some((x) => x.toUpperCase() === 'NX');
        if (nx && this._live(a[0])) return null;
        const exIdx = a.findIndex((x, i) => i >= 2 && x.toUpperCase() === 'EX');
        const x = exIdx > 0 ? Date.now() + parseInt(a[exIdx + 1], 10) * 1000 : 0;
        this.m.set(a[0], { v: a[1], x });
        return 'OK';
      }
      case 'DEL': { const had = !!this._live(a[0]); this.m.delete(a[0]); return had ? 1 : 0; }
      case 'INCR': case 'DECR': {
        const e = this._live(a[0]);
        const n = (e ? parseInt(e.v, 10) : 0) + (op === 'INCR' ? 1 : -1);
        this.m.set(a[0], { v: String(n), x: e ? e.x : 0 });
        return n;
      }
      case 'EXPIRE': {
        const e = this._live(a[0]);
        if (!e) return 0;
        if (a[2] && a[2].toUpperCase() === 'NX' && e.x) return 0;
        e.x = Date.now() + parseInt(a[1], 10) * 1000;
        return 1;
      }
      case 'SADD': {
        let e = this._live(a[0]);
        if (!e) { e = { v: new Set(), x: 0 }; this.m.set(a[0], e); }
        let added = 0;
        for (const member of a.slice(1)) if (!e.v.has(member)) { e.v.add(member); added++; }
        return added;
      }
      case 'SREM': {
        const e = this._live(a[0]);
        if (!e) return 0;
        let n = 0;
        for (const member of a.slice(1)) if (e.v.delete(member)) n++;
        return n;
      }
      case 'SISMEMBER': { const e = this._live(a[0]); return e && e.v.has(a[1]) ? 1 : 0; }
      case 'SMEMBERS': { const e = this._live(a[0]); return e ? Array.from(e.v) : []; }
      case 'SCARD': { const e = this._live(a[0]); return e ? e.v.size : 0; }
      case 'LPUSH': {
        let e = this._live(a[0]);
        if (!e) { e = { v: [], x: 0 }; this.m.set(a[0], e); }
        for (const member of a.slice(1)) e.v.unshift(member);
        return e.v.length;
      }
      case 'LTRIM': {
        const e = this._live(a[0]);
        if (e) e.v = e.v.slice(parseInt(a[1], 10), parseInt(a[2], 10) + 1);
        return 'OK';
      }
      case 'LRANGE': {
        const e = this._live(a[0]);
        return e ? e.v.slice(parseInt(a[1], 10), parseInt(a[2], 10) + 1) : [];
      }
      default:
        throw new Error('unsupported command ' + op);
    }
  }

  async pipeline(cmds) { return cmds.map((c) => this.run(c)); }
}

// ---------------- Upstash Redis (production) ----------------
class RedisStore {
  constructor(url, token) { this.url = url.replace(/\/+$/, ''); this.token = token; }

  async pipeline(cmds) {
    const resp = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds.map((c) => c.map(String))),
      signal: AbortSignal.timeout(4000),
      redirect: 'error',
    });
    if (!resp.ok) throw new Error('store http ' + resp.status);
    const json = await resp.json();
    if (!Array.isArray(json)) throw new Error('store bad reply');
    return json.map((r) => {
      if (r && r.error) throw new Error('store cmd error');
      return r ? r.result : null;
    });
  }
}

let memorySingleton = null;

/** Returns a store, or null when none is configured (the app then runs ungated, never broken). */
function getStore() {
  const cfg = getConfig();
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) {
    try {
      if (new URL(url).protocol === 'https:') return new RedisStore(url, token);
    } catch (_) { /* fall through */ }
  }
  if (cfg.allowMemoryStore) {
    if (!memorySingleton) memorySingleton = new MemoryStore();
    return memorySingleton;
  }
  return null;
}

function resetMemoryStore() { memorySingleton = null; }

module.exports = { getStore, resetMemoryStore };
