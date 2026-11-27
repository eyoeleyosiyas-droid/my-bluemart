(function () {
  var KEY = 'bm_theme', root = document.documentElement, btn = document.getElementById('tt');
  function cur() { return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function apply(t, save) {
    root.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'light' ? '#f1f5f9' : '#070d1f');
    if (btn) btn.setAttribute('aria-label', t === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
    if (save) {
      root.classList.add('theme-anim'); setTimeout(function () { root.classList.remove('theme-anim'); }, 350);
      try { localStorage.setItem(KEY, t); } catch (e) { /* storage unavailable */ }
    }
  }
  apply(cur(), false);
  if (btn) btn.addEventListener('click', function () { apply(cur() === 'light' ? 'dark' : 'light', true); });
  window.addEventListener('storage', function (e) {
    if (e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')) apply(e.newValue, false);
  });
})();
