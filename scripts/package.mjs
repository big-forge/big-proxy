// Packages a built Go binary into what gets released.
//   node scripts/package.mjs mac arm64 0.2.0 dist/bin/proxyapp      -> release/Proxy-App-0.2.0-mac-arm64.{zip,dmg}
//   node scripts/package.mjs windows x64 0.2.0 dist/bin/proxyapp.exe -> release/Proxy-App-0.2.0-windows-x64.zip
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [target, arch, version, binary] = process.argv.slice(2);
if (!target || !arch || !version || !binary) {
  console.error('usage: package.mjs <mac|windows> <arch> <version> <binary>');
  process.exit(1);
}
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
fs.mkdirSync('release', { recursive: true });
const work = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || '/tmp', 'pa-pkg-'));

if (target === 'mac') {
  const app = path.join(work, 'Proxy App.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  fs.copyFileSync(binary, path.join(app, 'Contents', 'MacOS', 'Proxy App'));
  fs.chmodSync(path.join(app, 'Contents', 'MacOS', 'Proxy App'), 0o755);

  // icon.icns from the 1024px PNG
  const iconset = path.join(work, 'AppIcon.iconset');
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 64, 128, 256, 512]) {
    run('sips', ['-z', String(size), String(size), 'build/icon.png', '--out', path.join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
    run('sips', ['-z', String(size * 2), String(size * 2), 'build/icon.png', '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', path.join(app, 'Contents', 'Resources', 'AppIcon.icns')]);

  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Proxy App</string>
  <key>CFBundleDisplayName</key><string>Proxy App</string>
  <key>CFBundleIdentifier</key><string>app.proxyapp.desktop</string>
  <key>CFBundleExecutable</key><string>Proxy App</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`,
  );
  // Ad-hoc signature: keeps the bundle intact so macOS only shows the usual one-time prompt.
  run('codesign', ['--force', '--deep', '--sign', '-', app]);

  const base = `Proxy-App-${version}-mac-${arch}`;
  const zip = path.resolve('release', `${base}.zip`);
  fs.rmSync(zip, { force: true });
  run('ditto', ['-c', '-k', '--keepParent', app, zip]); // the updater swaps this in place

  const dmgDir = path.join(work, 'dmg');
  fs.mkdirSync(dmgDir);
  run('ditto', [app, path.join(dmgDir, 'Proxy App.app')]);
  fs.symlinkSync('/Applications', path.join(dmgDir, 'Applications'));
  const dmg = path.resolve('release', `${base}.dmg`);
  fs.rmSync(dmg, { force: true });
  run('hdiutil', ['create', '-volname', `Proxy App ${version}`, '-srcfolder', dmgDir, '-ov', '-format', 'UDZO', dmg], { stdio: 'ignore' });
  console.log(`Wrote ${zip}\nWrote ${dmg}`);
} else if (target === 'windows') {
  fs.copyFileSync(binary, path.join(work, 'Proxy App.exe'));
  const zip = path.resolve('release', `Proxy-App-${version}-windows-${arch}.zip`);
  fs.rmSync(zip, { force: true });
  run('tar', ['-a', '-c', '-f', zip, '-C', work, 'Proxy App.exe']);
  console.log(`Wrote ${zip}`);
} else {
  console.error(`unknown target ${target}`);
  process.exit(1);
}
fs.rmSync(work, { recursive: true, force: true });
