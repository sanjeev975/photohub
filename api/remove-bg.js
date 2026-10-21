'use strict';

/**
 * POST /api/remove-bg
 *
 * Secure proxy to remove.bg. The API key exists ONLY in the Vercel environment
 * variable REMOVE_BG_API_KEY and is never sent to the browser.
 *
 * Protections (in order):
 *   1. POST only, no CORS headers (same-origin use only)
 *   2. Origin / Sec-Fetch-Site must be this site
 *   3. Per-IP rate limit (Upstash/Vercel KV if configured, in-memory fallback)
 *   4. Optional Cloudflare Turnstile human check (TURNSTILE_SECRET_KEY)
 *   5. Hard body-size cap, content-type check, real image magic-byte check
 *   6. Global daily budget cap (DAILY_CAP) so cost can never run away
 *   7. Fixed upstream parameters (client cannot choose size/format/colour)
 *   8. Generic error messages; upstream errors / keys / images are never logged or echoed
 *
 * Environment variables (Vercel -> Project -> Settings -> Environment Variables):
 *   REMOVE_BG_API_KEY          (required)  your remove.bg key
 *   ALLOWED_ORIGINS            (optional)  comma list, e.g. https://photos.example.com
 *   RATE_LIMIT_PER_IP          (optional)  default 6 requests ...
 *   RATE_LIMIT_WINDOW_SEC      (optional)  ... per 600 seconds
 *   DAILY_CAP                  (optional)  default 150 requests per UTC day, all users
 *   REMOVEBG_SIZE              (optional)  auto | regular | preview (default auto)
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (or KV_REST_API_URL / KV_REST_API_TOKEN)
 *   TURNSTILE_SECRET_KEY       (optional)  enables the human check
 *   RATE_LIMIT_SALT            (optional)  random string used to hash IPs
 */

const crypto = require('crypto');

const MAX_BODY_BYTES = 4 * 1024 * 1024;          // Vercel function body limit is 4.5 MB
const MAX_RESPONSE_BYTES = 4.4 * 1024 * 1024;    // Vercel response limit is 4.5 MB
const UPSTREAM_TIMEOUT_MS = 25000;
const ALLOWED_SIZES = new Set(['auto', 'regular', 'preview']);

// ---------- small helpers ----------

function intEnv(name, fallback, min, max) {
  const n = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function setBaseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res, status, message, extraHeaders) {
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  const body = Buffer.from(JSON.stringify({ error: message }));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

function allowedOrigins() {
  const set = new Set();
  const add = (v) => {
    if (!v) return;
    try {
      const u = new URL(v.startsWith('http') ? v : `https://${v}`);
      set.add(u.origin);
    } catch (_) { /* ignore malformed entries */ }
  };
  (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).forEach(add);
  add(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  add(process.env.VERCEL_URL);
  add(process.env.VERCEL_BRANCH_URL);
  if (process.env.VERCEL_ENV !== 'production') {
    set.add('http://localhost:3000');
    set.add('http://127.0.0.1:3000');
  }
  return set;
}

function clientIp(req) {
  const h = req.headers || {};
  // x-vercel-forwarded-for / x-real-ip are set by Vercel's edge and cannot be spoofed by the client
  const raw = h['x-vercel-forwarded-for'] || h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0]
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  return String(raw).split(',')[0].trim().slice(0, 64);
}

function hashKey(value) {
  const salt = process.env.RATE_LIMIT_SALT || process.env.REMOVE_BG_API_KEY || 'static-salt';
  return crypto.createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 32);
}

function detectImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return { mime: 'image/png', ext: 'png' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return; // keep draining so we can still send a response
      size += chunk.length;
      if (size > max) {
        failed = true;
        const err = new Error('too large');
        err.code = 'TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!failed) { failed = true; reject(e); } });
  });
}

// ---------- rate limiting ----------

const memory = new Map(); // fallback only: per-instance, resets on cold start

function memoryHit(key, windowSec) {
  const now = Date.now();
  if (memory.size > 5000) {
    for (const [k, v] of memory) if (v.reset <= now) memory.delete(k);
    if (memory.size > 5000) memory.clear();
  }
  let entry = memory.get(key);
  if (!entry || entry.reset <= now) {
    entry = { count: 0, reset: now + windowSec * 1000 };
    memory.set(key, entry);
  }
  entry.count += 1;
  return { count: entry.count, retryAfter: Math.max(1, Math.ceil((entry.reset - now) / 1000)) };
}

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    if (new URL(url).protocol !== 'https:') return null;
  } catch (_) { return null; }
  return { url: url.replace(/\/+$/, ''), token };
}

