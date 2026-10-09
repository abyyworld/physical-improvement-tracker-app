/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILT__: string;
declare const __APP_UPDATE_SITE__: string; // '' when this build doesn't update itself (see vite.config.ts)
declare const __APP_NATIVE__: string;
