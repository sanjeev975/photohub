/* Owner approval page. The token lives only in memory (never stored). Server returns 404 unless payments are enabled. */
(function () {
  'use strict';
  var token = '';
  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  function call(body) {
    return fetch('/api/admin', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { status: r.status, json: j }; }); });
  }
  function fmt(t) { try { return new Date(t).toLocaleString(); } catch (e) { return ''; } }

  function card(p, actions) {
    var c = h('div', 'rounded-xl border border-slate-200 bg-white p-3');
    c.appendChild(h('p', 'text-sm font-semibold', '₹' + p.price + ' · ' + p.plan + ' · ' + p.status));
    c.appendChild(h('p', 'text-xs font-mono break-all mt-1', 'UTR: ' + p.utr));
    c.appendChild(h('p', 'text-xs text-slate-600', 'Contact: ' + p.contact + ' · ' + fmt(p.createdAt)));
    if (p.status === 'approved' && p.startsAt) c.appendChild(h('p', 'text-xs text-emerald-700', 'Runs ' + fmt(p.startsAt) + ' → ' + fmt(p.expiresAt)));
    if (actions) c.appendChild(actions);
    return c;
  }
  function btn(label, cls, fn) { var b = h('button', 'px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer ' + cls, label); b.type = 'button'; b.addEventListener('click', function () { b.disabled = true; fn().then(function () { b.disabled = false; }); }); return b; }

  function act(body, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return Promise.resolve();
    return call(body).then(function (r) {
      if (r.status === 200 && r.json) { draw(r.json); $('msg').textContent = ''; } else { $('msg').textContent = (r.json && r.json.error) || 'Failed'; }
    });
  }

  function draw(d) {
    $('panel').classList.remove('hidden');
    var pend = $('pending'); pend.textContent = '';
    (d.pending || []).forEach(function (p) {
      var row = h('div', 'flex gap-2 mt-2');
      row.appendChild(btn('Approve', 'bg-emerald-600 text-white', function () { return act({ action: 'approve', utr: p.utr }, 'Approve ₹' + p.price + ' (' + p.plan + ')? Only do this after the money is in your bank.'); }));
      row.appendChild(btn('Reject', 'bg-white border border-rose-300 text-rose-700', function () { return act({ action: 'reject', utr: p.utr, reason: 'Not received' }); }));
      pend.appendChild(card(p, row));
    });
    if (!pend.childNodes.length) pend.appendChild(h('p', 'text-xs text-slate-500', 'Nothing waiting.'));
    var rec = $('recent'); rec.textContent = '';
    (d.recent || []).forEach(function (p) {
      var row = null;
      if (p.status === 'approved') {
        row = h('div', 'mt-2');
        row.appendChild(btn('Refund / Revoke this payment', 'bg-white border border-rose-300 text-rose-700', function () { return act({ action: 'revoke', utr: p.utr }, 'Cancel ONLY this payment (₹' + p.price + ', ' + p.plan + ')? The user keeps any other plans they bought; only the unused time of this one is removed.'); }));
      }
      rec.appendChild(card(p, row));
    });
  }

  function load() {
    return call({ action: 'list' }).then(function (r) {
      if (r.status === 200 && r.json) { draw(r.json); $('msg').textContent = ''; }
      else if (r.status === 404) { $('msg').textContent = 'Not available.'; }
      else if (r.status === 429) { $('msg').textContent = 'Too many attempts. Try again in 15 minutes.'; }
      else { $('msg').textContent = 'Wrong token.'; token = ''; }
    }).catch(function () { $('msg').textContent = 'Network problem.'; });
  }
  $('login').addEventListener('submit', function (e) { e.preventDefault(); token = $('token').value; $('token').value = ''; load(); });
  $('reload').addEventListener('click', load);
})();
