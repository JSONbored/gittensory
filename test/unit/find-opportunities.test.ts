import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FIND_OPPORTUNITIES_LANGUAGE_LENGTH,
  MAX_FIND_OPPORTUNITIES_LANGUAGES,
  MAX_FIND_OPPORTUNITIES_OWNER_LENGTH,
  MAX_FIND_OPPORTUNITIES_REPO_LENGTH,
  MAX_FIND_OPPORTUNITIES_TARGETS,
  normalizeFindOpportunitiesLimit,
  publicRankScore,
  runFindOpportunities,
  validateFindOpportunitiesInput,
} from "../../src/mcp/find-opportunities";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createInstallationToken } from "../../src/github/app";
import { createTestEnv } from "../helpers/d1";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  createInstallationToken: vi.fn(async () => "unused-token"),
}));

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ai-policy");

function readFixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: {
      "x-ratelimit-remaining": "42",
      "x-ratelimit-reset": "1800000000",
      ...(init.headers ?? {}),
    },
  });
}

function contentResponse(content: string) {
  return jsonResponse({
    type: "file",
    encoding: "base64",
    content: Buffer.from(content, "utf8").toString("base64"),
  });
}

const issue = (number: number) => ({
  number,
  title: `Issue ${number}`,
  labels: ["good first issue"],
  comments: 1,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T01:00:00Z",
  html_url: `https://github.com/acme/allowed/issues/${number}`,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(createInstallationToken).mockReset();
  vi.mocked(createInstallationToken).mockImplementation(async () => "unused-token");
});

