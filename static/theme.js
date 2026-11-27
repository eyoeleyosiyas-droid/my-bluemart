(function () {
  try {
    var t = localStorage.getItem('bm_theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
      if (t === 'light') document.querySelector('meta[name="theme-color"]').setAttribute('content', '#f1f5f9');
    }
  } catch (e) { /* storage unavailable: stay on the dark default */ }
})();
