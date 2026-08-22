/**
 * Renders the app icons from the lucide "bell-ring" glyph — the console has
 * no other artwork, and this keeps the home-screen icon the same bell staff
 * see in the sidebar. Run once with `npm run make-icons` and commit the
 * outputs: the build must never depend on sharp being installable.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = process.cwd();
if (!existsSync(path.join(ROOT, "package.json"))) {
  throw new Error("Run from the console directory (npm run make-icons)");
}

const PRIMARY = "#2f6fed";

// lucide-react v1.29 "bell-ring", 24-unit box, stroke 2.
const BELL = [
  "M10.268 21a2 2 0 0 0 3.464 0",
  "M22 8c0-2.3-.8-4.3-2-6",
  "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
  "M4 2C2.8 3.7 2 5.7 2 8",
];

/**
 * @param glyph fraction of the canvas the 24-unit glyph box occupies
 * @param radius corner radius in px (0 = square; iOS rounds its own corners)
 */
function svg(size: number, glyph: number, radius: number): string {
  const box = size * glyph;
  const scale = box / 24;
  const offset = (size - box) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${PRIMARY}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    ${BELL.map((d) => `<path d="${d}"/>`).join("\n    ")}
  </g>
</svg>
`;
}

async function png(file: string, size: number, glyph: number, radius: number) {
  const out = path.join(ROOT, file);
  mkdirSync(path.dirname(out), { recursive: true });
  await sharp(Buffer.from(svg(size, glyph, radius))).png().toFile(out);
  console.log(`wrote ${file}`);
}

async function main() {
  // Manifest icons ("any"): rounded square, glyph fills most of it.
  await png("public/icons/icon-192.png", 192, 0.66, 192 * 0.2);
  await png("public/icons/icon-512.png", 512, 0.66, 512 * 0.2);
  // Maskable: full-bleed square; Android crops it to a circle or squircle, so
  // the glyph stays inside the inner ~80% safe zone.
  await png("public/icons/icon-512-maskable.png", 512, 0.5, 0);
  // iOS home-screen icon: square corners, iOS applies its own mask.
  await png("src/app/apple-icon.png", 180, 0.66, 0);
  // Tab icon. PNG rather than SVG: Safari does not render SVG favicons.
  await png("src/app/icon.png", 64, 0.66, 64 * 0.2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
