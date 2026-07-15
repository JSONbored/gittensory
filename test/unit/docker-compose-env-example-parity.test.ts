import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Drift guard for #5814: docker-compose.yml's own header calls .env.example "the exhaustive reference", but
// ~18 variables compose actually interpolates were documented nowhere — the whole --profile backup block, the
// AMS exporter path overrides, the OTEL metrics-side siblings, PROMETHEUS_RETENTION_TIME, REES_MEM_LIMIT. This
// is a distinct check from `npm run selfhost:env-reference`, which scans process.env reads under
// src/selfhost/** and never looks at docker-compose.yml or .env.example at all.
//
// Every compose variable must be documented in .env.example (live `NAME=` or commented `# NAME=`) or, for the
// Docker-secrets `*_FILE` vars deliberately kept out of the sample file, in secrets/README.md's table.

const ROOT = process.cwd();
const composeText = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const envExampleText = readFileSync(join(ROOT, ".env.example"), "utf8");
const secretsReadmeText = readFileSync(join(ROOT, "secrets/README.md"), "utf8");

/**
 * `${VAR}` / `${VAR:-default}` / `${VAR:?err}` that compose really interpolates.
 *
 * The negative lookbehind is load-bearing: compose escapes a literal `$` as `$$`, so `$${GF_SECURITY_ADMIN_PASSWORD:-}`
 * is passed through to the container's shell and resolved there — it is NOT a compose variable, and demanding
 * `.env.example` document it would be wrong.
 */
function composeInterpolatedVars(compose: string): string[] {
  return [...new Set([...compose.matchAll(/(?<!\$)\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]!))].sort();
}

/** Live `NAME=` and commented `# NAME=` reference lines alike — both count as documented. */
function documentedInEnvExample(envExample: string): Set<string> {
  return new Set([...envExample.matchAll(/^\s*#?\s*([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
}

/** The `*_FILE` vars in secrets/README.md's table, intentionally documented there instead of .env.example. */
function documentedInSecretsReadme(secretsReadme: string): Set<string> {
  return new Set([...secretsReadme.matchAll(/\b([A-Z_][A-Z0-9_]*_FILE)\b/g)].map((m) => m[1]!));
}

function undocumentedComposeVars(compose: string, envExample: string, secretsReadme: string): string[] {
  const documented = documentedInEnvExample(envExample);
  const secrets = documentedInSecretsReadme(secretsReadme);
  return composeInterpolatedVars(compose).filter((name) => !documented.has(name) && !secrets.has(name));
}

describe("docker-compose.yml ↔ .env.example parity (#5814)", () => {
  it("finds the compose variables at all (guards the parser itself, so the check can't pass vacuously)", () => {
    const vars = composeInterpolatedVars(composeText);
    expect(vars.length).toBeGreaterThan(50);
    expect(vars).toContain("PROMETHEUS_RETENTION_TIME");
    expect(documentedInEnvExample(envExampleText).size).toBeGreaterThan(50);
    expect(documentedInSecretsReadme(secretsReadmeText)).toContain("GITHUB_APP_PRIVATE_KEY_FILE");
  });

  it("ignores $$-escaped shell variables, which compose never interpolates", () => {
    // `$${FOO}` reaches the container's shell as `${FOO}`; only the un-escaped `${BAR}` is a compose var.
    expect(composeInterpolatedVars('a: "$${FOO:-x}"\nb: "${BAR:-y}"')).toEqual(["BAR"]);
  });

  it("INVARIANT: every compose variable is documented in .env.example or secrets/README.md", () => {
    expect(undocumentedComposeVars(composeText, envExampleText, secretsReadmeText)).toEqual([]);
  });

  it("catches a real gap: a variable dropped from .env.example is reported (proves the guard works)", () => {
    // Strip PROMETHEUS_RETENTION_TIME's documentation line — the check must notice.
    const stripped = envExampleText
      .split("\n")
      .filter((line) => !/^\s*#?\s*PROMETHEUS_RETENTION_TIME=/.test(line))
      .join("\n");
    expect(undocumentedComposeVars(composeText, stripped, secretsReadmeText)).toEqual(["PROMETHEUS_RETENTION_TIME"]);
  });

  it("counts a *_FILE secret as documented via secrets/README.md, not .env.example", () => {
    const compose = 'x: "${GITHUB_APP_PRIVATE_KEY_FILE}"';
    expect(undocumentedComposeVars(compose, "", secretsReadmeText)).toEqual([]);
    // …and reports it when it is documented in neither.
    expect(undocumentedComposeVars(compose, "", "")).toEqual(["GITHUB_APP_PRIVATE_KEY_FILE"]);
  });
});
