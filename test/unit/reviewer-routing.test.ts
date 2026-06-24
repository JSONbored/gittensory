import { describe, expect, it } from "vitest";
import { parseCodeowners } from "../../src/github/codeowners";
import {
  buildReviewerRouting,
  isFirstTimeExternalContributor,
  REVIEWER_BUSY_OPEN_PR_THRESHOLD,
  selectAutoRequestReviewerLogins,
} from "../../src/signals/reviewer-routing";
import type { BurdenForecast } from "../../src/signals/engine";
import type { PullRequestRecord } from "../../src/types";

function openPr(authorLogin: string, number: number): PullRequestRecord {
  return { repoFullName: "acme/widget", number, title: `PR ${number}`, state: "open", authorLogin, labels: [], linkedIssues: [] };
}

describe("buildReviewerRouting", () => {
  it("ranks suggestions by matched-file count", () => {
    const rules = parseCodeowners(["/src/api/ @api-owner", "/src/web/ @web-owner"].join("\n"));
    const routing = buildReviewerRouting({
      rules,
      changedPaths: ["src/api/a.ts", "src/api/b.ts", "src/web/c.ts"],
      openPullRequests: [],
    });
    expect(routing.suggestions.map((s) => s.login)).toEqual(["api-owner", "web-owner"]);
    expect(routing.suggestions[0]).toMatchObject({ login: "api-owner", matchedFileCount: 2 });
  });

  it("de-weights busy owners at equal match count", () => {
    const rules = parseCodeowners(["/a/ @busy", "/b/ @light"].join("\n"));
    const openPullRequests = [...Array.from({ length: REVIEWER_BUSY_OPEN_PR_THRESHOLD }, (_, i) => openPr("busy", 100 + i)), openPr("light", 1)];
    const routing = buildReviewerRouting({ rules, changedPaths: ["a/x.ts", "b/y.ts"], openPullRequests });
    expect(routing.suggestions.map((s) => [s.login, s.loadBand])).toEqual([
      ["light", "light"],
      ["busy", "busy"],
    ]);
  });

  it("still sorts light owners ahead when the busy owner is encountered later", () => {
    const rules = parseCodeowners(["/b/ @light", "/a/ @busy"].join("\n"));
    const openPullRequests = [...Array.from({ length: REVIEWER_BUSY_OPEN_PR_THRESHOLD }, (_, i) => openPr("busy", 200 + i)), openPr("light", 2)];
    const routing = buildReviewerRouting({ rules, changedPaths: ["a/x.ts", "b/y.ts"], openPullRequests });
    expect(routing.suggestions.map((s) => [s.login, s.loadBand])).toEqual([
      ["light", "light"],
      ["busy", "busy"],
    ]);
  });

  it("excludes the PR author and separates teams", () => {
    const rules = parseCodeowners("/src/ @org/platform-team @alice @self");
    const routing = buildReviewerRouting({ rules, changedPaths: ["src/x.ts"], openPullRequests: [], authorLogin: "@self" });
    expect(routing.suggestions.map((s) => s.login)).toEqual(["alice"]);
    expect(routing.teams).toEqual(["org/platform-team"]);
  });

  it("excludes the author case-insensitively and de-duplicates mixed-case owners across files", () => {
    const rules = parseCodeowners(["/src/a/ @Alice @StatXC", "/src/b/ @alice @statxc"].join("\n"));
    const routing = buildReviewerRouting({
      rules,
      changedPaths: ["src/a/one.ts", "src/b/two.ts"],
      openPullRequests: [],
      authorLogin: "@STATXC",
    });

    expect(routing.suggestions).toEqual([
      expect.objectContaining({ login: "Alice", matchedFileCount: 2, loadBand: "light" }),
    ]);
  });

  it("carries repo load context and caps suggestions", () => {
    const owners = Array.from({ length: 8 }, (_, i) => `@owner${i}`);
    const routing = buildReviewerRouting({
      rules: parseCodeowners(owners.map((owner, i) => `/p${i}/ ${owner}`).join("\n")),
      changedPaths: owners.flatMap((_, i) => [`p${i}/a.ts`, `p${i}/b.ts`]),
      openPullRequests: [],
      burdenForecast: { level: "high" } as BurdenForecast,
    });
    expect(routing.repoLoadLevel).toBe("high");
    expect(routing.suggestions).toHaveLength(5);
    expect(routing.summary).toMatch(/suggested 5 reviewers/i);
  });

  it("returns team-only and empty summaries when no user suggestions are available", () => {
    const teamOnly = buildReviewerRouting({
      rules: parseCodeowners("/src/ @org/platform-team"),
      changedPaths: ["src/x.ts"],
      openPullRequests: [],
    });
    expect(teamOnly.suggestions).toEqual([]);
    expect(teamOnly.teams).toEqual(["org/platform-team"]);
    expect(teamOnly.summary).toMatch(/matched 1 codeowners team/i);

    const none = buildReviewerRouting({ rules: [], changedPaths: ["src/x.ts"], openPullRequests: [] });
    expect(none.repoLoadLevel).toBeNull();
    expect(none.summary).toMatch(/no codeowners reviewers matched/i);
  });

  it("handles empty changed paths and open pull requests", () => {
    const routing = buildReviewerRouting({
      rules: parseCodeowners("/src/ @alice"),
      changedPaths: [],
      openPullRequests: [],
    });
    expect(routing.suggestions).toEqual([]);
    expect(routing.teams).toEqual([]);
    expect(routing.repoLoadLevel).toBeNull();
    expect(routing.summary).toMatch(/no codeowners reviewers matched/i);
  });

  it("ignores non-user owners in CODEOWNERS entries", () => {
    const routing = buildReviewerRouting({
      rules: parseCodeowners("/src/ alice @org/platform-team @bob"),
      changedPaths: ["src/x.ts"],
      openPullRequests: [],
    });
    expect(routing.suggestions.map((suggestion) => suggestion.login)).toEqual(["bob"]);
    expect(routing.teams).toEqual(["org/platform-team"]);
  });

  it("sorts equal-load suggestions alphabetically and pluralizes multi-team summaries", () => {
    const tied = buildReviewerRouting({
      rules: parseCodeowners(["/src/a/ @zeta", "/src/b/ @alpha"].join("\n")),
      changedPaths: ["src/a/one.ts", "src/b/two.ts"],
      openPullRequests: [{ ...openPr("", 1), state: "closed" }, { ...openPr("", 2), authorLogin: "" }],
    });
    expect(tied.suggestions.map((suggestion) => suggestion.login)).toEqual(["alpha", "zeta"]);

    const teamOnly = buildReviewerRouting({
      rules: parseCodeowners("/src/ @org/platform-team @org/api-team"),
      changedPaths: ["src/example.ts"],
      openPullRequests: [],
    });
    expect(teamOnly.summary).toMatch(/matched 2 codeowners teams/i);
  });
});

