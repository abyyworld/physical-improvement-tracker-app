/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILT__: string;
declare const __APP_UPDATE_SITE__: string; // '' when this build doesn't update itself (see vite.config.ts)
declare const __APP_NATIVE__: string; // the iPhone app's native parts (see scripts/native-key.mjs)
declare const __APP_NATIVE_ANDROID__: string; // the Android app's
declare const __APP_APK_URL__: string; // the newest Arise.apk, '' when this build doesn't update itself
declare const __APP_HELPER_BUILD__: number; // the Mac helper build the install command puts in (0: none named)