describe("validateFindOpportunitiesInput", () => {
  it("requires targets or searchQuery", () => {
    expect(validateFindOpportunitiesInput({})).toEqual({ ok: false, reason: "targets_or_search_query_required" });
  });

  it("rejects invalid targets and oversized search queries", () => {
    expect(validateFindOpportunitiesInput({ targets: [{ owner: "", repo: "demo" }] })).toEqual({ ok: false, reason: "invalid_target" });
    expect(validateFindOpportunitiesInput({ targets: [{ owner: 123 as unknown as string, repo: "demo" }] })).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(validateFindOpportunitiesInput({ targets: [{ owner: "acme", repo: 456 as unknown as string }] })).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(
      validateFindOpportunitiesInput({
        targets: Array.from({ length: MAX_FIND_OPPORTUNITIES_TARGETS + 1 }, () => ({ owner: "acme", repo: "demo" })),
      }),
    ).toEqual({ ok: false, reason: "too_many_targets" });
    expect(
      validateFindOpportunitiesInput({ targets: [{ owner: "x".repeat(MAX_FIND_OPPORTUNITIES_OWNER_LENGTH + 1), repo: "demo" }] }),
    ).toEqual({ ok: false, reason: "owner_too_long" });
    expect(
      validateFindOpportunitiesInput({ targets: [{ owner: "acme", repo: "x".repeat(MAX_FIND_OPPORTUNITIES_REPO_LENGTH + 1) }] }),
    ).toEqual({ ok: false, reason: "repo_too_long" });
    expect(validateFindOpportunitiesInput({ searchQuery: "x".repeat(501) })).toEqual({ ok: false, reason: "search_query_too_long" });
    expect(
      validateFindOpportunitiesInput({ searchQuery: "docs", goalSpec: { minRankScore: 101 } }),
    ).toEqual({ ok: false, reason: "invalid_min_rank_score" });
    expect(validateFindOpportunitiesInput({ searchQuery: "docs", goalSpec: { languages: [""] } })).toEqual({
      ok: false,
      reason: "invalid_languages",
    });
  });

  it("accepts trimmed targets and search queries", () => {
    const parsed = validateFindOpportunitiesInput({
      targets: [{ owner: " acme ", repo: " widgets " }],
      goalSpec: { lane: "docs", minRankScore: 40 },
      limit: 3,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.targets?.[0]).toEqual({ owner: "acme", repo: "widgets" });
      expect(parsed.value.goalSpec).toEqual({ lane: "docs", minRankScore: 40 });
      expect(parsed.value.limit).toBe(3);
    }
  });

  it("deduplicates targets before downstream authorization and lookup work", () => {
    const parsed = validateFindOpportunitiesInput({
      targets: [
        { owner: " acme ", repo: " widgets " },
        { owner: "ACME", repo: "widgets" },
        { owner: "acme", repo: "other" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.targets).toEqual([
        { owner: "acme", repo: "widgets" },
        { owner: "acme", repo: "other" },
      ]);
    }
  });

  it("accepts exactly MAX_FIND_OPPORTUNITIES_TARGETS targets (boundary, not just the +1 overflow)", () => {
    const parsed = validateFindOpportunitiesInput({
      targets: Array.from({ length: MAX_FIND_OPPORTUNITIES_TARGETS }, (_, i) => ({ owner: "acme", repo: `demo${i}` })),
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.targets).toHaveLength(MAX_FIND_OPPORTUNITIES_TARGETS);
  });

  it("rejects a non-array goalSpec.languages", () => {
    expect(
      validateFindOpportunitiesInput({ searchQuery: "docs", goalSpec: { languages: "typescript" as unknown as string[] } }),
    ).toEqual({ ok: false, reason: "invalid_languages" });
  });

  it("rejects a non-string language entry", () => {
    expect(
      validateFindOpportunitiesInput({ searchQuery: "docs", goalSpec: { languages: [123 as unknown as string] } }),
    ).toEqual({ ok: false, reason: "invalid_languages" });
  });

  it("rejects more than MAX_FIND_OPPORTUNITIES_LANGUAGES languages", () => {
    expect(
      validateFindOpportunitiesInput({
        searchQuery: "docs",
        goalSpec: { languages: Array.from({ length: MAX_FIND_OPPORTUNITIES_LANGUAGES + 1 }, (_, i) => `lang${i}`) },
      }),
    ).toEqual({ ok: false, reason: "invalid_languages" });
  });

  it("rejects a language entry longer than MAX_FIND_OPPORTUNITIES_LANGUAGE_LENGTH", () => {
    expect(
      validateFindOpportunitiesInput({
        searchQuery: "docs",
        goalSpec: { languages: ["x".repeat(MAX_FIND_OPPORTUNITIES_LANGUAGE_LENGTH + 1)] },
      }),
    ).toEqual({ ok: false, reason: "invalid_languages" });
  });

  it("accepts a valid languages list at or under the boundary", () => {
    const parsed = validateFindOpportunitiesInput({
      searchQuery: "docs",
      goalSpec: { languages: ["typescript", "x".repeat(MAX_FIND_OPPORTUNITIES_LANGUAGE_LENGTH)] },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.goalSpec).toEqual({ languages: ["typescript", "x".repeat(MAX_FIND_OPPORTUNITIES_LANGUAGE_LENGTH)] });
  });
});

describe("find-opportunities helpers", () => {
  it("normalizes limits and public rank scores", () => {
    expect(normalizeFindOpportunitiesLimit(undefined)).toBe(5);
    expect(normalizeFindOpportunitiesLimit(99)).toBe(50);
    expect(normalizeFindOpportunitiesLimit(0)).toBe(1);
    expect(publicRankScore(0.876)).toBe(88);
    expect(publicRankScore(Number.NaN)).toBe(0);
  });
});

describe("runFindOpportunities", () => {
  it("hard-skips banned repos before returning ranked opportunities", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "test-token" });
    const bannedPolicy = readFixture("banned-ai-usage.md");
    const allowedPolicy = readFixture("allowed-silent.md");

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/banned/contents/AI-USAGE.md")) return contentResponse(bannedPolicy);
      if (url.includes("/repos/acme/banned/issues?")) throw new Error("banned repo must be hard-skipped");
      if (url.includes("/repos/acme/allowed/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/allowed/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/allowed/issues?")) return jsonResponse([issue(7)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await runFindOpportunities(env, {
      targets: [
        { owner: "acme", repo: "banned" },
        { owner: "acme", repo: "allowed" },
      ],
    });

    expect(result.status).toBe("ok");
    expect(result.ranked.map((entry) => `${entry.owner}/${entry.repo}#${entry.issueNumber}`)).toEqual(["acme/allowed#7"]);
    expect(result.ranked.every((entry) => entry.aiPolicyAllowed === true)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/wallet|hotkey|reward estimate/i);
  });

  it("returns github_token_unavailable when no token and no installed targets", async () => {
    const env = createTestEnv();
    const result = await runFindOpportunities(env, { targets: [{ owner: "missing", repo: "repo" }] });
    expect(result).toMatchObject({
      status: "github_token_unavailable",
      ranked: [],
      totalCandidates: 0,
      reason: "github_token_unavailable",
    });
  });

  it("checks access only once for duplicate targets", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "test-token" });
    const allowedPolicy = readFixture("allowed-silent.md");
    const accessChecks: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/allowed/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/allowed/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/allowed/issues?")) return jsonResponse([issue(5)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await runFindOpportunities(
      env,
      {
        targets: [
          { owner: "acme", repo: "allowed" },
          { owner: "ACME", repo: "allowed" },
        ],
      },
      {
        canAccessRepo: async (repoFullName) => {
          accessChecks.push(repoFullName);
          return true;
        },
      },
    );

    expect(result.status).toBe("ok");
    expect(accessChecks).toEqual(["acme/allowed"]);
  });

  it("filters inaccessible targets via canAccessRepo", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "test-token" });
    await upsertRepositoryFromGitHub(env, { name: "allowed", full_name: "acme/allowed" });
    const allowedPolicy = readFixture("allowed-silent.md");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/allowed/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/allowed/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/allowed/issues?")) return jsonResponse([issue(3)]);
      return jsonResponse({}, { status: 404 });
    });

    const blocked = await runFindOpportunities(env, { targets: [{ owner: "acme", repo: "blocked" }] }, { canAccessRepo: async () => false });
    expect(blocked).toMatchObject({ status: "invalid_request", reason: "no_accessible_targets" });

    const allowed = await runFindOpportunities(env, { targets: [{ owner: "acme", repo: "allowed" }] }, { canAccessRepo: async () => true });
    expect(allowed.status).toBe("ok");
    expect(allowed.ranked).toHaveLength(1);
  });

  it("returns invalid_request end-to-end when neither targets nor searchQuery are provided", async () => {
    const env = createTestEnv();
    const result = await runFindOpportunities(env, {});
    expect(result).toEqual({
      status: "invalid_request",
      ranked: [],
      totalCandidates: 0,
      reason: "targets_or_search_query_required",
    });
  });

  it("resolves issues via the searchQuery path instead of targets", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "test-token" });
    const allowedPolicy = readFixture("allowed-silent.md");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/issues?")) {
        return jsonResponse({ items: [{ ...issue(21), repository: { full_name: "acme/searched" } }] });
      }
      if (url.includes("/repos/acme/searched/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/searched/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      return jsonResponse({}, { status: 404 });
    });

    const result = await runFindOpportunities(env, { searchQuery: "improve docs" });

    expect(result.status).toBe("ok");
    expect(result.ranked.map((entry) => `${entry.owner}/${entry.repo}#${entry.issueNumber}`)).toEqual(["acme/searched#21"]);
  });

  it("re-filters searchQuery results through canAccessRepo after retrieval", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "test-token" });
    const allowedPolicy = readFixture("allowed-silent.md");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/issues?")) {
        return jsonResponse({
          items: [
            { ...issue(22), repository: { full_name: "acme/searched" } },
            { ...issue(23), repository: { full_name: "acme/other" } },
          ],
        });
      }
      if (url.includes("/repos/acme/searched/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/searched/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/other/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/other/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      return jsonResponse({}, { status: 404 });
    });

    const result = await runFindOpportunities(
      env,
      { searchQuery: "improve docs" },
      { canAccessRepo: async (repoFullName) => repoFullName === "acme/searched" },
    );

    expect(result.status).toBe("ok");
    expect(result.ranked.map((entry) => `${entry.owner}/${entry.repo}`)).toEqual(["acme/searched"]);
  });

  it("narrows lane fit and reports appliedLane when goalSpec.lane is set", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "test-token" });
    const allowedPolicy = readFixture("allowed-silent.md");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/allowed/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/allowed/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/allowed/issues?")) return jsonResponse([issue(9)]);
      return jsonResponse({}, { status: 404 });
    });

    const unscoped = await runFindOpportunities(env, { targets: [{ owner: "acme", repo: "allowed" }] });
    const scoped = await runFindOpportunities(env, {
      targets: [{ owner: "acme", repo: "allowed" }],
      goalSpec: { lane: "documentation" },
    });

    expect(unscoped.appliedLane).toBeUndefined();
    expect(scoped.appliedLane).toBe("documentation");
    expect(scoped.ranked[0]?.rankScore).toBeLessThan(unscoped.ranked[0]?.rankScore ?? 0);
  });

  it("builds wantedPaths globs from goalSpec.languages when no lane is set", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "test-token" });
    const allowedPolicy = readFixture("allowed-silent.md");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/allowed/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/allowed/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/allowed/issues?")) return jsonResponse([issue(11)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await runFindOpportunities(env, {
      targets: [{ owner: "acme", repo: "allowed" }],
      goalSpec: { languages: ["typescript"] },
    });

    expect(result.status).toBe("ok");
    expect(result.appliedLane).toBeUndefined();
    expect(result.ranked).toHaveLength(1);
  });

  it("reports appliedMinRankScore when set, and omits it (and appliedLane) when neither is set", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "test-token" });
    const allowedPolicy = readFixture("allowed-silent.md");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/allowed/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/allowed/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/allowed/issues?")) return jsonResponse([issue(13)]);
      return jsonResponse({}, { status: 404 });
    });

    const withMinScore = await runFindOpportunities(env, {
      targets: [{ owner: "acme", repo: "allowed" }],
      goalSpec: { minRankScore: 10 },
    });
    expect(withMinScore.appliedMinRankScore).toBe(10);
    expect(withMinScore.appliedLane).toBeUndefined();

    const bare = await runFindOpportunities(env, { targets: [{ owner: "acme", repo: "allowed" }] });
    expect(bare.appliedMinRankScore).toBeUndefined();
    expect(bare.appliedLane).toBeUndefined();
  });

  it("skips repos without an installation, falls through a failing token mint, and uses the first token that resolves", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "broken-install", full_name: "acme/broken-install" }, 111);
    await upsertRepositoryFromGitHub(env, { name: "good-install", full_name: "acme/good-install" }, 222);
    const bannedPolicy = readFixture("banned-ai-usage.md");
    const allowedPolicy = readFixture("allowed-silent.md");
    vi.mocked(createInstallationToken).mockImplementation(async (_env, installationId) => {
      if (installationId === 111) throw new Error("mint failed");
      return "good-token";
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/no-install/contents/AI-USAGE.md")) return contentResponse(bannedPolicy);
      if (url.includes("/repos/acme/broken-install/contents/AI-USAGE.md")) return contentResponse(bannedPolicy);
      if (url.includes("/repos/acme/good-install/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/good-install/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/good-install/issues?")) return jsonResponse([issue(31)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await runFindOpportunities(env, {
      targets: [
        { owner: "acme", repo: "no-install" },
        { owner: "acme", repo: "broken-install" },
        { owner: "acme", repo: "good-install" },
      ],
    });

    expect(result.status).toBe("ok");
    expect(result.ranked.map((entry) => `${entry.owner}/${entry.repo}#${entry.issueNumber}`)).toEqual(["acme/good-install#31"]);
    expect(vi.mocked(createInstallationToken)).toHaveBeenCalledWith(env, 111);
    expect(vi.mocked(createInstallationToken)).toHaveBeenCalledWith(env, 222);
  });

  it("continues with a null token when a target has a repo record but no installation to mint against", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "no-token-install", full_name: "acme/no-token-install" });
    const allowedPolicy = readFixture("allowed-silent.md");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/no-token-install/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/no-token-install/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/no-token-install/issues?")) return jsonResponse([issue(41)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await runFindOpportunities(env, { targets: [{ owner: "acme", repo: "no-token-install" }] });

    expect(result.status).toBe("ok");
    expect(result.ranked.map((entry) => `${entry.owner}/${entry.repo}#${entry.issueNumber}`)).toEqual(["acme/no-token-install#41"]);
    expect(vi.mocked(createInstallationToken)).not.toHaveBeenCalled();
  });

  it("continues with a null token on the searchQuery path when no public token or targets are configured", async () => {
    const env = createTestEnv();
    const allowedPolicy = readFixture("allowed-silent.md");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/issues?")) {
        return jsonResponse({ items: [{ ...issue(42), repository: { full_name: "acme/searched" } }] });
      }
      if (url.includes("/repos/acme/searched/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/searched/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      return jsonResponse({}, { status: 404 });
    });

    const result = await runFindOpportunities(env, { searchQuery: "improve docs" });

    expect(result.status).toBe("ok");
    expect(result.ranked.map((entry) => `${entry.owner}/${entry.repo}#${entry.issueNumber}`)).toEqual(["acme/searched#42"]);
  });

  it("surfaces fetch warnings in the result when GitHub errors on an allowed repo's issues", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "test-token" });
    const allowedPolicy = readFixture("allowed-silent.md");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/allowed/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/allowed/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/allowed/issues?")) return jsonResponse({}, { status: 500 });
      return jsonResponse({}, { status: 404 });
    });

    const result = await runFindOpportunities(env, { targets: [{ owner: "acme", repo: "allowed" }] });

    expect(result.status).toBe("ok");
    expect(result.ranked).toEqual([]);
    expect(result.warnings).toEqual([{ repoFullName: "acme/allowed", stage: "issues", message: "GitHub returned 500" }]);
  });
});
