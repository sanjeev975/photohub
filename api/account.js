'use strict';

/**
 * GET /api/account   (owner-only credit check)
 *
 * Disabled (404) unless ADMIN_TOKEN is set in Vercel environment variables.
 * Usage:  curl -H "Authorization: Bearer <ADMIN_TOKEN>" https://your-site.vercel.app/api/account
 * Returns only the credit totals, never the raw account object or any key.
 * The website itself does NOT call this endpoint.
 */

const crypto = require('crypto');

function sendJson(res, status, payload, extra) {
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  if (extra) for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(body);
}

function tokensMatch(provided, expected) {
  // Hash both sides so lengths are equal, then compare in constant time
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  const adminToken = process.env.ADMIN_TOKEN;
  const apiKey = process.env.REMOVE_BG_API_KEY;

  // Hide the endpoint completely when not configured
  if (!adminToken || adminToken.length < 20 || !apiKey) {
    return sendJson(res, 404, { error: 'Not found' });
  }
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
  }

  const auth = String((req.headers && req.headers.authorization) || '');
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!provided || !tokensMatch(provided, adminToken)) {
    return sendJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
  }

  try {
    const upstream = await fetch('https://api.remove.bg/v1.0/account', {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (!upstream.ok) return sendJson(res, 502, { error: 'Upstream error' });
    const data = await upstream.json();
    const c = (data && data.data && data.data.attributes && data.data.attributes.credits) || {};
    return sendJson(res, 200, {
      total: Number(c.total) || 0,
      subscription: Number(c.subscription) || 0,
      payg: Number(c.payg) || 0,
    });
  } catch (_) {
    return sendJson(res, 502, { error: 'Upstream error' });
  }
};
