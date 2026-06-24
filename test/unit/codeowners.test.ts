import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRepoCodeowners, matchCodeowners, parseCodeowners, type CodeownersRule } from "../../src/github/codeowners";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseCodeowners", () => {
  it("skips blank lines and comments while preserving rule order", () => {
    const content = ["# comment", "", "   # indented", "* @global", "/src @core @backup", "docs/ @docs"].join("\n");
    expect(parseCodeowners(content)).toEqual<CodeownersRule[]>([
      { pattern: "*", owners: ["@global"] },
      { pattern: "/src", owners: ["@core", "@backup"] },
      { pattern: "docs/", owners: ["@docs"] },
    ]);
  });

  it("keeps patterns with no owners", () => {
    expect(parseCodeowners("/vendor/")).toEqual<CodeownersRule[]>([{ pattern: "/vendor/", owners: [] }]);
  });

  it("keeps non-comment owner-like tokens as patterns", () => {
    expect(parseCodeowners("@docs-owner")).toEqual<CodeownersRule[]>([{ pattern: "@docs-owner", owners: [] }]);
  });
});

describe("matchCodeowners", () => {
  it("applies last-match-wins", () => {
    const rules = parseCodeowners(["* @global", "/src @src-team", "/src/api @api-team"].join("\n"));
    expect(matchCodeowners(rules, "src/api/handler.ts")).toEqual(["@api-team"]);
    expect(matchCodeowners(rules, "src/util.ts")).toEqual(["@src-team"]);
    expect(matchCodeowners(rules, "package.json")).toEqual(["@global"]);
  });

  it("supports anchored, directory, wildcard, and recursive rules", () => {
    expect(matchCodeowners(parseCodeowners("/build/ @builders"), "build/output.js")).toEqual(["@builders"]);
    expect(matchCodeowners(parseCodeowners("/build/ @builders"), "packages/app/build/output.js")).toEqual([]);
    expect(matchCodeowners(parseCodeowners("docs/ @docs"), "docs/guide/intro.md")).toEqual(["@docs"]);
    expect(matchCodeowners(parseCodeowners("*.ts @ts"), "src/index.ts")).toEqual(["@ts"]);
    expect(matchCodeowners(parseCodeowners("/apps/**/config.yml @platform"), "apps/web/deep/config.yml")).toEqual(["@platform"]);
  });

  it("keeps shallow wildcard rules from matching nested files", () => {
    const owners = parseCodeowners("docs/* docs@example.com");
    expect(matchCodeowners(owners, "docs/getting-started.md")).toEqual(["docs@example.com"]);
    expect(matchCodeowners(owners, "docs/build-app/troubleshooting.md")).toEqual([]);
  });

  it("matches directory names anywhere when the rule is an unanchored directory", () => {
    const owners = parseCodeowners("apps/ @octocat");
    expect(matchCodeowners(owners, "apps/index.ts")).toEqual(["@octocat"]);
    expect(matchCodeowners(owners, "packages/web/apps/index.ts")).toEqual(["@octocat"]);
    expect(matchCodeowners(owners, "apps")).toEqual([]);
  });

  it("matches terminal literal patterns as directory prefixes", () => {
    const owners = parseCodeowners(["**/logs @octocat", "/apps/github @doctocat"].join("\n"));
    expect(matchCodeowners(owners, "build/logs/debug.txt")).toEqual(["@octocat"]);
    expect(matchCodeowners(owners, "apps/github/service.ts")).toEqual(["@doctocat"]);
  });

  it("normalizes paths and handles root-only patterns", () => {
    expect(matchCodeowners(parseCodeowners("/ @root"), "./src\\worker.ts")).toEqual(["@root"]);
    expect(matchCodeowners(parseCodeowners("/* @root"), "/README.md")).toEqual(["@root"]);
    expect(matchCodeowners(parseCodeowners("   /   @root"), "docs/guide.md")).toEqual(["@root"]);
    expect(matchCodeowners(parseCodeowners("* @global"), "")).toEqual([]);
  });

  it("ignores blank rules and supports slash-stripped and recursive-star patterns", () => {
    expect(matchCodeowners([{ pattern: "   ", owners: ["@nobody"] }], "src/index.ts")).toEqual([]);
    expect(matchCodeowners([{ pattern: "///", owners: ["@root"] }], "docs/guide.md")).toEqual(["@root"]);
    expect(matchCodeowners(parseCodeowners("**.ts @typescript"), "deep/nested/file.ts")).toEqual(["@typescript"]);
  });

  it("rejects oversized patterns and non-matching recursive patterns", () => {
    expect(matchCodeowners([{ pattern: `${"a".repeat(513)}`, owners: ["@nobody"] }], "src/index.ts")).toEqual([]);
    expect(matchCodeowners(parseCodeowners("/src/**/config.yml @config"), "src/api/README.md")).toEqual([]);
  });

  it("matches repeated wildcard states without backtracking-sensitive regexes", () => {
    expect(matchCodeowners(parseCodeowners("a*a*a @owner"), "src/aaa")).toEqual(["@owner"]);
    expect(matchCodeowners(parseCodeowners("a*a*a @owner"), "src/bbb")).toEqual([]);
  });

  it("memoizes recursive directory and segment wildcard states", () => {
    expect(matchCodeowners(parseCodeowners("**/**/target.ts @owner"), "src/deep/target.ts")).toEqual(["@owner"]);
    expect(matchCodeowners(parseCodeowners("*a*a*a* @owner"), "src/aaaa")).toEqual(["@owner"]);
  });
});

