# Arise Mac helper

Lets Arise, open in Chrome or Edge on your Mac, add your calls (including missed calls from your iPhone), notifications, messages, Safari history and app use to your life log. It reads them on the Mac only. Nothing leaves the Mac except through Arise's own end-to-end encrypted sync. Everything starts off: you turn on what you want in Arise, under Settings, Your life, Mac.

Install or update it by pasting this in Terminal (it needs macOS 13.5 or newer):

```
cd "$(mktemp -d)" && curl -fsSL https://github.com/abyyworld/physical-improvement-tracker-app/archive/refs/heads/main.tar.gz | tar xz && bash physical-improvement-tracker-app-main/mac-helper/install.sh
```

Then give Full Disk Access to `~/.arise-helper/bin/arise-helper` (System Settings, Privacy & Security, Full Disk Access) and enter the pairing code in Arise. The installer opens that page and shows the steps.

- See the code again: `bash ~/.arise-helper/arise-helper.sh code`
- Check on it: `bash ~/.arise-helper/arise-helper.sh status`
- Remove it: `bash ~/.arise-helper/arise-helper.sh uninstall`

Safari doesn't let a website reach a helper on the Mac, so use Chrome or Edge for this.

## Good to know

- Full Disk Access goes to one program, `~/.arise-helper/bin/arise-helper`. GitHub builds it from this folder and signs it. It runs only the helper's own code. It takes no options from outside, and nothing in the settings it's started with makes it run other code or write files where they say. macOS ties Full Disk Access to its signature: if anything changes the program, it loses the permission.
- So each update needs Full Disk Access again. The installer says what to do: remove "arise-helper" from the list, then add it again. Give it only when the installer asks, right after it has checked the helper. If Arise says it's needed later, run the install command again.
- Other apps you run can still read the pairing code (in your browser, or in `~/.arise-helper`) and use it to ask the helper for what it reads. And what the helper has read waits in `~/.arise-helper` until Arise takes it, where apps you run can read it too. So use the helper on a Mac where you trust what you install.
- Removing the helper doesn't take away Full Disk Access. Remove "arise-helper" from that list yourself.
- Had the older helper, with its own Node.js? Run the install command again. It replaces it and keeps your pairing code and switches. Then remove "node" from the Full Disk Access list and add "arise-helper", as the installer shows. Removing "node" matters: macOS would give its Full Disk Access to any Node.js put back in that place. Until it's gone, `status` and the Mac panel in Arise warn about it.

## How it's built

- `sea.mjs` is the program's starting point. On a Mac of each kind, with the exact Node.js release named in `.github/workflows/mac-helper.yml` and nothing else, `scripts/build-mac-helper.mjs` makes it and everything it uses into one script. That needs only Node.js: no npm package touches the code that gets Full Disk Access, and the same files always make the same script. Node.js then builds that into a single program with `--build-sea`, using `sea-config.json`, and `codesign` signs it ad hoc (no certificate), with the hardened runtime and only the entitlement in `entitlements.plist`.
- With an ad hoc signature, macOS knows the program by its hash, so a changed program is a different one. The hardened runtime keeps other programs out of it: no debugger, no `DYLD_INSERT_LIBRARIES`, no libraries not signed by Apple. The Node.js options built into it (in `sea-config.json`) can't be changed or added to: `NODE_OPTIONS` is ignored, `SIGUSR1` opens no debugger, it never turns text into code, never loads add-ons, and never takes compiled code from the compile cache or files from `OPENSSL_CONF` or `NODE_ICU_DATA`. It throws away its environment as it starts (`src/env.mjs`). What Node.js itself reads from it before that can't make it write anywhere: it never writes warnings (`NODE_REDIRECT_WARNINGS`) or coverage files (`NODE_V8_COVERAGE`), and it won't run with a channel to whoever started it or as a cluster worker (`NODE_CHANNEL_FD`, `NODE_UNIQUE_ID`).
- `test/program.sh` checks all of that on each kind of Mac, every time it's built.
- The installer only installs the build its own lines name (`helper_build` and the checksums in `install.sh`). After a new build is published, a small pull request changes them (docs/LAUNCH.md, "Updating the Mac helper").
- While working on it, run it with Node.js: `node mac-helper/helper.mjs serve` (or `code`, `status`). That one takes `ARISE_HELPER_HOME` and `ARISE_ORIGINS` (for Arise on localhost). Don't give Node.js Full Disk Access for it: that's the weakness the signed program removes.
