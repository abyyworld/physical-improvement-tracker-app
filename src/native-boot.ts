// The first thing the app runs. In the iPhone app, it notes that a version it just switched to
// began to run, so one that then fails to start isn't tried again (see native-update.ts). It's
// tiny and comes first, so it runs even when the rest of the app doesn't.
try {
  if (localStorage.getItem('arise-native-pending') === __APP_COMMIT__) localStorage.setItem('arise-native-tried', __APP_COMMIT__);
} catch {}

export {};
