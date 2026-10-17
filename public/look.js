// Runs before the page first paints, so the right look shows from the start (no flash of the
// wrong one). It reads this device's copy of the look setting, which src/look.ts keeps, and does
// what applyLook there does. Keep the two in step. A plain script, because a module would only run
// after the page has drawn.
(function () {
  var look = 'auto';
  try {
    look = localStorage.getItem('arise-look') || 'auto';
  } catch (e) {}
  if (look !== 'light' && look !== 'dark' && look !== 'system') look = 'auto';
  var root = document.documentElement;
  root.setAttribute('data-theme', look === 'system' ? 'system' : 'arise');
  if (look === 'light' || look === 'dark') root.setAttribute('data-mode', look);
  var dark = false;
  try {
    dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {}
  var scheme = look === 'system' || look === 'dark' || (look === 'auto' && dark) ? 'dark' : 'light';
  var color = look === 'system' ? '#040507' : scheme === 'dark' ? '#121110' : '#f5f4f0';
  var head = document.head;
  var add = function (name, content) {
    var m = document.createElement('meta');
    m.name = name;
    m.content = content;
    head.appendChild(m);
  };
  add('theme-color', color);
  add('color-scheme', look === 'auto' ? 'light dark' : scheme);
  // On a home-screen web app on iPhone: white status bar text over a dark page, dark text on a
  // light one. Read when the app opens.
  add('apple-mobile-web-app-status-bar-style', scheme === 'dark' ? 'black-translucent' : 'default');
})();
