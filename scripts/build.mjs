// Builds everything into dist/: the UI (Vite), the CLI and the Electron main process (esbuild).
import { build } from 'esbuild';
import fs from 'node:fs';
import { build as viteBuild } from 'vite';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
fs.rmSync('dist', { recursive: true, force: true });

await viteBuild({ configFile: 'vite.config.ts', logLevel: 'warn' });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  legalComments: 'none',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
};

await build({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.cjs', banner: { js: '#!/usr/bin/env node' } });
await build({ ...common, entryPoints: ['src/electron/main.ts'], outfile: 'dist/electron/main.cjs', external: ['electron', 'electron-updater'] });
fs.chmodSync('dist/cli.cjs', 0o755);

fs.mkdirSync('dist/electron/assets', { recursive: true });
for (const file of fs.readdirSync('build/tray')) fs.copyFileSync(`build/tray/${file}`, `dist/electron/assets/${file}`);
fs.copyFileSync('build/icon.png', 'dist/electron/assets/icon.png');
fs.cpSync('extension', 'dist/extension', { recursive: true });
// The extension ships with the app, so it carries the app's version.
const manifest = JSON.parse(fs.readFileSync('dist/extension/manifest.json', 'utf8'));
fs.writeFileSync('dist/extension/manifest.json', JSON.stringify({ ...manifest, version: pkg.version }, null, 2));

console.log(`Built Proxy App ${pkg.version} into dist/`);
