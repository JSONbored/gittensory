// Coverage for the IaC-misconfig analyzer's pure exports (#2096). Companion to iac-misconfig.test.ts (kept in
// its own file so concurrent analyzer PRs don't collide) covering the misconfig kinds that file does not yet
// exercise — the two-line correlation rules (wildcard-cors-credentials, insecure-cookie, prod-debug) and the
// single-line public-bucket / hardcoded-service-url rules — plus isRelevantConfigPath's relevant-vs-unrelated
// branches and the finding shape / stable ordering. Network wiring (scanIacMisconfig) is out of scope. Pure,
// no network. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isRelevantConfigPath,
  scanPatchForIacMisconfig,
} from "../dist/analyzers/iac-misconfig.js";

const patchOf = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("isRelevantConfigPath: recognizes IaC/config file types and rejects ordinary source", () => {
  for (const p of [
    "infra/main.tf",
    "k8s/deploy.yaml",
    "k8s/deploy.yml",
    "Dockerfile",
    "svc/Dockerfile.prod",
    "docker-compose.yml",
    "compose.prod.yaml",
    "helm/values.yaml",
    "helm/values.staging.yaml",
    ".env",
    ".env.production",
    "config/settings.json",
    "config/app.toml",
    "config/app.ini",
    "config/app.conf",
    "nginx.conf",
  ]) {
    assert.equal(isRelevantConfigPath(p), true, p);
  }
  for (const p of ["src/index.ts", "app/main.py", "README.md", "lib/util.go", "styles.css"]) {
    assert.equal(isRelevantConfigPath(p), false, p);
  }
});

test("scanPatchForIacMisconfig: flags wildcard CORS together with credentials (two-line correlation)", () => {
  const findings = scanPatchForIacMisconfig(
    "api/cors.yaml",
    patchOf(['access-control-allow-origin: "*"', "access-control-allow-credentials: true"]),
  );
  assert.deepEqual(findings, [
    { file: "api/cors.yaml", line: 2, kind: "wildcard-cors-credentials" },
  ]);
});

test("scanPatchForIacMisconfig: wildcard origin alone (no credentials) is not flagged as the CORS-credentials pair", () => {
  const findings = scanPatchForIacMisconfig("api/cors.yaml", patchOf(['access-control-allow-origin: "*"']));
  assert.deepEqual(
    findings.filter((f) => f.kind === "wildcard-cors-credentials"),
    [],
  );
});

test("scanPatchForIacMisconfig: flags SameSite=None without Secure=true as an insecure cookie (two-line)", () => {
  const findings = scanPatchForIacMisconfig(
    "app/session.yaml",
    patchOf(["sameSite: none", "secure: false"]),
  );
  assert.deepEqual(findings, [{ file: "app/session.yaml", line: 2, kind: "insecure-cookie" }]);
});

test("scanPatchForIacMisconfig: flags debug enabled in a production configuration (two-line)", () => {
  const findings = scanPatchForIacMisconfig(
    "config/app.yaml",
    patchOf(["NODE_ENV=production", "debug: true"]),
  );
  assert.deepEqual(findings, [{ file: "config/app.yaml", line: 2, kind: "prod-debug" }]);
});

test("scanPatchForIacMisconfig: flags a public object-storage ACL", () => {
  assert.deepEqual(scanPatchForIacMisconfig("infra/s3.tf", patchOf(['acl = "public-read"'])), [
    { file: "infra/s3.tf", line: 1, kind: "public-bucket" },
  ]);
  assert.deepEqual(scanPatchForIacMisconfig("infra/s3.tf", patchOf(["public_access = true"])), [
    { file: "infra/s3.tf", line: 1, kind: "public-bucket" },
  ]);
});

test("scanPatchForIacMisconfig: flags a hardcoded service URL in config", () => {
  assert.deepEqual(
    scanPatchForIacMisconfig("config/app.yaml", patchOf(["API_URL=https://api.example.com/v1"])),
    [{ file: "config/app.yaml", line: 1, kind: "hardcoded-service-url" }],
  );
});

test("scanPatchForIacMisconfig: a clean config patch produces no findings", () => {
  const findings = scanPatchForIacMisconfig(
    "config/app.yaml",
    patchOf(['name: "web"', "replicas: 3", "secure: true", "debug: false"]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForIacMisconfig: multiple distinct single-line misconfigs are reported in scan (line) order", () => {
  const findings = scanPatchForIacMisconfig(
    "infra/main.tf",
    patchOf(['acl = "public-read"', "API_URL=https://api.example.com/v1"]),
  );
  assert.deepEqual(findings, [
    { file: "infra/main.tf", line: 1, kind: "public-bucket" },
    { file: "infra/main.tf", line: 2, kind: "hardcoded-service-url" },
  ]);
});