async function hit(key, windowSec) {
  const cfg = redisConfig();
  if (!cfg) return { ...memoryHit(key, windowSec), shared: false };
  const resp = await fetch(`${cfg.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['INCR', key], ['EXPIRE', key, String(windowSec), 'NX']]),
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
  });
  if (!resp.ok) throw new Error('rate-limit store error');
  const json = await resp.json();
  const count = Number(json && json[0] && json[0].result);
  if (!Number.isFinite(count)) throw new Error('rate-limit store bad reply');
  return { count, retryAfter: windowSec, shared: true };
}

// ---------- Turnstile (optional) ----------

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // feature disabled
  if (!token || typeof token !== 'string' || token.length > 4096) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (ip && ip !== 'unknown') form.set('remoteip', ip);
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!resp.ok) return false;
  const data = await resp.json();
  return data && data.success === true;
}

// ---------- handler ----------

module.exports = async function handler(req, res) {
  setBaseHeaders(res);

  try {
    // 1. Method
    if (req.method !== 'POST') {
      return sendJson(res, 405, 'Method not allowed', { Allow: 'POST' });
    }

    const apiKey = process.env.REMOVE_BG_API_KEY;
    if (!apiKey) {
      console.error('[remove-bg] REMOVE_BG_API_KEY is not configured');
      return sendJson(res, 503, 'Background removal is temporarily unavailable.');
    }

    // 2. Same-origin only
    const headers = req.headers || {};
    const origin = headers.origin;
    if (!origin || !allowedOrigins().has(origin)) {
      return sendJson(res, 403, 'Forbidden');
    }
    const fetchSite = headers['sec-fetch-site'];
    if (fetchSite && fetchSite !== 'same-origin') {
      return sendJson(res, 403, 'Forbidden');
    }

    // 5a. Content type + declared length (cheap checks before doing any work)
    const contentType = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/octet-stream') {
      return sendJson(res, 415, 'Unsupported media type');
    }
    const declared = parseInt(headers['content-length'] || '', 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return sendJson(res, 413, 'Photo is too large. Please use a smaller photo.');
    }

    // 3. Per-IP rate limit
    const ip = clientIp(req);
    const ipLimit = intEnv('RATE_LIMIT_PER_IP', 6, 1, 1000);
    const windowSec = intEnv('RATE_LIMIT_WINDOW_SEC', 600, 10, 86400);
    try {
      const r = await hit(`rbg:ip:${hashKey(ip)}`, windowSec);
      if (r.count > ipLimit) {
        return sendJson(res, 429, 'Too many requests. Please wait a few minutes and try again.', {
          'Retry-After': String(r.retryAfter),
        });
      }
    } catch (e) {
      console.error('[remove-bg] rate limiter unavailable');
      return sendJson(res, 503, 'Background removal is temporarily unavailable.'); // fail closed
    }

    // 4. Optional human verification
    try {
      const ok = await verifyTurnstile(String(headers['x-turnstile-token'] || ''), ip);
      if (!ok) return sendJson(res, 403, 'Human verification failed. Please try again.');
    } catch (e) {
      console.error('[remove-bg] turnstile unavailable');
      return sendJson(res, 503, 'Background removal is temporarily unavailable.');
    }

    // 5b. Read body with hard cap, verify real image content
    let body;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (e) {
      if (e && e.code === 'TOO_LARGE') return sendJson(res, 413, 'Photo is too large. Please use a smaller photo.');
      return sendJson(res, 400, 'Could not read the upload.');
    }
    const kind = detectImage(body);
    if (!kind) return sendJson(res, 415, 'Unsupported image. Please use a JPG, PNG or WebP photo.');

    // 6. Global daily budget cap
    const dailyCap = intEnv('DAILY_CAP', 150, 1, 100000);
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    try {
      const d = await hit(`rbg:day:${day}`, 90000);
      if (d.count > dailyCap) {
        return sendJson(res, 429, 'The free daily limit has been reached. Please try again tomorrow.', {
          'Retry-After': '3600',
        });
      }
    } catch (e) {
      console.error('[remove-bg] daily cap store unavailable');
      return sendJson(res, 503, 'Background removal is temporarily unavailable.');
    }

    // 7. Fixed upstream parameters
    const size = ALLOWED_SIZES.has(process.env.REMOVEBG_SIZE) ? process.env.REMOVEBG_SIZE : 'auto';
    const form = new FormData();
    form.append('image_file', new Blob([body], { type: kind.mime }), `photo.${kind.ext}`);
    form.append('size', size);
    form.append('type', 'person');
    form.append('format', 'jpg');
    form.append('bg_color', 'ffffff');

    let upstream;
    try {
      upstream = await fetch('https://api.remove.bg/v1.0/removebg', {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey },
        body: form,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (e) {
      console.error('[remove-bg] upstream unreachable');
      return sendJson(res, 502, 'Background removal service did not respond. Please try again.');
    }

    // 8. Generic errors only
    if (!upstream.ok) {
      console.error(`[remove-bg] upstream status ${upstream.status}`);
      if (upstream.status === 429) return sendJson(res, 429, 'Service is busy. Please try again shortly.', { 'Retry-After': '30' });
      if (upstream.status === 400) return sendJson(res, 422, 'Could not find a person in this photo.');
      if (upstream.status === 402 || upstream.status === 403) return sendJson(res, 503, 'Background removal is temporarily unavailable.');
      return sendJson(res, 502, 'Background removal failed. Please try again.');
    }

    const upstreamType = String(upstream.headers.get('content-type') || '').toLowerCase();
    if (!/^image\/(jpeg|png)/.test(upstreamType)) {
      return sendJson(res, 502, 'Background removal failed. Please try again.');
    }
    const out = Buffer.from(await upstream.arrayBuffer());
    if (out.length < 500 || out.length > MAX_RESPONSE_BYTES) {
      return sendJson(res, 502, 'Background removal failed. Please try again.');
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', upstreamType.startsWith('image/png') ? 'image/png' : 'image/jpeg');
    res.setHeader('Content-Length', String(out.length));
    return res.end(out);
  } catch (e) {
    console.error('[remove-bg] unexpected error');
    return sendJson(res, 500, 'Something went wrong. Please try again.');
  }
};

// Exposed for unit tests only
module.exports._internals = { detectImage, memory };
