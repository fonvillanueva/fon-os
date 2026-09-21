/**
 * Generates every Fon's OS icon asset from a single vector source.
 *
 * Run with: npm run icons
 *
 * Design: charcoal rounded square, electric-blue geometric "F", and a block
 * command cursor resting on the F's baseline. The mark is kept inside a
 * 363px radius of the 1024px canvas centre, well within the 409.6px maskable
 * safe circle, so iOS and Android can crop without clipping anything.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");

// Mark geometry on the 1024x1024 canvas.
const MARK_PATH = "M307 212 H692 V348 H444 V444 H632 V572 H444 V812 H307 Z";
const CURSOR = { x: 578, y: 673, size: 139, radius: 10 };

/**
 * @param {{ rounded: boolean }} opts - `rounded` bakes in the rounded-square
 *   corners (favicons, manifest "any" icons). Square/full-bleed is used where
 *   the platform applies its own mask (apple-touch-icon, maskable icons).
 */
function buildSvg({ rounded }) {
  const r = rounded ? 224 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="Fon's OS">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#15181F"/>
      <stop offset="0.55" stop-color="#0D0F14"/>
      <stop offset="1" stop-color="#07080B"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.44" cy="0.40" r="0.62">
      <stop offset="0" stop-color="#3B9EFF" stop-opacity="0.22"/>
      <stop offset="0.55" stop-color="#3B9EFF" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#3B9EFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="mark" x1="0.1" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#63CDFF"/>
      <stop offset="1" stop-color="#1E7BFF"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="${r}" ry="${r}" fill="url(#bg)"/>
  <rect width="1024" height="1024" rx="${r}" ry="${r}" fill="url(#glow)"/>
  <path d="${MARK_PATH}" fill="url(#mark)"/>
  <rect x="${CURSOR.x}" y="${CURSOR.y}" width="${CURSOR.size}" height="${CURSOR.size}" rx="${CURSOR.radius}" ry="${CURSOR.radius}" fill="#6FD3FF"/>
</svg>`;
}

const ROUNDED = Buffer.from(buildSvg({ rounded: true }));
const SQUARE = Buffer.from(buildSvg({ rounded: false }));

const png = (source, size) =>
  sharp(source, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

/** Packs PNGs into a multi-resolution .ico container. */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const directory = entries.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette colours
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...directory, ...entries.map((e) => e.data)]);
}

async function main() {
  await mkdir(PUBLIC, { recursive: true });

  // Vector masters.
  await writeFile(join(PUBLIC, "icon-master.svg"), ROUNDED);
  await writeFile(join(PUBLIC, "favicon.svg"), ROUNDED);

  // Raster master + manifest icons (rounded corners baked in).
  for (const size of [1024, 512, 192]) {
    await writeFile(join(PUBLIC, `icon-${size}.png`), await png(ROUNDED, size));
  }

  // Platform-masked icons: full-bleed square, mark inside the safe circle.
  await writeFile(join(PUBLIC, "apple-touch-icon.png"), await png(SQUARE, 180));
  await writeFile(join(PUBLIC, "icon-maskable-512.png"), await png(SQUARE, 512));

  // Favicons.
  const favicons = [];
  for (const size of [16, 32, 48]) {
    const data = await png(ROUNDED, size);
    await writeFile(join(PUBLIC, `favicon-${size}.png`), data);
    favicons.push({ size, data });
  }
  await writeFile(join(PUBLIC, "favicon.ico"), buildIco(favicons));

  console.log("Icon assets written to public/");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
