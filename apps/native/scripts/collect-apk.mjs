// After an Android build: copies the APK to release/Atrium.apk, and says whether it's signed (it is
// when apps/native/signing holds the key — see the README).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

const dir = 'src-tauri/gen/android/app/build/outputs/apk/universal/release';
const signed = `${dir}/app-universal-release.apk`;
const unsigned = `${dir}/app-universal-release-unsigned.apk`;

mkdirSync('release', { recursive: true });
if (existsSync(signed)) {
  copyFileSync(signed, 'release/Atrium.apk');
  console.log('Signed APK: release/Atrium.apk');
} else if (existsSync(unsigned)) {
  copyFileSync(unsigned, 'release/Atrium-unsigned.apk');
  console.log('No signing key in apps/native/signing, so the APK is unsigned: release/Atrium-unsigned.apk');
} else {
  console.error('No APK found');
  process.exit(1);
}
