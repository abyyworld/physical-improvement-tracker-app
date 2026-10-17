// The accounts people can link on the Connect screen and in Settings, Your life, Accounts
// (src/connect/).
//
// Google and Microsoft need the owner to register Arise with them once (docs/LAUNCH.md, "Turning
// on linked accounts"). Until a client ID is here, they show "Coming soon". A client ID isn't a
// secret: it only names the app, and each sign-in only works back on Arise's own address.
//
// Steam and PlayStation need nothing here: each person brings their own key or sign-in code.

export const GOOGLE = {
  // A "Web application" OAuth client, like 1234-abc.apps.googleusercontent.com.
  clientId: '',
  // The Google app is still in Testing: only people the owner adds as test users can connect,
  // and Google asks them again every 7 days. The app says so when they connect.
  testing: true,
};

export const MICROSOFT = {
  // The "Application (client) ID" of the Azure app registration.
  clientId: '',
  // 'common': work, school and personal Microsoft accounts (Outlook.com, Hotmail, Live).
  tenant: 'common',
};
