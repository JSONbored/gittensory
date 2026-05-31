import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "apps/gittensory-extension");
const outDir = resolve(root, "apps/gittensory-extension/dist/package");
const zipPath = resolve(root, "apps/gittensory-ui/public/downloads/gittensory-extension.zip");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(dirname(zipPath), { recursive: true });

for (const file of ["manifest.json", "background.js", "content.js", "styles.css", "options.html", "options.js"]) {
  cpSync(resolve(source, file), resolve(outDir, file));
}

rmSync(zipPath, { force: true });
const zipped = spawnSync("zip", ["-qr", zipPath, "."], { cwd: outDir, stdio: "inherit" });
if (zipped.status !== 0) {
  throw new Error("zip command failed while packaging the Gittensory extension");
}

console.log(`wrote ${zipPath.replace(`${root}/`, "")}`);
