# Development and building the apps

## Desktop (Windows) and phone (Android) apps

`apps/native` turns the web app into installable apps with [Tauri](https://tauri.app). On first launch
they ask for your server's address (e.g. `192.168.1.20:3000`, or `atrium.example.com`, which is tried
over HTTPS first). They then work like the website, and **keep working offline**:

- Every page, card, whiteboard and file you've opened is kept on the device (until you sign out), so it opens and can be edited
  without a connection. When the connection is back, offline edits merge with everyone else's (the
  documents are CRDTs, so edits from several people who were offline at the same time are combined
  rather than overwritten).
- Making, renaming, moving and deleting pages while offline is queued and sent in order once the server is
  reachable; anything the server refuses (e.g. the page was deleted meanwhile) is reported.
- The sidebar shows when you're offline and how many changes are waiting.

The web app gets the same offline behaviour for pages it has already loaded.

Building (on Windows, with Rust, Node.js, Visual Studio's C++ tools, and — for Android — Android Studio
with its SDK and NDK):

```bash
cd apps/native
npm install
npm run build:windows    # installer in src-tauri/target/release/bundle/nsis/
npm run build:android    # signed APK in release/Atrium.apk (see signing below)
```

For Android, set `JAVA_HOME` (Android Studio's `jbr` folder), `ANDROID_HOME` and `NDK_HOME` first, and
install the Rust targets with `rustup target add aarch64-linux-android armv7-linux-androideabi
i686-linux-android x86_64-linux-android`.

Android only installs signed apps. Put your signing key in `apps/native/signing/` (git ignores that folder) and
every `npm run build:android` signs the APK and copies it to `apps/native/release/Atrium.apk`:

- `release.jks` — the key. Make one once with
  `keytool -genkeypair -keystore release.jks -storetype PKCS12 -alias workspace -keyalg RSA -keysize 4096 -validity 10000`.
- `keystore.properties` — `storeFile=release.jks`, `storePassword=…`, `keyAlias=workspace`, `keyPassword=…`.

**Back both files up somewhere safe.** Phones only accept updates signed with the same key; if it's lost, people
have to uninstall the app (and its offline copy) before installing a newer one. Without the folder, the build
still works but the APK (`release/Atrium-unsigned.apk`) can't be installed until it's signed.

The universal APK holds all four processor types (~120 MB); `npm run build:android -- --split-per-abi`
makes one smaller APK per type (phones use `arm64-v8a`).

## Releases

There is no release workflow: each release is built on a developer machine and uploaded by hand.

1. Set the version everywhere with `node tools/set-version.mjs 1.11.4` (`server/package.json` is the source the
   server reads; CI checks they all match).
2. Build with `TAURI_SIGNING_PRIVATE_KEY` set to the updater key (`npm run build:windows`, then
   `npm run build:android`).
3. Upload the setup `.exe` as `Atrium-Windows-setup.exe`, its `.sig`, `Atrium.apk` and a `latest.json`
   (version, notes, date, and the `.exe`'s signature and address) to the GitHub release.

The Docker image (`ghcr.io/taidies/atrium`) is built by `.github/workflows/image.yml` when a version tag
is pushed.

## The website

The website is the static folder `site/` (its only build step copies INSTALL.md and FEATURES.md into it;
`marked` is vendored in `site/vendor/`, and no
fonts or scripts are loaded from other sites). On Vercel, set the project's **Root Directory** to `site`;
it is live at https://atrium-five-xi.vercel.app.

The architecture and how to run the server and web app for development are in the [README](../README.md).
