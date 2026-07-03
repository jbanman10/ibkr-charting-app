// Rasterize icon.svg at the standard Windows icon sizes and pack them into
// build/icon.ico (electron-builder picks it up via build.win.icon).
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const svgPath = fileURLToPath(new URL('../icon.svg', import.meta.url));
const outDir = fileURLToPath(new URL('../build', import.meta.url));
const outPath = fileURLToPath(new URL('../build/icon.ico', import.meta.url));

const svg = await readFile(svgPath);
const sizes = [16, 24, 32, 48, 64, 128, 256];

const pngs = await Promise.all(
  sizes.map((s) => sharp(svg, { density: 300 }).resize(s, s).png().toBuffer())
);

await mkdir(outDir, { recursive: true });
await writeFile(outPath, await pngToIco(pngs));
console.log(`icon.ico written (${sizes.join(', ')} px)`);
