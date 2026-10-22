/*
 * ui.js - layout behaviour only (slide-away tools panel, drop-down sections).
 * It does not touch photo, crop, layout or export logic in app.js.
 */
(function () {
  'use strict';

  var doc = document;
  var body = doc.body;
  var STORE_KEY = 'pph_tools_panel_collapsed_v1';
  var desktop = window.matchMedia('(min-width: 1024px)');

  function readPref() {
    try { return localStorage.getItem(STORE_KEY) === '1'; } catch (e) { return false; }
  }
  function writePref(collapsed) {
    try { localStorage.setItem(STORE_KEY, collapsed ? '1' : '0'); } catch (e) { /* storage blocked: fine */ }
  }

  var panel = doc.getElementById('side-panel');
  var toggle = doc.getElementById('btn-side-toggle');
  var closeBtn = doc.getElementById('btn-side-close');
  var backdrop = doc.getElementById('side-backdrop');

  // ---------------------------------------------------------------
  // 1. Slide-away tools panel (desktop: collapse / mobile: drawer)
  // ---------------------------------------------------------------
  function nudgeLayout() {
    // Lets the sheet preview recompute its "Fit" zoom after the panel finishes sliding
    window.setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 330);
  }

  function isCollapsed() { return body.classList.contains('side-collapsed'); }
  function isOpen() { return body.classList.contains('side-open'); }

  function syncPanelState() {
    var hidden = desktop.matches ? isCollapsed() : !isOpen();
    if (panel) {
      if ('inert' in panel) panel.inert = hidden;
      panel.setAttribute('aria-hidden', hidden ? 'true' : 'false');
    }
    if (toggle) {
      toggle.setAttribute('aria-expanded', hidden ? 'false' : 'true');
      toggle.setAttribute('aria-label', hidden ? 'Show tools panel' : 'Hide tools panel');
    }
  }

  function setCollapsed(value, persist) {
    body.classList.toggle('side-collapsed', !!value);
    if (persist) writePref(!!value);
    syncPanelState();
    nudgeLayout();
  }

  function setOpen(value) {
    body.classList.toggle('side-open', !!value);
    syncPanelState();
  }

  if (toggle) {
    toggle.addEventListener('click', function () {
      if (desktop.matches) setCollapsed(!isCollapsed(), true);
      else setOpen(!isOpen());
    });
  }
  if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
  if (backdrop) backdrop.addEventListener('click', function () { setOpen(false); });
  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !desktop.matches && isOpen()) setOpen(false);
  });

  var onBreakpoint = function () {
    if (desktop.matches) { body.classList.remove('side-open'); }
    syncPanelState();
    nudgeLayout();
  };
  if (desktop.addEventListener) desktop.addEventListener('change', onBreakpoint);
  else if (desktop.addListener) desktop.addListener(onBreakpoint);

  if (desktop.matches && readPref()) body.classList.add('side-collapsed');
  syncPanelState();

  // ---------------------------------------------------------------
  // 2. Section drop-downs: clicking the open section closes it
  //    (opening another section is still handled by app.js)
  // ---------------------------------------------------------------
  var ACTIVE = ['bg-indigo-600', 'text-white', 'shadow-sm'];

  function setHeadActive(btn, active) {
    ACTIVE.forEach(function (c) { btn.classList.toggle(c, active); });
    btn.classList.toggle('text-slate-600', !active);
    btn.setAttribute('aria-expanded', active ? 'true' : 'false');
  }

  doc.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.tab-btn') : null;
    if (!btn) return;
    var section = doc.getElementById(btn.getAttribute('data-tab'));
    if (!section) return;
    if (!section.classList.contains('hidden')) {
      e.stopPropagation();
      e.preventDefault();
      section.classList.add('hidden');
      setHeadActive(btn, false);
    }
  }, true);

  // Keep aria-expanded correct when app.js switches sections
  function syncAria() {
    doc.querySelectorAll('.tab-btn').forEach(function (btn) {
      var section = doc.getElementById(btn.getAttribute('data-tab'));
      btn.setAttribute('aria-expanded', section && !section.classList.contains('hidden') ? 'true' : 'false');
    });
  }
  if (window.MutationObserver) {
    var mo = new MutationObserver(syncAria);
    doc.querySelectorAll('.tab-content').forEach(function (el) {
      mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  }
  syncAria();

  // ---------------------------------------------------------------
  // 3. Drop-down cards inside a section ([data-fold="open|closed"])
  // ---------------------------------------------------------------
  var CHEV = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  doc.querySelectorAll('[data-fold]').forEach(function (card) {
    var head = card.firstElementChild;
    if (!head) return;

    card.classList.add('fold');
    head.classList.add('fold-head');
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');

    var chev = doc.createElement('span');
    chev.className = 'fold-chev';
    chev.innerHTML = CHEV;
    head.appendChild(chev);

    function apply(folded) {
      card.classList.toggle('is-folded', folded);
      head.setAttribute('aria-expanded', folded ? 'false' : 'true');
    }
    apply(card.getAttribute('data-fold') === 'closed');

    head.addEventListener('click', function (e) {
      // Buttons / fields inside the header keep their own behaviour
      var inner = e.target.closest('button, a, input, select, textarea, label');
      if (inner && inner !== head && head.contains(inner)) return;
      apply(!card.classList.contains('is-folded'));
    });
    head.addEventListener('keydown', function (e) {
      if (e.target !== head) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        apply(!card.classList.contains('is-folded'));
      }
    });
  });
})();

/* Zoom + / - : press and hold to keep zooming */
(function () {
  'use strict';
  function hold(id, delta) {
    var b = document.getElementById(id);
    if (!b) return;
    var t = null, iv = null, held = false;
    function stop() { clearTimeout(t); clearInterval(iv); t = iv = null; }
    b.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      held = false;
      t = setTimeout(function () {
        held = true;
        iv = setInterval(function () { if (typeof changeZoom === 'function') changeZoom(delta); }, 60);
      }, 350);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(function (ev) { b.addEventListener(ev, stop); });
    // a long press must not also fire the normal click step
    b.addEventListener('click', function (e) { if (held) { e.stopImmediatePropagation(); held = false; } }, true);
  }
  hold('btn-zoom-in', 0.08);
  hold('btn-zoom-out', -0.08);
})();
