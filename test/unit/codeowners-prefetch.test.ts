import { describe, expect, it, vi, afterEach } from "vitest";
import {
  matchCodeownersViolations,
  prefetchCodeownersFindings,
} from "../../src/review/codeowners-prefetch";
import { scanCodeowners } from "../../review-enrichment/src/analyzers/codeowners.js";

describe("codeowners-prefetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matchCodeownersViolations reports author-absent files and skips unowned paths", () => {
    const content = [
      "src/ @team-leads",
      "docs/ @docs-team",
    ].join("\n");
    expect(
      matchCodeownersViolations(content, "dev1", [
        { path: "src/a.ts" },
        { path: "docs/guide.txt" },
        { path: "unowned.txt" },
      ]),
    ).toEqual([
      { file: "src/a.ts", owners: ["@team-leads"] },
      { file: "docs/guide.txt", owners: ["@docs-team"] },
    ]);
    expect(matchCodeownersViolations("", "dev1", [{ path: "a.ts" }])).toEqual(
      [],
    );
    expect(
      matchCodeownersViolations("* @team\n", "@team", [{ path: "a.ts" }]),
    ).toEqual([]);
  });

  it("matchCodeownersViolations caps reported files", () => {
    const content = "*.ts @owners\n";
    const files = Array.from({ length: 25 }, (_, i) => ({
      path: `src/f${i}.ts`,
    }));
    expect(matchCodeownersViolations(content, "outsider", files)).toHaveLength(
      20,
    );
  });

  it("prefetchCodeownersFindings returns [] without token, author, or valid repo", async () => {
    await expect(
      prefetchCodeownersFindings("org/app", "dev1", [{ path: "a.ts" }], ""),
    ).resolves.toEqual([]);
    await expect(
      prefetchCodeownersFindings("org/app", "", [{ path: "a.ts" }], "token"),
    ).resolves.toEqual([]);
    await expect(
      prefetchCodeownersFindings("bad repo", "dev1", [{ path: "a.ts" }], "token"),
    ).resolves.toEqual([]);
  });

  it("prefetchCodeownersFindings tries fallback paths and handles fetch failures", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes("/contents/.github/CODEOWNERS")) {
        return { ok: false, text: async () => "" } as Response;
      }
      if (String(url).includes("/contents/CODEOWNERS")) {
        throw new Error("network");
      }
      if (String(url).includes("/contents/docs/CODEOWNERS")) {
        return {
          ok: true,
          text: async () => "src/ @owners\n",
        } as Response;
      }
      return { ok: false, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    await expect(
      prefetchCodeownersFindings(
        "org/app",
        "dev1",
        [{ path: "src/x.ts" }],
        "token",
      ),
    ).resolves.toEqual([{ file: "src/x.ts", owners: ["@owners"] }]);
  });

  it("prefetchCodeownersFindings returns [] when every CODEOWNERS path fails", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      text: async () => "",
    })) as unknown as typeof fetch;
    await expect(
      prefetchCodeownersFindings(
        "org/app",
        "dev1",
        [{ path: "src/x.ts" }],
        "token",
      ),
    ).resolves.toEqual([]);
  });

  it("prefetchCodeownersFindings passes abort signal to fetch", async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(init).toEqual(
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      return {
        ok: true,
        text: async () => "* @team\n",
      } as Response;
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    await prefetchCodeownersFindings(
      "org/app",
      "outsider",
      [{ path: "any.ts" }],
      "token",
      fetch,
      controller.signal,
    );
  });
});

describe("scanCodeowners (REES prefetch contract)", () => {
  it("returns prefetched findings or [] when absent", async () => {
    const findings = [{ file: "src/a.ts", owners: ["@team"] }];
    await expect(
      scanCodeowners(
        {
          repoFullName: "org/app",
          prNumber: 1,
          prefetch: { codeowners: findings },
        },
        fetch,
      ),
    ).resolves.toEqual(findings);
    await expect(
      scanCodeowners({ repoFullName: "org/app", prNumber: 1 }, fetch),
    ).resolves.toEqual([]);
  });
});
