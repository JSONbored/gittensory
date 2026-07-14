import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const EXT = "apps/loopover-miner-extension";
const manifest = JSON.parse(readFileSync(`${EXT}/manifest.json`, "utf8"));

/** Parse a PNG's signature + IHDR (width/height/colorType) — enough to assert a real image of the expected size. */
function readPng(path: string): {
  valid: boolean;
  width: number;
  height: number;
  colorType: number;
} {
  const buf = readFileSync(path);
  const valid =
    buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
    buf.subarray(12, 16).toString("ascii") === "IHDR";
  return {
    valid,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25] ?? 0,
  };
}

describe("miner extension icons (#4862)", () => {
  const SIZES = [16, 32, 48, 128] as const;

  it("declares an icon set at the standard sizes in the manifest", () => {
    for (const size of SIZES) {
      expect(manifest.icons[String(size)]).toBe(`icons/icon-${size}.png`);
    }
  });

  it("wires the toolbar action's default_icon at 16/32/48", () => {
    for (const size of [16, 32, 48] as const) {
      expect(manifest.action.default_icon[String(size)]).toBe(
        `icons/icon-${size}.png`,
      );
    }
  });

  it("ships every declared icon as a real RGBA PNG whose dimensions match its declared size", () => {
    for (const size of SIZES) {
      const rel = manifest.icons[String(size)] as string;
      const path = `${EXT}/${rel}`;
      expect(existsSync(path), `${rel} exists`).toBe(true);
      const png = readPng(path);
      expect(png.valid, `${rel} is a valid PNG`).toBe(true);
      expect(png.width).toBe(size);
      expect(png.height).toBe(size);
      expect(png.colorType).toBe(6); // 6 = truecolor + alpha (RGBA)
    }
  });
});
