// Only for devices updating from Arise 1.x. Their old offline copy can still show the 1.x page
// once, which loads this file instead of the old app (2.0 has no js/app.js). It lets the new
// version take over, then reloads into it, so the update never leaves a blank screen.
(() => {
  const KEY = 'arise-from-1x';
  const say = (text) => {
    document.body.innerHTML = `<p style="font:16px system-ui,sans-serif;color:#aab;text-align:center;padding:40vh 16px 0">${text}</p>`;
  };
  say('Updating Arise…');
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    let tries = 0;
    try {
      tries = Number(sessionStorage.getItem(KEY)) || 0;
      sessionStorage.setItem(KEY, String(tries + 1));
    } catch {}
    if (tries >= 3) return say('Close Arise and open it again to finish updating.');
    location.reload();
  };
  if (!('serviceWorker' in navigator)) return go();
  navigator.serviceWorker.addEventListener('controllerchange', go);
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => reg.update())
    .catch(() => {});
  setTimeout(go, 5000);
})();
