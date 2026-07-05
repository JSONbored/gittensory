// Units for the shared history-class skip predicate used by blame-link and churn-hotspot.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isHistoryUninformativePath } from "../dist/analyzers/history-path.js";

test("isHistoryUninformativePath skips the original lockfile / generated / dir set", () => {
  // Lockfiles from the original rule.
  for (const p of [
    "package-lock.json",
    "app/yarn.lock",
    "pkg/pnpm-lock.yaml",
    "poetry.lock",
    "svc/go.sum",
  ]) {
    assert.equal(isHistoryUninformativePath(p), true, p);
  }
  // Non-binary generated output and vendored/build directories.
  for (const p of [
    "flake.lock",
    "app.min.js",
    "bundle.js.map",
    "__snapshots__/x.snap",
    "icons/logo.svg",
    "dist/app.js",
    "build/out.js",
    "vendor/pkg/mod.go",
  ]) {
    assert.equal(isHistoryUninformativePath(p), true, p);
  }
});

test("isHistoryUninformativePath skips the full binary inventory, not just the original narrow list", () => {
  // Original narrow binaries still skip.
  for (const p of ["ui/logo.png", "fonts/Inter.woff2", "docs/spec.pdf"]) {
    assert.equal(isHistoryUninformativePath(p), true, p);
  }
  // Newly-covered shared-inventory binaries (were NOT in the original per-analyzer regex).
  for (const p of [
    "media/demo.mp4",
    "assets/hero.webp",
    "assets/photo.heic",
    "vendor/lib.wasm",
    "models/llama.safetensors",
    "models/model.gguf",
  ]) {
    assert.equal(isHistoryUninformativePath(p), true, p);
  }
});

test("isHistoryUninformativePath skips the full lockfile inventory (Cargo/Composer/Bun)", () => {
  for (const p of ["crates/api/Cargo.lock", "composer.lock", "bun.lockb"]) {
    assert.equal(isHistoryUninformativePath(p), true, p);
  }
});

test("isHistoryUninformativePath does not skip real source/doc files", () => {
  for (const p of [
    "src/index.ts",
    "packages/app/main.rs",
    "README.md",
    "Cargo.toml",
    "notes/cargo.lock.md",
  ]) {
    assert.equal(isHistoryUninformativePath(p), false, p);
  }
});