describe("selectAutoRequestReviewerLogins", () => {
  const reviewerRouting = {
    suggestions: [
      { login: "alice", matchedFileCount: 2, loadBand: "light" as const, reason: "Owns 2 changed files." },
      { login: "Bob", matchedFileCount: 1, loadBand: "busy" as const, reason: "Owns 1 changed file." },
    ],
    teams: ["org/platform-team"],
    repoLoadLevel: null,
    summary: "Suggested 2 reviewers from CODEOWNERS for the changed files.",
  };

  it("only returns reviewers under auto_request mode", () => {
    expect(selectAutoRequestReviewerLogins({ mode: "off", reviewerRouting, mergedPrCount: 1 })).toEqual([]);
    expect(selectAutoRequestReviewerLogins({ mode: "advisory", reviewerRouting, mergedPrCount: 1 })).toEqual([]);
    expect(selectAutoRequestReviewerLogins({ mode: "auto_request", reviewerRouting, mergedPrCount: 1 })).toEqual(["alice", "Bob"]);
  });

  it("never auto-requests for first-time external contributors", () => {
    expect(isFirstTimeExternalContributor("NONE", 0)).toBe(true);
    expect(isFirstTimeExternalContributor(" first_timer ", 0)).toBe(true);
    expect(isFirstTimeExternalContributor("FIRST_TIME_CONTRIBUTOR", 0)).toBe(true);
    expect(isFirstTimeExternalContributor("MEMBER", 0)).toBe(false);
    expect(isFirstTimeExternalContributor(null, 0)).toBe(false);
    expect(selectAutoRequestReviewerLogins({ mode: "auto_request", reviewerRouting, authorAssociation: "NONE", mergedPrCount: 0 })).toEqual([]);
  });

  it("filters already-requested reviewers case-insensitively and preserves order", () => {
    expect(
      selectAutoRequestReviewerLogins({
        mode: "auto_request",
        reviewerRouting,
        authorAssociation: "CONTRIBUTOR",
        mergedPrCount: 2,
        alreadyRequestedUsers: ["ALICE", "@bob"],
      }),
    ).toEqual([]);
    expect(
      selectAutoRequestReviewerLogins({
        mode: "auto_request",
        reviewerRouting,
        authorAssociation: "CONTRIBUTOR",
        mergedPrCount: 2,
        alreadyRequestedUsers: ["alice"],
      }),
    ).toEqual(["Bob"]);
  });

  it("ignores missing routing input and de-duplicates repeated suggestions", () => {
    expect(selectAutoRequestReviewerLogins({ mode: "auto_request", mergedPrCount: 1 })).toEqual([]);
    expect(selectAutoRequestReviewerLogins({ mode: "auto_request", mergedPrCount: 1, reviewerRouting: null, alreadyRequestedUsers: null })).toEqual([]);
    expect(isFirstTimeExternalContributor("", 0)).toBe(false);
    expect(
      selectAutoRequestReviewerLogins({
        mode: "auto_request",
        mergedPrCount: 1,
        reviewerRouting: {
          suggestions: [
            { login: "alice", matchedFileCount: 2, loadBand: "light", reason: "Owns 2 changed files." },
            { login: " alice ", matchedFileCount: 1, loadBand: "busy", reason: "Owns 1 changed file." },
            { login: "   ", matchedFileCount: 1, loadBand: "busy", reason: "Owns 1 changed file." },
          ],
          teams: [],
          repoLoadLevel: null,
          summary: "Suggested 2 reviewers from CODEOWNERS for the changed files.",
        },
      }),
    ).toEqual(["alice"]);
  });
});
