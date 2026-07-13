import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const EXTENSION_DIR = "apps/gittensory-miner-extension";
const ICON_SIZES = [16, 32, 48, 128];

describe("miner extension icon set (#4862)", () => {
  const manifest = JSON.parse(readFileSync(`${EXTENSION_DIR}/manifest.json`, "utf8"));

  it("wires every icon size into the manifest's top-level icons and action.default_icon", () => {
    for (const size of ICON_SIZES) {
      const path = `icons/icon-${size}.png`;
      expect(manifest.icons[String(size)]).toBe(path);
      expect(manifest.action.default_icon[String(size)]).toBe(path);
    }
  });

  it("ships a real PNG at the declared size for every icon", async () => {
    for (const size of ICON_SIZES) {
      const metadata = await sharp(`${EXTENSION_DIR}/icons/icon-${size}.png`).metadata();
      expect(metadata.format).toBe("png");
      expect(metadata.width).toBe(size);
      expect(metadata.height).toBe(size);
    }
  });

  it("packages every icon file into the built zip's PACKAGE_FILES list", () => {
    const buildScript = readFileSync("scripts/build-miner-extension.mjs", "utf8");
    for (const size of ICON_SIZES) {
      expect(buildScript).toContain(`icons/icon-${size}.png`);
    }
  });

  it("regenerates the icons from the repo's own brand asset, not a hand-drawn/synthesized source", () => {
    const generator = readFileSync(`${EXTENSION_DIR}/icons/generate-icons.mjs`, "utf8");
    expect(generator).toContain("favicon-512.png");
    expect(generator).toContain("sharp");
  });
});
