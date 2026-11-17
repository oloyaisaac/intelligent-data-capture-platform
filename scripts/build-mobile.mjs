#!/usr/bin/env node
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

const root = resolve(process.cwd(), 'apps', 'mobile');

function buildAndroid() {
  console.log('Building Android APK...');
  const androidDir = resolve(root, 'android');
  if (!existsSync(androidDir)) throw new Error('Android scaffold not found');

  // In real CI, this would be:
  // execSync('gradlew assembleRelease', { cwd: androidDir });
  console.log('✅ Android build scaffold ready (gradlew assembleRelease)');
}

function buildIOS() {
  console.log('Building iOS IPA...');
  const iosDir = resolve(root, 'ios');
  if (!existsSync(iosDir)) throw new Error('iOS scaffold not found');

  // In real CI, this would be:
  // execSync('xcodebuild -workspace IDCPMobile.xcworkspace -scheme IDCPMobile -configuration Release archive', { cwd: iosDir });
  console.log('✅ iOS build scaffold ready (xcodebuild archive)');
}

const args = process.argv.slice(2);
if (args.includes('--android')) buildAndroid();
if (args.includes('--ios')) buildIOS();
if (!args.length) {
  console.log('Usage: node scripts/build-mobile.mjs [--android] [--ios]');
}
