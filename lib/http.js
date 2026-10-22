'use strict';

const crypto = require('crypto');

function baseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function send(res, status, payload, extra) {
  if (extra) for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

/** Same-origin check for state-changing requests (CSRF defence). */
function sameOrigin(req) {
  const h = req.headers || {};
  const origin = h.origin;
  if (!origin) return false;
  let host;
  try { host = new URL(origin).host; } catch (_) { return false; }
  const reqHost = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  if (!reqHost || host !== reqHost) return false;
  const site = h['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  return true;
}

async function readJson(req, maxBytes) {
  const max = maxBytes || 8 * 1024;
  const declared = parseInt((req.headers || {})['content-length'] || '', 10);
  if (Number.isFinite(declared) && declared > max) {
    const e = new Error('too large'); e.code = 'TOO_LARGE'; throw e;
  }
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8'));
    if (typeof req.body === 'string') return JSON.parse(req.body);
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { const e = new Error('too large'); e.code = 'TOO_LARGE'; reject(e); return; }
      chunks.push(c);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function clientIp(req) {
  const h = req.headers || {};
  // Set by Vercel's edge, cannot be forged by the visitor
  const raw = h['x-vercel-forwarded-for'] || h['x-real-ip']
    || String(h['x-forwarded-for'] || '').split(',')[0]
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  return String(raw).split(',')[0].trim().slice(0, 64);
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/** Increment a counter and report how many hits happened in this window. */
async function hit(store, key, windowSec) {
  const r = await store.pipeline([['INCR', key], ['EXPIRE', key, String(windowSec), 'NX']]);
  return Number(r[0]);
}

module.exports = { baseHeaders, send, sameOrigin, readJson, isPlainObject, clientIp, hmac, safeEqual, hit };
