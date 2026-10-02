// electron-builder afterPack hook. Without a Developer ID, electron-builder
// skips signing and leaves Electron's original signature broken, which macOS
// reports as "app is damaged". An ad-hoc signature keeps the bundle intact,
// so people only see the usual "Open Anyway" prompt.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // real signing is configured
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
