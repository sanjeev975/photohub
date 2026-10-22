'use strict';

/**
 * Trial + subscription logic (no login).
 *
 * Identity  : signed, HttpOnly device cookie. A hashed-IP counter is the backstop against
 *             people clearing cookies again and again.
 * A "use"   : exporting a sheet. The client sends a fingerprint of the photo(s) on the sheet.
 *             Same photo set again = free (no new trial). New/changed picture = one more trial.
 * Payments  : manual. The user pays by UPI and submits the UPI reference (UTR). Only the owner
 *             (admin token) can approve, which activates the license on that device.
 */

const crypto = require('crypto');
const { PLANS, getConfig } = require('./config');
const { getStore } = require('./store');
const { baseHeaders, send, sameOrigin, readJson, isPlainObject, clientIp, hmac, safeEqual, hit } = require('./http');

const DAY = 86400;
const k = (...parts) => 'pph:' + parts.join(':');

const FP_RE = /^[a-f0-9]{32}$/;
const UTR_RE = /^[A-Z0-9]{10,24}$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const KINDS = new Set(['pdf', 'png', 'jpeg', 'single']);

// ------------------------------------------------------------------ identity
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function cookieSig(secret, id) { return hmac(secret, 'did:' + id).slice(0, 32); }

function readDeviceId(req, secret) {
  const raw = parseCookies((req.headers || {}).cookie).pph_did;
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!ID_RE.test(id)) return null;
  return safeEqual(sig, cookieSig(secret, id)) ? id : null;
}

