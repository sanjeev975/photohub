'use strict';

/**
 * POST /api/pay
 *   { action: "request", plan, utr, contact }  user says "I paid" with the UPI reference (UTR)
 *   { action: "restore", utr, contact }        re-link an approved subscription to a new browser
 *
 * Nothing here ever grants access. Only the owner can approve a request (api/admin.js)
 * after checking the money arrived in their own bank account.
 * Disabled (404) until PAYMENTS_ENABLED=1 and a UPI QR (UPI_QR_PATH) or UPI_ID are set.
 */

const A = require('../lib/access');

const MAX_DEVICES_PER_LICENSE = 3;

module.exports = async function handler(req, res) {
  try {
    const ctx = await A.prelude(req, res, { method: 'POST', issueCookie: false });
    if (ctx.done) return;
    if (ctx.off || !ctx.cfg.paymentsEnabled || !(ctx.cfg.upiId || ctx.cfg.upiQrPath)) return A.send(res, 404, { error: 'Not available' });

    let body;
    try { body = await A.readJson(req, 2048); } catch (e) {
      return A.send(res, e && e.code === 'TOO_LARGE' ? 413 : 400, { error: 'Bad request' });
    }
    if (!A.isPlainObject(body) || (body.action !== 'request' && body.action !== 'restore')) {
      return A.send(res, 400, { error: 'Bad request' });
    }

    const { store, deviceId, ipHash } = ctx;
    const scope = body.action;
    const [ipn, dn] = await Promise.all([
      A.hit(store, A.k('rl', scope, 'i', ipHash), 3600),
      A.hit(store, A.k('rl', scope, 'd', deviceId), 86400),
    ]);
    if (ipn > 10 || dn > 12) {
      return A.send(res, 429, { error: 'Too many attempts. Please try again later.' }, { 'Retry-After': '3600' });
    }

    const utr = A.normalizeUtr(body.utr);
    const contact = A.normalizeContact(body.contact);
    if (!utr) return A.send(res, 422, { error: 'Enter the UPI reference (UTR) from your payment app: 10 to 24 letters/numbers.' });
    if (!contact) return A.send(res, 422, { error: 'Enter a valid 10-digit mobile number or an email address.' });

    // ---------------------------------------------------------- request
    if (body.action === 'request') {
      const plan = typeof body.plan === 'string' && Object.prototype.hasOwnProperty.call(A.PLANS, body.plan) ? A.PLANS[body.plan] : null;
      if (!plan) return A.send(res, 422, { error: 'Please choose a plan.' });

      // One payment waiting at a time (prevents duplicate / conflicting requests), and a sane cap on stacked packs
      const mine = await store.pipeline([['SMEMBERS', A.k('dev', deviceId, 'pend')]]).then((r) => r[0] || []);
      if (mine.length) {
        const recs = await store.pipeline(mine.slice(0, 20).map((u) => ['GET', A.k('pay', u)]));
        if (recs.some((r) => { const x = r ? A.safeParse(r) : null; return x && x.status === 'pending'; })) {
          return A.send(res, 409, { error: 'You already have a payment waiting for approval. Please wait until it is confirmed before adding another pack.' });
        }
      }
      const curLic = await A.loadLicense(store, deviceId);
      if (curLic && curLic.exp > Date.now() && (Array.isArray(curLic.packs) ? curLic.packs.filter((x) => x.end > Date.now()).length : 1) >= 6) {
        return A.send(res, 409, { error: 'You already have the maximum number of packs queued. Please use some of them first.' });
      }

      const rec = {
        utr, plan: plan.id, price: plan.price, contact,
        deviceId, ipHash, status: 'pending', createdAt: Date.now(),
      };
      const created = (await store.pipeline([['SET', A.k('pay', utr), JSON.stringify(rec), 'NX']]))[0];
      if (created !== 'OK') {
        return A.send(res, 409, { error: 'This UPI reference was already submitted. If it is yours, use "Restore access".' });
      }
      await store.pipeline([
        ['SADD', A.k('pay', 'pending'), utr],
        ['LPUSH', A.k('pay', 'recent'), utr],
        ['LTRIM', A.k('pay', 'recent'), '0', '199'],
        ['SADD', A.k('dev', deviceId, 'pend'), utr],
      ]);
      return A.send(res, 200, { ok: true, ...(await A.buildStatus(ctx)) });
    }

    // ---------------------------------------------------------- restore
    const generic = { error: 'Those details did not match an approved payment.' };
    const raw = (await store.pipeline([['GET', A.k('pay', utr)]]))[0];
    const rec = raw ? A.safeParse(raw) : null;
    if (!rec || rec.status !== 'approved' || !A.safeEqual(rec.contact, contact)) {
      return A.send(res, 404, generic);
    }
    const lic = await A.loadLicense(store, rec.deviceId);
    if (!lic || lic.id !== rec.licId) return A.send(res, 404, generic);

    const devices = lic.devices || [];
    if (!devices.includes(deviceId)) {
      if (devices.length >= MAX_DEVICES_PER_LICENSE) {
        return A.send(res, 409, { error: `This subscription is already active on ${MAX_DEVICES_PER_LICENSE} browsers. Contact support to reset.` });
      }
      devices.push(deviceId);
      await store.pipeline([['SET', A.k('lic', lic.id), JSON.stringify({ exp: lic.exp, plan: lic.plan, packs: lic.packs, devices, created: lic.created })]]);
    }
    await store.pipeline([['SET', A.k('dev', deviceId, 'lic'), lic.id]]);
    return A.send(res, 200, { ok: true, ...(await A.buildStatus(ctx)) });
  } catch (e) {
    console.error('[pay] error', e && e.message);
    return A.send(res, 503, { error: 'Something went wrong. Please try again.' });
  }
};
