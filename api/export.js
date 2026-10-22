'use strict';

/**
 * POST /api/export   { fp: "<32 hex photo-set fingerprint>", kind: "pdf|png|jpeg|single" }
 * Asks permission to export. Same photo set again = free. A changed picture uses one trial.
 *   200 { ok: true, ...status }                 export allowed
 *   402 { code: TRIALS_EXHAUSTED|NETWORK_LIMIT } trial used up, subscription needed
 *   429 / 503                                   rate limited / back end unavailable (client lets the user continue)
 */

const A = require('../lib/access');

module.exports = async function handler(req, res) {
  try {
    const ctx = await A.prelude(req, res, { method: 'POST', issueCookie: false });
    if (ctx.done) return;
    if (ctx.off) return A.send(res, 200, { ok: true, enabled: false });

    let body;
    try { body = await A.readJson(req, 2048); } catch (e) {
      return A.send(res, e && e.code === 'TOO_LARGE' ? 413 : 400, { error: 'Bad request' });
    }
    if (!A.isPlainObject(body) || typeof body.fp !== 'string' || !A.FP_RE.test(body.fp) || !A.KINDS.has(body.kind)) {
      return A.send(res, 400, { error: 'Bad request' });
    }

    const [dn, ipn] = await Promise.all([
      A.hit(ctx.store, A.k('rl', 'exp', 'd', ctx.deviceId), 60),
      A.hit(ctx.store, A.k('rl', 'exp', 'i', ctx.ipHash), 60),
    ]);
    if (dn > 40 || ipn > 150) return A.send(res, 429, { error: 'Too many requests. Please wait a moment.' }, { 'Retry-After': '30' });

    const result = await A.consumeExport(ctx, body.fp);
    const status = await A.buildStatus(ctx);

    if (result.code === 'OK') {
      return A.send(res, 200, { ok: true, repeat: !!result.repeat, ...status });
    }
    const message = result.code === 'NETWORK_LIMIT'
      ? 'Free trials from this network are used up.'
      : 'Your free trials are used up.';
    return A.send(res, 402, { ok: false, code: result.code, error: message, ...status });
  } catch (e) {
    console.error('[export] error', e && e.message);
    return A.send(res, 503, { error: 'Usage check unavailable' });
  }
};
