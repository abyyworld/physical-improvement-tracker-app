# Arise has moved

Arise now lives at **[github.com/abyyworld/arise](https://github.com/abyyworld/arise)**, and the app at **[abyyworld.github.io/arise](https://abyyworld.github.io/arise/)**.

This small repo keeps the old address working, so nothing already installed breaks:

- Every page of abyyworld.github.io/physical-improvement-tracker-app opens the same page under /arise/, shared links included.
- Copies installed on a home screen (or as an app on a computer) keep working here with their own saved data: the site here is a full, up-to-date build of Arise. Only those stay; anything else moves on.
- Older iPhone and Android apps still find their updates here (copies of `native/latest.json` and its zip), and the downloads of the newest `Arise.ipa` and `Arise.apk` are copied to the releases here too. Once an app has updated, it looks at the new address by itself.
- Older one-line commands (the Mac helper's installer, the Workers setup, the local AI script) run the new ones.

The copies are refreshed every 6 hours by `.github/workflows/mirror.yml`. Don't turn it off or delete this repo while old copies may still be around.