function issueDeviceCookie(req, res, secret, id) {
  const h = req.headers || {};
  const secure = String(h['x-forwarded-proto'] || '').split(',')[0] === 'https' || !!process.env.VERCEL;
  const parts = [`pph_did=${id}.${cookieSig(secret, id)}`, 'Path=/', `Max-Age=${2 * 365 * DAY}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ------------------------------------------------------------------ request prelude
/**
 * Common setup. Returns { off: true } when the feature is not (correctly) configured:
 * in that case the app simply runs without limits, it never breaks.
 */
async function prelude(req, res, { method, issueCookie }) {
  baseHeaders(res);
  if (req.method !== method) {
    send(res, 405, { error: 'Method not allowed' }, { Allow: method });
    return { done: true };
  }
  if (method === 'POST' && !sameOrigin(req)) {
    send(res, 403, { error: 'Forbidden' });
    return { done: true };
  }
  const cfg = getConfig();
  const store = cfg.enabled && cfg.secret.length >= 32 ? getStore() : null;
  if (!store) {
    if (cfg.enabled) console.error('[access] TRIAL_ENABLED=1 but TRIAL_SECRET (32+ chars) or a Redis store is missing: running ungated');
    return { off: true, cfg };
  }
  const ip = clientIp(req);
  const ipHash = hmac(cfg.secret, 'ip:' + ip).slice(0, 24);
  let deviceId = readDeviceId(req, cfg.secret);
  let isNew = false;
  if (!deviceId) {
    deviceId = crypto.randomBytes(16).toString('base64url');
    isNew = true;
  }
  if (issueCookie || isNew) issueDeviceCookie(req, res, cfg.secret, deviceId);
  return { cfg, store, ipHash, deviceId, isNew };
}

function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// ------------------------------------------------------------------ dates
function addMonths(ts, months) {
  const d = new Date(ts);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

// ------------------------------------------------------------------ license + status
async function loadLicense(store, deviceId) {
  const licId = await store.pipeline([['GET', k('dev', deviceId, 'lic')]]).then((r) => r[0]);
  if (!licId) return null;
  const raw = await store.pipeline([['GET', k('lic', licId)]]).then((r) => r[0]);
  const lic = raw ? safeParse(raw) : null;
  return lic ? { id: licId, ...lic } : null;
}

function maskUtr(utr) { return utr.length > 4 ? '••••' + utr.slice(-4) : utr; }

async function buildStatus(ctx) {
  const { cfg, store, deviceId } = ctx;
  const [used, licId, pendingList] = await store.pipeline([
    ['GET', k('dev', deviceId, 'n')],
    ['GET', k('dev', deviceId, 'lic')],
    ['SMEMBERS', k('dev', deviceId, 'pend')],
  ]);
  const trialsUsed = Math.min(cfg.trialLimit, Math.max(0, parseInt(used || '0', 10) || 0));
  const now = Date.now();

  let paid = false;
  let paidUntil = null;
  let planLabel = null;
  if (licId) {
    const raw = await store.pipeline([['GET', k('lic', licId)]]).then((r) => r[0]);
    const lic = raw ? safeParse(raw) : null;
    if (lic && lic.exp > now) {
      paid = true;
      paidUntil = new Date(lic.exp).toISOString();
      planLabel = (PLANS[lic.plan] || {}).label || null;
    }
  }

  let pending = null;
  if (pendingList && pendingList.length) {
    const recs = await store.pipeline(pendingList.slice(0, 5).map((u) => ['GET', k('pay', u)]));
    const open = recs.map((r) => (r ? safeParse(r) : null)).filter((r) => r && r.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt);
    if (open[0]) pending = { plan: open[0].plan, price: open[0].price, ref: maskUtr(open[0].utr), createdAt: open[0].createdAt };
  }

  const paymentsOn = cfg.paymentsEnabled && !!(cfg.upiId || cfg.upiQrPath);
  const status = {
    enabled: true,
    trialLimit: cfg.trialLimit,
    trialsUsed,
    trialsLeft: cfg.trialLimit - trialsUsed,
    paid,
    paidUntil,
    plan: planLabel,
    daysLeft: paid ? Math.max(0, Math.ceil((new Date(paidUntil).getTime() - now) / (DAY * 1000))) : 0,
    pending,
    payments: paymentsOn,
    serverTime: now,
  };
  if (paymentsOn) {
    status.plans = Object.values(PLANS).map((p) => ({ id: p.id, label: p.label, months: p.months, price: p.price }));
    status.upi = { id: cfg.upiId, name: cfg.upiName, qrPath: cfg.upiQrPath };
  }
  return status;
}

// ------------------------------------------------------------------ export permit
async function consumeExport(ctx, fp) {
  const { cfg, store, deviceId, ipHash } = ctx;

  const lic = await loadLicense(store, deviceId);
  if (lic && lic.exp > Date.now()) return { code: 'OK', paid: true };

  const fpKey = k('dev', deviceId, 'fp');
  const nKey = k('dev', deviceId, 'n');
  const ipKey = k('ip', ipHash, 'trials');

  const added = (await store.pipeline([['SADD', fpKey, fp]]))[0];
  if (Number(added) === 0) return { code: 'OK', paid: false, repeat: true }; // same photo set: free

  const n = Number((await store.pipeline([['INCR', nKey]]))[0]);
  if (n > cfg.trialLimit) {
    await store.pipeline([['SREM', fpKey, fp], ['DECR', nKey]]);
    return { code: 'TRIALS_EXHAUSTED' };
  }

  const ipN = Number((await store.pipeline([['INCR', ipKey], ['EXPIRE', ipKey, String(30 * DAY), 'NX']]))[0]);
  if (ipN > cfg.ipTrialLimit) {
    await store.pipeline([['SREM', fpKey, fp], ['DECR', nKey], ['DECR', ipKey]]);
    return { code: 'NETWORK_LIMIT' };
  }
  return { code: 'OK', paid: false, repeat: false };
}

// ------------------------------------------------------------------ validation
function normalizeContact(raw) {
  const s = String(raw || '').trim();
  if (s.length < 5 || s.length > 80) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return s.toLowerCase();
  const digits = s.replace(/[\s()+-]/g, '');
  const m = /^(?:91|0)?([6-9]\d{9})$/.exec(digits);
  return m ? m[1] : null;
}

function normalizeUtr(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  return UTR_RE.test(s) ? s : null;
}

// ------------------------------------------------------------------ owner actions
async function approvePayment(store, utr) {
  const raw = await store.pipeline([['GET', k('pay', utr)]]).then((r) => r[0]);
  const rec = raw ? safeParse(raw) : null;
  if (!rec) return { error: 'Payment request not found', status: 404 };
  if (rec.status === 'approved') return { ok: true, already: true, rec };
  if (rec.status !== 'pending') return { error: 'Request is already ' + rec.status, status: 409 };

  const plan = PLANS[rec.plan];
  if (!plan) return { error: 'Unknown plan on request', status: 422 };

  const now = Date.now();
  let lic = await loadLicense(store, rec.deviceId);
  let licId;
  let base = now;
  let devices;
  if (lic) {
    licId = lic.id;
    base = Math.max(now, lic.exp || 0); // renewals stack on top of the remaining time
    devices = Array.from(new Set([...(lic.devices || []), rec.deviceId]));
  } else {
    licId = crypto.randomBytes(12).toString('base64url');
    devices = [rec.deviceId];
  }
  const exp = addMonths(base, plan.months);

  const decided = { ...rec, status: 'approved', decidedAt: now, licId, expiresAt: exp };
  await store.pipeline([
    ['SET', k('lic', licId), JSON.stringify({ exp, plan: plan.id, devices, created: (lic && lic.created) || now })],
    ['SET', k('dev', rec.deviceId, 'lic'), licId],
    ['SET', k('pay', utr), JSON.stringify(decided)],
    ['SREM', k('pay', 'pending'), utr],
  ]);
  return { ok: true, rec: decided };
}

async function rejectPayment(store, utr, reason) {
  const raw = await store.pipeline([['GET', k('pay', utr)]]).then((r) => r[0]);
  const rec = raw ? safeParse(raw) : null;
  if (!rec) return { error: 'Payment request not found', status: 404 };
  if (rec.status !== 'pending') return { error: 'Request is already ' + rec.status, status: 409 };
  const decided = { ...rec, status: 'rejected', decidedAt: Date.now(), reason: String(reason || '').slice(0, 120) };
  await store.pipeline([
    ['SET', k('pay', utr), JSON.stringify(decided)],
    ['SREM', k('pay', 'pending'), utr],
    ['SREM', k('dev', rec.deviceId, 'pend'), utr],
  ]);
  return { ok: true, rec: decided };
}

async function listPayments(store) {
  const [pendingUtrs, recentUtrs] = await store.pipeline([
    ['SMEMBERS', k('pay', 'pending')],
    ['LRANGE', k('pay', 'recent'), '0', '39'],
  ]);
  const fetchAll = async (utrs) => {
    if (!utrs || !utrs.length) return [];
    const recs = await store.pipeline(utrs.slice(0, 100).map((u) => ['GET', k('pay', u)]));
    return recs.map((r) => (r ? safeParse(r) : null)).filter(Boolean);
  };
  const pending = (await fetchAll(pendingUtrs)).sort((a, b) => a.createdAt - b.createdAt);
  const recent = (await fetchAll(recentUtrs)).filter((r) => r.status !== 'pending');
  return { pending, recent };
}

async function revokeLicense(store, licId) {
  const raw = await store.pipeline([['GET', k('lic', licId)]]).then((r) => r[0]);
  const lic = raw ? safeParse(raw) : null;
  if (!lic) return { error: 'License not found', status: 404 };
  lic.exp = Date.now() - 1000;
  await store.pipeline([['SET', k('lic', licId), JSON.stringify(lic)]]);
  return { ok: true };
}

module.exports = {
  PLANS, FP_RE, KINDS, ID_RE, k, DAY,
  prelude, buildStatus, consumeExport, loadLicense, addMonths,
  normalizeContact, normalizeUtr, maskUtr,
  approvePayment, rejectPayment, listPayments, revokeLicense,
  readJson, isPlainObject, send, baseHeaders, hit, hmac, safeEqual, safeParse, sameOrigin,
};
