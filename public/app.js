// Lightweight event delegation: replaces inline handlers (onclick, onsubmit,
// onchange, onfocus) so the page works under a strict CSP that forbids
// `script-src-attr` (i.e. inline event attributes). Loaded on every
// authenticated page via partials/foot.ejs.
(function () {
  'use strict';

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action]');
    if (!t) return;
    var action = t.getAttribute('data-action');
    if (action === 'print') {
      e.preventDefault();
      window.print();
    } else if (action === 'copy') {
      e.preventDefault();
      var v = t.getAttribute('data-copy') || '';
      try {
        navigator.clipboard.writeText(v).then(function () {
          var prev = t.textContent;
          t.textContent = 'copié';
          setTimeout(function () { t.textContent = prev; }, 1800);
        });
      } catch (_) { /* older browsers */ }
    } else if (action === 'noop') {
      e.preventDefault();
      var msg = t.getAttribute('data-message');
      if (msg) alert(msg);
    }
  });

  document.addEventListener('submit', function (e) {
    var f = e.target;
    var msg = f && f.getAttribute && f.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  document.addEventListener('change', function (e) {
    if (e.target.matches && e.target.matches('[data-autosubmit]')) {
      var f = e.target.form; if (f) f.submit();
    }
  });

  document.addEventListener('focusin', function (e) {
    if (e.target.matches && e.target.matches('input.share-link')) e.target.select();
  });
})();
