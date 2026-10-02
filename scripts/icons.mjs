// Renders the app icon, tray icons and favicon from one glyph: a source that
// branches to three exits, one of them live. Run: npm run icons
import fs from 'node:fs';
import sharp from 'sharp';

const AQUA = '#35c6b8';

function glyph({ base, live, dim = 0.45, liveOpacity = 1 }) {
  // Dim parts share one group opacity so overlapping strokes don't double up.
  return `
    <g opacity="${dim}">
      <path d="M7.4 12H10.5M10.5 12L16.6 6M10.5 12L16.6 18" stroke="${base}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <circle cx="19" cy="6" r="2" fill="${base}"/>
      <circle cx="19" cy="18" r="2" fill="${base}"/>
    </g>
    <circle cx="5" cy="12" r="2.4" fill="${base}"/>
    <g opacity="${liveOpacity}">
      <path d="M10.5 12H16.6" stroke="${live}" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="19" cy="12" r="2.2" fill="${live}"/>
    </g>`;
}

// macOS grid: 824px rounded square inside a 1024 canvas.
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="186" fill="#151a1e"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="185.5" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>
  <g transform="translate(512 512) scale(23) translate(-12 -12)">${glyph({ base: '#e6eaed', live: AQUA })}</g>
</svg>`;

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect width="24" height="24" rx="5.5" fill="#151a1e"/>
  <g transform="translate(12 12) scale(0.78) translate(-12 -12)">${glyph({ base: '#e6eaed', live: AQUA })}</g>
</svg>`;

const tray = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`;

fs.mkdirSync('build/tray', { recursive: true });
fs.mkdirSync('src/ui/public', { recursive: true });

fs.writeFileSync('build/icon.svg', appIcon);
await sharp(Buffer.from(appIcon)).png().toFile('build/icon.png');
fs.writeFileSync('src/ui/public/favicon.svg', favicon);

const variants = {
  // macOS template images: black + alpha only; the system tints them.
  trayOnTemplate: tray(glyph({ base: '#000', live: '#000', dim: 0.5 })),
  trayOffTemplate: tray(glyph({ base: '#000', live: '#000', dim: 0.35, liveOpacity: 0.35 })),
  // Windows / Linux notification area.
  'tray-on': tray(glyph({ base: '#9aa4ad', live: AQUA, dim: 0.8 })),
  'tray-off': tray(glyph({ base: '#9aa4ad', live: '#9aa4ad', dim: 0.6, liveOpacity: 0.6 })),
};
for (const [name, svg] of Object.entries(variants)) {
  await sharp(Buffer.from(svg), { density: 300 }).resize(16, 16).png().toFile(`build/tray/${name}.png`);
  await sharp(Buffer.from(svg), { density: 600 }).resize(32, 32).png().toFile(`build/tray/${name}@2x.png`);
}
// Browser extension toolbar + store icons.
fs.mkdirSync('extension/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await sharp(Buffer.from(favicon), { density: 72 * Math.ceil(size / 12) }).resize(size, size).png().toFile(`extension/icons/${size}.png`);
}

// Windows icon: a 256px PNG inside an ICO container (valid since Vista).
const png256 = await sharp(Buffer.from(appIcon)).resize(256, 256).png().toBuffer();
const ico = Buffer.alloc(22 + png256.length);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; ico[7] = 0; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png256.length, 14); ico.writeUInt32LE(22, 18);
png256.copy(ico, 22);
fs.writeFileSync('build/icon.ico', ico);

console.log('Icons written to build/, src/ui/public/ and extension/icons/');
