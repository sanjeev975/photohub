'use strict';

/**
 * Central configuration. Everything secret comes from Vercel environment variables.
 * Prices live HERE (server side) so a user can never change what they are charged.
 */

const PLANS = Object.freeze({
  m1: Object.freeze({ id: 'm1', label: '1 Month', months: 1, price: 99 }),
  m3: Object.freeze({ id: 'm3', label: '3 Months', months: 3, price: 259 }),
  m6: Object.freeze({ id: 'm6', label: '6 Months', months: 6, price: 499 }),
  m12: Object.freeze({ id: 'm12', label: '1 Year', months: 12, price: 699 }),
});

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name, fallback, min, max) {
  const n = parseInt(env(name, ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const UPI_ID_RE = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,30}$/;
const QR_PATH_RE = /^\/[A-Za-z0-9._-]{1,60}\.(png|jpg|jpeg|webp)$/i;

/** Read config fresh on every call so tests (and env changes on redeploy) always apply. */
function getConfig() {
  const upiId = env('UPI_ID', '');
  const qrPath = env('UPI_QR_PATH', '');
  return {
    enabled: env('TRIAL_ENABLED', '0') === '1',
    secret: env('TRIAL_SECRET', ''),
    trialLimit: int('TRIAL_LIMIT', 3, 1, 20),
    ipTrialLimit: int('TRIAL_IP_LIMIT', 12, 1, 500),
    allowMemoryStore: env('TRIAL_STORE', '') === 'memory',

    paymentsEnabled: env('PAYMENTS_ENABLED', '0') === '1',
    upiId: UPI_ID_RE.test(upiId) ? upiId : '',
    upiName: env('UPI_NAME', '').replace(/[^\w .&-]/g, '').slice(0, 40),
    upiQrPath: QR_PATH_RE.test(qrPath) ? qrPath : '',
    adminToken: env('ADMIN_TOKEN', ''),
  };
}

module.exports = { PLANS, getConfig, UPI_ID_RE };
