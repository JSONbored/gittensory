import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";

// Drift guard (#selfhost-runner-tmp): the self-hosting operations doc's multi-runner override snippet
// must stay in sync with docker-compose.yml's real x-runner-tmp-env anchor + runner-tmp-init pattern --
// mirrors the same source-of-truth-diff approach as docs-selfhost-troubleshooting-metric-names.test.ts.
// If the real compose pattern ever changes without the docs snippet changing too, this fails instead of
// operators copy-pasting a stale/incorrect multi-runner example.

const DOC_PATH = "apps/loopover-ui/src/routes/docs.self-hosting-operations.tsx";

function readYamlWithMerge(path: string): Record<string, unknown> {
  const doc = parseDocument(readFileSync(path, "utf8"), { merge: true });
  const value = doc.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a YAML object`);
  }
  return value as Record<string, unknown>;
}

describe("self-hosting-operations doc: runner temp storage guidance matches docker-compose.yml (#selfhost-runner-tmp)", () => {
  it("explains why runner temp must stay off overlay storage", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    expect(doc).toMatch(/runner-work/);
    expect(doc).toMatch(/overlay/);
    expect(doc).toContain("TMPDIR");
  });

  it("mentions the runner-tmp-init bootstrap mechanism by concept, not just by name", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    expect(doc).toContain("runner-tmp-init");
    expect(doc).toMatch(/before the runner container\s+starts/);
  });

  it("says Docker cleanup should prune containers/images/build cache, never volumes", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    expect(doc).toMatch(/containers, images, and build cache/i);
    expect(doc).toMatch(/never\s+volumes/i);
  });

  it("includes a multi-runner override snippet whose x-runner-tmp-env values match the real anchor in docker-compose.yml", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    const codeBlockMatch = /x-runner-tmp-env: &runner-tmp-env[\s\S]*?volumes:\n {2}runner-work-2:/.exec(doc);
    expect(codeBlockMatch, "expected a multi-runner CodeBlock snippet in the doc").not.toBeNull();
    const snippet = codeBlockMatch![0];

    const compose = readYamlWithMerge("docker-compose.yml");
    const realAnchor = compose["x-runner-tmp-env"] as Record<string, string>;
    expect(realAnchor.TMPDIR).toBeTruthy();

    for (const key of ["TMPDIR", "TMP", "TEMP"] as const) {
      expect(snippet, `docs snippet missing ${key}: ${realAnchor[key]}`).toContain(`${key}: ${realAnchor[key]}`);
    }
  });

  it("the doc's multi-runner snippet uses the same depends_on condition as the real runner service", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    const compose = readYamlWithMerge("docker-compose.yml");
    const services = compose.services as Record<string, Record<string, unknown>>;
    const runner = services.runner!;
    const dependsOn = runner.depends_on as Record<string, { condition?: string }>;
    const condition = Object.values(dependsOn)[0]?.condition;
    expect(condition).toBeTruthy();
    expect(doc).toContain(`condition: ${condition}`);
  });

  it("the doc's multi-runner snippet never mounts the Docker socket", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    const codeBlockMatch = /x-runner-tmp-env: &runner-tmp-env[\s\S]*?volumes:\n {2}runner-work-2:/.exec(doc);
    expect(codeBlockMatch).not.toBeNull();
    expect(codeBlockMatch![0]).not.toMatch(/docker\.sock/);
  });
});
