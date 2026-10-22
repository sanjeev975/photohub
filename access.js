/* Free trial + subscription gate.
 * Loaded after app.js / ui.js. If the server feature is off or unreachable the app behaves exactly as before.
 * All text from the server is inserted with textContent (never innerHTML). */
(function () {
  'use strict';

  var S = { status: null, busy: false, unverified: 0, hashing: false };
  var el = function (id) { return document.getElementById(id); };

  function toast(msg, type) { try { if (typeof showToast === 'function') showToast(msg, type || 'info'); } catch (e) {} }

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ------------------------------------------------------------ api
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (opts.body) { init.method = 'POST'; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 8000) : null;
    if (ctl) init.signal = ctl.signal;
    return fetch(path, init).then(function (r) {
      if (timer) clearTimeout(timer);
      return r.json().catch(function () { return null; }).then(function (j) { return { status: r.status, json: j }; });
    }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  function setStatus(j) {
    if (j && j.enabled === true) { S.status = j; } else if (j && j.enabled === false) { S.status = null; }
    renderChip();
  }

  function refresh() {
    return api('/api/status').then(function (r) {
      if (r.status === 200 && r.json) setStatus(r.json);
    }).catch(function () {});
  }

  // ------------------------------------------------------------ plan chip
  function renderChip() {
    var chip = el('plan-chip');
    if (!chip) return;
    var s = S.status;
    if (!s) { chip.classList.add('hidden'); return; }
    chip.classList.remove('hidden');
    var label = el('plan-chip-label');
    var sub = el('plan-chip-sub');
    var btn = el('btn-plan-upgrade');
    if (s.paid) {
      label.textContent = (s.plan || 'Subscribed') + ' active';
      sub.textContent = s.daysLeft + (s.daysLeft === 1 ? ' day left' : ' days left');
      btn.textContent = s.payments ? 'Renew' : 'Details';
    } else if (s.pending) {
      label.textContent = 'Payment under review';
      sub.textContent = 'We will unlock your plan once confirmed';
      btn.textContent = 'View';
    } else {
      label.textContent = s.trialsLeft > 0 ? (s.trialsLeft + ' of ' + s.trialLimit + ' free exports left') : 'Free trial finished';
      sub.textContent = s.trialsLeft > 0 ? 'Re-exporting the same photo is free' : (s.payments ? 'Choose a plan to continue' : 'Subscriptions coming soon');
      btn.textContent = s.payments ? 'Upgrade' : 'Info';
    }
    chip.dataset.state = s.paid ? 'paid' : (s.trialsLeft > 0 ? 'trial' : 'out');
  }

  // ------------------------------------------------------------ fingerprint
  function toHex(buf) {
    var b = new Uint8Array(buf), out = '';
    for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return out;
  }
  function weakHash(bytes, extra) {
    var a = 0x811c9dc5, b = 0x01000193, c = 0x9e3779b9, d = 0x85ebca6b;
    for (var i = 0; i < bytes.length; i += 1) {
      a = Math.imul(a ^ bytes[i], 16777619) >>> 0; b = (Math.imul(b, 31) + bytes[i]) >>> 0;
      c = (c ^ (a + i)) >>> 0; d = (Math.imul(d, 33) ^ b) >>> 0;
    }
    var s = [a, b, c, d].map(function (n) { return ('00000000' + n.toString(16)).slice(-8); }).join('');
    return s + (extra ? '' : '');
  }
  function sha(bytes) {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', bytes).then(toHex);
    }
    return Promise.resolve(weakHash(new Uint8Array(bytes)));
  }
  function personHash(p) {
    if (p.__pphHash) return Promise.resolve(p.__pphHash);
    var url = p.objectUrl;
    var fallback = function () { return sha(new TextEncoder().encode(String(p.name || '') + '|' + String(p.id || ''))); };
    if (!url) return fallback().then(function (x) { p.__pphHash = x; return x; });
    return fetch(url).then(function (r) { return r.arrayBuffer(); }).then(sha).catch(fallback).then(function (x) { p.__pphHash = x; return x; });
  }
  function fingerprint() {
    var items = [];
    try { items = buildLayoutItemsList(); } catch (e) { items = []; }
    var seen = [], uniq = [];
    items.forEach(function (p) { if (seen.indexOf(p) < 0) { seen.push(p); uniq.push(p); } });
    if (!uniq.length) return Promise.resolve(null);
    return Promise.all(uniq.map(personHash)).then(function (hs) {
      hs = hs.filter(function (v, i) { return hs.indexOf(v) === i; }).sort();
      return sha(new TextEncoder().encode(hs.join('|'))).then(function (x) { return x.slice(0, 32); });
    });
  }

  // ------------------------------------------------------------ gate
  function gate(kind) {
    var s = S.status;
    if (!s || !s.enabled) return Promise.resolve(true);
    if (typeof AppState !== 'undefined' && AppState.people && AppState.people.length === 0) return Promise.resolve(true);
    return fingerprint().then(function (fp) {
      if (!fp) return true;
      return api('/api/export', { body: { fp: fp, kind: kind } }).then(function (r) {
        if (r.status === 200 && r.json && r.json.ok) { S.unverified = 0; setStatus(r.json); return true; }
        if (r.status === 402 && r.json) { S.unverified = 0; setStatus(r.json); openModal(r.json.code); return false; }
        return unverified();
      }, unverified);
    }, function () { return true; });
  }
  function unverified() {
    S.unverified += 1;
    if (S.unverified > 2) { toast('Could not verify your plan. Check your connection and try again.', 'error'); return false; }
    return true;
  }

  function wrap(name, kindOf, needsLib) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () {
      var args = arguments, self = this;
      if (needsLib && !window[needsLib]) return orig.apply(self, args);
      if (S.busy) return undefined;
      S.busy = true;
      return gate(kindOf.apply(null, args)).then(function (ok) {
        S.busy = false;
        return ok ? orig.apply(self, args) : undefined;
      }, function () { S.busy = false; return orig.apply(self, args); });
    };
  }
  wrap('exportPDF', function () { return 'pdf'; }, 'jspdf');
  wrap('exportImage', function (f) { return f === 'png' ? 'png' : 'jpeg'; });
  wrap('exportSinglePhoto', function () { return 'single'; });

  // ------------------------------------------------------------ modal
  function modal() { return el('modal-upgrade'); }
  function closeModal() { var m = modal(); if (m && m.open) m.close(); }

  function openModal(code) {
    var m = modal();
    if (!m || !S.status) return;
    render(code);
    if (!m.open) { try { m.showModal(); } catch (e) { m.setAttribute('open', ''); } }
  }

  var ui = { plan: 'm3', mode: 'pay', msg: '', err: '' };

  function render(code) {
    var root = el('upgrade-body');
    if (!root) return;
    root.textContent = '';
    var s = S.status;
    var title = el('upgrade-title');

    if (s.paid) {
      title.textContent = (s.plan || 'Subscription') + ' active';
      root.appendChild(h('p', 'text-sm text-slate-600', 'Valid until ' + new Date(s.paidUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) + ' (' + s.daysLeft + ' days left). You can export without limits.'));
      if (s.payments) root.appendChild(h('p', 'text-xs text-slate-500 mt-3', 'Paying again for another plan adds time on top of what you have left.'));
      if (s.payments) buildPay(root, s);
      return;
    }

    title.textContent = s.trialsLeft > 0 ? 'Upgrade' : (code === 'NETWORK_LIMIT' ? 'Free trials used on this network' : 'Your free trial has ended');
    var intro = code === 'NETWORK_LIMIT'
      ? 'The free exports available from this network are used up. Subscribe to keep exporting.'
      : (s.trialsLeft > 0 ? s.trialsLeft + ' free export' + (s.trialsLeft === 1 ? '' : 's') + ' left. Subscribe for unlimited exports.' : 'You have used your ' + s.trialLimit + ' free exports. Re-exporting a photo you already exported is still free; a new photo needs a plan.');
    root.appendChild(h('p', 'text-sm text-slate-600', intro));

    if (!s.payments) {
      var soon = h('div', 'mt-4 rounded-xl border border-indigo-100 bg-indigo-50 p-4');
      soon.appendChild(h('p', 'text-sm font-semibold text-indigo-900', 'Subscriptions are coming soon'));
      soon.appendChild(h('p', 'text-xs text-indigo-800 mt-1', 'Plans for 1, 3, 6 and 12 months will be available here shortly.'));
      root.appendChild(soon);
      return;
    }
    buildPay(root, s);
  }

  function buildPay(root, s) {
    if (s.pending) {
      var box = h('div', 'mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4');
      box.appendChild(h('p', 'text-sm font-semibold text-amber-900', 'Payment under review'));
      var pl = (s.plans || []).filter(function (p) { return p.id === s.pending.plan; })[0];
      box.appendChild(h('p', 'text-xs text-amber-800 mt-1', (pl ? pl.label : 'Plan') + ' · ₹' + s.pending.price + ' · ref ' + s.pending.ref + '. Your plan unlocks as soon as the payment is confirmed. You can keep this page open or come back later.'));
      var chk = h('button', 'mt-3 px-3 py-1.5 text-xs font-semibold bg-white border border-amber-300 rounded-lg text-amber-900 hover:bg-amber-100 cursor-pointer', 'Check status');
      chk.type = 'button';
      chk.addEventListener('click', function () { refresh().then(function () { render(); if (S.status && S.status.paid) toast('Subscription active. Thank you!', 'success'); }); });
      box.appendChild(chk);
      root.appendChild(box);
      return;
    }

    if (ui.mode === 'restore') return buildRestore(root);

    var grid = h('div', 'mt-4 grid grid-cols-2 gap-2');
    (s.plans || []).forEach(function (p) {
      var b = h('button', 'plan-card text-left rounded-xl border p-3 cursor-pointer transition-colors ' + (ui.plan === p.id ? 'border-indigo-600 bg-indigo-50 ring-1 ring-indigo-600' : 'border-slate-200 bg-white hover:border-slate-300'));
      b.type = 'button';
      b.setAttribute('aria-pressed', ui.plan === p.id ? 'true' : 'false');
      b.appendChild(h('span', 'block text-xs font-semibold text-slate-600', p.label));
      b.appendChild(h('span', 'block text-lg font-bold text-slate-900', '₹' + p.price));
      if (p.months > 1) b.appendChild(h('span', 'block text-[11px] text-slate-500', '₹' + Math.round(p.price / p.months) + ' / month'));
      b.addEventListener('click', function () { ui.plan = p.id; render(); });
      grid.appendChild(b);
    });
    root.appendChild(grid);

    var plan = (s.plans || []).filter(function (p) { return p.id === ui.plan; })[0] || (s.plans || [])[0];
    if (!plan) return;

    var pay = h('div', 'mt-4 rounded-xl border border-slate-200 p-4');
    pay.appendChild(h('p', 'text-xs font-semibold text-slate-700', '1. Pay ₹' + plan.price + ' by UPI'));
    var qr = s.upi && typeof s.upi.qrPath === 'string' && /^\/[A-Za-z0-9._\/-]{1,80}\.(png|jpe?g|webp)$/i.test(s.upi.qrPath) && s.upi.qrPath.indexOf('..') < 0 ? s.upi.qrPath : '';
    if (qr) {
      var img = h('img', 'mx-auto mt-2 w-44 h-44 rounded-lg border border-slate-200 bg-white object-contain');
      img.alt = 'UPI QR code'; img.src = qr;
      pay.appendChild(img);
    }
    var row = h('div', 'mt-2 flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2');
    var idSpan = h('span', 'text-sm font-mono text-slate-800 break-all', s.upi.id);
    row.appendChild(idSpan);
    var cp = h('button', 'text-xs font-semibold text-indigo-700 hover:text-indigo-900 cursor-pointer', 'Copy');
    cp.type = 'button';
    cp.addEventListener('click', function () {
      try { navigator.clipboard.writeText(s.upi.id).then(function () { cp.textContent = 'Copied'; }); } catch (e) { toast('Copy not supported here', 'error'); }
    });
    row.appendChild(cp);
    pay.appendChild(row);
    if (s.upi.name) pay.appendChild(h('p', 'text-[11px] text-slate-500 mt-1', 'Pay to: ' + s.upi.name));
    var link = h('a', 'lg:hidden mt-2 inline-block text-xs font-semibold text-indigo-700 underline', 'Open in UPI app');
    link.href = 'upi://pay?pa=' + encodeURIComponent(s.upi.id) + '&pn=' + encodeURIComponent(s.upi.name || '') + '&am=' + plan.price + '&cu=INR';
    link.rel = 'noopener noreferrer';
    pay.appendChild(link);
    root.appendChild(pay);

    var f = h('form', 'mt-3 space-y-2');
    f.noValidate = true;
    f.appendChild(h('p', 'text-xs font-semibold text-slate-700', '2. Tell us it is paid'));
    var utr = input('UPI reference / UTR number', 'text', 'utr', 'off');
    var contact = input('Mobile number or email', 'text', 'contact', 'off');
    f.appendChild(utr.wrap); f.appendChild(contact.wrap);
    var err = h('p', 'text-xs text-rose-600 min-h-[1rem]', ui.err);
    err.setAttribute('role', 'alert');
    f.appendChild(err);
    var go = h('button', 'w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg cursor-pointer disabled:opacity-60', 'I have paid ₹' + plan.price);
    go.type = 'submit';
    f.appendChild(go);
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      go.disabled = true; err.textContent = '';
      api('/api/pay', { body: { action: 'request', plan: plan.id, utr: utr.field.value, contact: contact.field.value } }).then(function (r) {
        if (r.status === 200 && r.json && r.json.ok) { ui.err = ''; setStatus(r.json); render(); toast('Payment submitted. We will confirm it shortly.', 'success'); }
        else { err.textContent = (r.json && r.json.error) || 'Could not submit. Please try again.'; go.disabled = false; }
      }, function () { err.textContent = 'Network problem. Please try again.'; go.disabled = false; });
    });
    root.appendChild(f);

    var rs = h('button', 'mt-3 text-xs text-slate-500 hover:text-slate-800 underline cursor-pointer', 'Already subscribed on another device? Restore access');
    rs.type = 'button';
    rs.addEventListener('click', function () { ui.mode = 'restore'; ui.err = ''; render(); });
    root.appendChild(rs);
  }

  function input(label, type, name, ac) {
    var wrap = h('label', 'block');
    wrap.appendChild(h('span', 'block text-[11px] font-medium text-slate-600 mb-1', label));
    var field = h('input', 'w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500');
    field.type = type; field.name = name; field.maxLength = 64; field.autocomplete = ac || 'off'; field.spellcheck = false;
    wrap.appendChild(field);
    return { wrap: wrap, field: field };
  }

  function buildRestore(root) {
    var f = h('form', 'mt-4 space-y-2');
    f.noValidate = true;
    f.appendChild(h('p', 'text-xs text-slate-600', 'Enter the UTR and the mobile/email you used when you paid. A plan can be used on up to 3 browsers.'));
    var utr = input('UPI reference / UTR number', 'text', 'utr');
    var contact = input('Mobile number or email', 'text', 'contact');
    f.appendChild(utr.wrap); f.appendChild(contact.wrap);
    var err = h('p', 'text-xs text-rose-600 min-h-[1rem]');
    err.setAttribute('role', 'alert');
    f.appendChild(err);
    var go = h('button', 'w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg cursor-pointer disabled:opacity-60', 'Restore access');
    go.type = 'submit';
    f.appendChild(go);
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      go.disabled = true; err.textContent = '';
      api('/api/pay', { body: { action: 'restore', utr: utr.field.value, contact: contact.field.value } }).then(function (r) {
        if (r.status === 200 && r.json && r.json.ok) { ui.mode = 'pay'; setStatus(r.json); render(); toast('Subscription restored on this browser.', 'success'); }
        else { err.textContent = (r.json && r.json.error) || 'Could not restore. Please try again.'; go.disabled = false; }
      }, function () { err.textContent = 'Network problem. Please try again.'; go.disabled = false; });
    });
    root.appendChild(f);
    var back = h('button', 'mt-2 text-xs text-slate-500 hover:text-slate-800 underline cursor-pointer', 'Back to plans');
    back.type = 'button';
    back.addEventListener('click', function () { ui.mode = 'pay'; render(); });
    root.appendChild(back);
  }

  // ------------------------------------------------------------ boot
  function boot() {
    var up = el('btn-plan-upgrade');
    if (up) up.addEventListener('click', function () { if (S.status) openModal(); });
    var x = el('btn-upgrade-close');
    if (x) x.addEventListener('click', closeModal);
    var m = modal();
    if (m) m.addEventListener('click', function (e) { if (e.target === m) closeModal(); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && S.status && (S.status.pending || S.status.trialsLeft === 0)) {
        refresh().then(function () { var mm = modal(); if (mm && mm.open) render(); });
      }
    });
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
