import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pluginGradle = resolve(
  process.cwd(),
  'node_modules',
  '@ascentio-it',
  'capacitor-bluetooth-serial',
  'android',
  'build.gradle',
);

if (!existsSync(pluginGradle)) {
  throw new Error(`Bluetooth plugin Gradle file not found: ${pluginGradle}`);
}

const source = readFileSync(pluginGradle, 'utf8');
const obsoleteSetting = /getDefaultProguardFile\s*\(\s*["']proguard-android\.txt["']\s*\)/g;
const replacement = "getDefaultProguardFile('proguard-android-optimize.txt')";

if (obsoleteSetting.test(source)) {
  const patched = source.replace(obsoleteSetting, replacement);
  writeFileSync(pluginGradle, patched, 'utf8');
  console.log('Updated Bluetooth plugin to use proguard-android-optimize.txt.');
} else if (source.includes('proguard-android.txt')) {
  throw new Error('Bluetooth plugin uses the obsolete ProGuard file in an unsupported form.');
} else {
  console.log('Bluetooth plugin ProGuard configuration is already compatible.');
}
