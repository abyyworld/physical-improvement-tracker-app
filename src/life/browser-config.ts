// Where the Arise browser extension comes from. Once the owner publishes it (extension/README.md),
// its store pages go here, and Settings links to them instead of explaining "Load unpacked".
export const EXTENSION_STORES: { chrome: string; edge: string } = {
  chrome: '', // Chrome Web Store (also for Brave and Arc)
  edge: '', // Microsoft Edge Add-ons
};

// On the website, next to the app (the Deploy workflow puts them there).
export const EXTENSION_ZIP = './extension/arise-chrome.zip'; // for "Load unpacked"
export const EXTENSION_XPI = './extension/arise-firefox.xpi'; // signed by Mozilla, once it is
export const EXTENSION_UPDATES = './extension/updates.json'; // only there when the signed copy is