describe("loadRepoCodeowners", () => {
  it("returns [] for invalid repo names", async () => {
    await expect(loadRepoCodeowners({} as Env, "invalid")).resolves.toEqual([]);
    await expect(loadRepoCodeowners({} as Env, "/repo")).resolves.toEqual([]);
    await expect(loadRepoCodeowners({} as Env, "owner/")).resolves.toEqual([]);
  });

  it("falls back across candidate files and ignores blank responses", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      calls.push(url);
      if (url.endsWith("/.github/CODEOWNERS")) return new Response(" ", { status: 200 });
      if (url.endsWith("/docs/CODEOWNERS")) return new Response("/src/ @docs-owner\n", { status: 200 });
      if (url.endsWith("/CODEOWNERS")) return new Response("not found", { status: 404 });
      return new Response("nope", { status: 404 });
    });

    await expect(loadRepoCodeowners({} as Env, "acme/widgets")).resolves.toEqual([{ pattern: "/src/", owners: ["@docs-owner"] }]);
    expect(calls).toHaveLength(3);
  });

  it("loads CODEOWNERS from the requested ref instead of HEAD", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      calls.push(url);
      if (url.endsWith("/release%2F1.2/.github/CODEOWNERS")) return new Response("/src/ @release-owner\n", { status: 200 });
      return new Response("missing", { status: 404 });
    });

    await expect(loadRepoCodeowners({} as Env, "acme/widgets", { ref: "release/1.2" })).resolves.toEqual([{ pattern: "/src/", owners: ["@release-owner"] }]);
    expect(calls[0]).toContain("/release%2F1.2/.github/CODEOWNERS");
  });

  it("falls back to the authenticated contents API for private repos", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/main/.github/CODEOWNERS")) return new Response("missing", { status: 404 });
      if (url.includes("/contents/.github/CODEOWNERS?ref=main")) return new Response("/src/ @private-owner\n", { status: 200 });
      return new Response("missing", { status: 404 });
    });

    await expect(loadRepoCodeowners(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), "acme/widgets", { installationId: 99, ref: "main" })).resolves.toEqual([
      { pattern: "/src/", owners: ["@private-owner"] },
    ]);
    expect(calls.some((url) => url.includes("/contents/.github/CODEOWNERS?ref=main"))).toBe(true);
  });

  it("continues across authenticated empty and non-ok candidate responses", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/contents/.github/CODEOWNERS?ref=main")) return new Response("missing", { status: 404 });
      if (url.includes("/contents/CODEOWNERS?ref=main")) return new Response(" ", { status: 200 });
      if (url.includes("/contents/docs/CODEOWNERS?ref=main")) return new Response("/docs/ @docs-owner\n", { status: 200 });
      return new Response("missing", { status: 404 });
    });

    await expect(loadRepoCodeowners(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), "acme/widgets", { installationId: 100, ref: "main" })).resolves.toEqual([
      { pattern: "/docs/", owners: ["@docs-owner"] },
    ]);
    expect(calls.some((url) => url.includes("/contents/.github/CODEOWNERS?ref=main"))).toBe(true);
    expect(calls.some((url) => url.includes("/contents/CODEOWNERS?ref=main"))).toBe(true);
    expect(calls.some((url) => url.includes("/contents/docs/CODEOWNERS?ref=main"))).toBe(true);
  });

  it("returns [] when every candidate fails or throws", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/.github/CODEOWNERS")) throw new Error("network");
      if (url.endsWith("/CODEOWNERS")) return new Response("", { status: 200 });
      return new Response("missing", { status: 404 });
    });

    await expect(loadRepoCodeowners({} as Env, "acme/widgets")).resolves.toEqual([]);
  });
});

async function generatePrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const base64 = Buffer.from(exported as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n");
  const pemLabel = "PRIVATE KEY";
  const boundary = (kind: "BEGIN" | "END") => ["-----", kind, " ", pemLabel, "-----"].join("");
  return [boundary("BEGIN"), base64, boundary("END")].join("\n");
}
