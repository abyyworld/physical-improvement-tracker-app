# Arise Mac helper

Lets Arise, open in Chrome or Edge on your Mac, add your calls (including missed calls from your iPhone), notifications, messages, Safari history and app use to your life log. It reads them on the Mac only. Nothing leaves the Mac except through Arise's own end-to-end encrypted sync. Everything starts off: you turn on what you want in Arise, under Settings, Your life, Mac.

Install or update it by pasting this in Terminal:

```
cd "$(mktemp -d)" && curl -fsSL https://github.com/abyyworld/physical-improvement-tracker-app/archive/refs/heads/main.tar.gz | tar xz && bash physical-improvement-tracker-app-main/mac-helper/install.sh
```

Then give Full Disk Access to `~/.arise-helper/node/bin/node` (System Settings, Privacy & Security, Full Disk Access) and enter the pairing code in Arise.

- See the code again: `bash ~/.arise-helper/arise-helper.sh code`
- Check on it: `bash ~/.arise-helper/arise-helper.sh status`
- Remove it: `bash ~/.arise-helper/arise-helper.sh uninstall`

Safari doesn't let a website reach a helper on the Mac, so use Chrome or Edge for this.
