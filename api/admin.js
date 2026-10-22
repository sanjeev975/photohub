'use strict';

/**
 * POST /api/admin   (owner only)   Authorization: Bearer <ADMIN_TOKEN>
 *   { action: "list" }                    pending + recent payment requests
 *   { action: "approve", utr }            activate the plan (extends if already subscribed)
 *   { action: "reject",  utr, reason }    decline a request
 *   { action: "revoke",  utr }            cancel ONE payment (only its unused time is removed)
 *
 * Invisible (404) unless PAYMENTS_ENABLED=1 and ADMIN_TOKEN (24+ chars) are set.
 * Wrong tokens are rate-limited per IP.
 */

const A = require('../lib/access');
const { getConfig } = require('../lib/config');
const { getStore } = require('../lib/store');

module.exports = async function handler(req, res) {
  A.baseHeaders(res);
  res.setHeader('X-Robots-Tag', 'noindex');
  try {
    if (req.method !== 'POST') return A.send(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });

    const cfg = getConfig();
    const store = cfg.enabled && cfg.secret.length >= 32 ? getStore() : null;
    if (!store || !cfg.paymentsEnabled || cfg.adminToken.length < 24) return A.send(res, 404, { error: 'Not found' });

    const { clientIp, hmac } = require('../lib/http');
    const ipHash = hmac(cfg.secret, 'ip:' + clientIp(req)).slice(0, 24);
    const failKey = A.k('rl', 'adminfail', ipHash);

    const failures = Number((await store.pipeline([['GET', failKey]]))[0] || 0);
    if (failures >= 8) return A.send(res, 429, { error: 'Too many attempts. Try again later.' }, { 'Retry-After': '900' });

    const auth = String((req.headers || {}).authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !A.safeEqual(token, cfg.adminToken)) {
      await A.hit(store, failKey, 900);
      return A.send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }

    let body;
    try { body = await A.readJson(req, 2048); } catch (e) { return A.send(res, 400, { error: 'Bad request' }); }
    if (!A.isPlainObject(body)) return A.send(res, 400, { error: 'Bad request' });

    if (body.action === 'list') {
      return A.send(res, 200, { ok: true, plans: A.PLANS, ...(await A.listPayments(store)) });
    }
    if (body.action === 'approve' || body.action === 'reject') {
      const utr = A.normalizeUtr(body.utr);
      if (!utr) return A.send(res, 422, { error: 'Invalid reference' });
      const out = body.action === 'approve'
        ? await A.approvePayment(store, utr)
        : await A.rejectPayment(store, utr, body.reason);
      if (out.error) return A.send(res, out.status || 400, { error: out.error });
      return A.send(res, 200, { ok: true, ...(await A.listPayments(store)) });
    }
    if (body.action === 'revoke') {
      if (typeof body.utr === 'string') {
        const utr = A.normalizeUtr(body.utr);
        if (!utr) return A.send(res, 422, { error: 'Invalid reference' });
        const out = await A.revokePayment(store, utr);
        if (out.error) return A.send(res, out.status || 400, { error: out.error });
        return A.send(res, 200, { ok: true, ...(await A.listPayments(store)) });
      }
      // revoke everything for a license (kept for completeness)
      if (typeof body.licId !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(body.licId)) return A.send(res, 422, { error: 'Invalid license' });
      const out = await A.revokeLicense(store, body.licId);
      if (out.error) return A.send(res, out.status || 400, { error: out.error });
      return A.send(res, 200, { ok: true });
    }
    return A.send(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error('[admin] error', e && e.message);
    return A.send(res, 500, { error: 'Server error' });
  }
};
