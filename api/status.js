'use strict';

/**
 * GET /api/status
 * Tells the page how many free exports are left and whether a subscription is active.
 * Also issues the signed device cookie on the first visit.
 * If the feature is not configured, answers { enabled: false } and the app runs normally.
 */

const A = require('../lib/access');

module.exports = async function handler(req, res) {
  try {
    const ctx = await A.prelude(req, res, { method: 'GET', issueCookie: true });
    if (ctx.done) return;
    if (ctx.off) return A.send(res, 200, { enabled: false });

    const n = await A.hit(ctx.store, A.k('rl', 'status', ctx.ipHash), 60);
    if (n > 120) return A.send(res, 429, { error: 'Too many requests' }, { 'Retry-After': '60' });

    return A.send(res, 200, await A.buildStatus(ctx));
  } catch (e) {
    console.error('[status] error', e && e.message);
    // Never block the app because of a back-end hiccup
    return A.send(res, 200, { enabled: false, unavailable: true });
  }
};
