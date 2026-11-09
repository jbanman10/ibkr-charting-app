// Rasterize icon.svg into the two icon files electron-builder needs:
//   build/icon.ico — Windows, via build.win.icon
//   build/icon.png — macOS, via build.mac.icon (electron-builder converts
//                    PNG → .icns itself, so we don't need `iconutil`, which is
//                    macOS-only and would break this script on Windows)
// Both come from the same vector source, so there is no upscaling loss and the
// two platforms can't drift apart.
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const svgPath = fileURLToPath(new URL('../icon.svg', import.meta.url));
const outDir = fileURLToPath(new URL('../build', import.meta.url));
const icoPath = fileURLToPath(new URL('../build/icon.ico', import.meta.url));
const pngPath = fileURLToPath(new URL('../build/icon.png', import.meta.url));

const svg = await readFile(svgPath);
const sizes = [16, 24, 32, 48, 64, 128, 256];

// 1024 is what macOS wants for Retina; electron-builder requires >= 512.
const MAC_SIZE = 1024;

const [pngs, macPng] = await Promise.all([
  Promise.all(sizes.map((s) => sharp(svg, { density: 300 }).resize(s, s).png().toBuffer())),
  sharp(svg, { density: 300 }).resize(MAC_SIZE, MAC_SIZE).png().toBuffer(),
]);

await mkdir(outDir, { recursive: true });
await Promise.all([
  writeFile(icoPath, await pngToIco(pngs)),
  writeFile(pngPath, macPng),
]);
console.log(`icon.ico written (${sizes.join(', ')} px)`);
console.log(`icon.png written (${MAC_SIZE}×${MAC_SIZE}, for macOS .icns)`);
