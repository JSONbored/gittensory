#!/usr/bin/env node
// Regenerates the MV3 icon set (#4862) from the repo's own brand asset -- never hand-drawn/synthesized
// geometry, so the extension's icon is always the same mark as apps/gittensory-ui's favicon. Standard
// Chrome/Firefox MV3 sizes: 16 (toolbar/favicon), 32 (Windows/high-DPI toolbar), 48 (extensions page),
// 128 (Chrome Web Store listing + install dialog).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const sourceIcon = resolve(here, "../../gittensory-ui/public/favicon-512.png");
const sizes = [16, 32, 48, 128];

await Promise.all(
  sizes.map((size) =>
    sharp(sourceIcon)
      .resize(size, size)
      .png()
      .toFile(resolve(here, `icon-${size}.png`)),
  ),
);

console.log(`wrote icon-${sizes.join(".png, icon-")}.png from ${sourceIcon}`);
