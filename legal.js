/* Highlights the current section in "On this page". Pages stay fully readable without JavaScript. */
(function () {
  'use strict';
  var links = [].slice.call(document.querySelectorAll('.toc nav a'));
  var heads = [].slice.call(document.querySelectorAll('.doc h2[id]'));
  if (!links.length) return;
  var map = {};
  links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
  var ticking = false, current = null;
  function update() {
    ticking = false;
    var id = null;
    for (var i = 0; i < heads.length; i++) {
      if (heads[i].getBoundingClientRect().top <= 140) id = heads[i].id; else break;
    }
    if (id === current) return;
    current = id;
    links.forEach(function (a) { a.classList.toggle('on', !!id && a === map[id]); });
  }
  window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  update();
  var d = document.querySelector('.toc details');
  if (d) {
    if (window.matchMedia('(max-width:900px)').matches) d.removeAttribute('open');
    else d.addEventListener('click', function (e) { if (e.target.closest('summary')) e.preventDefault(); });
  }
})();
