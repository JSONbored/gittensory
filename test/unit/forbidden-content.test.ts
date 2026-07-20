import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_CONTENT } from "../../scripts/forbidden-content.mjs";

// forbidden-content.mjs calls itself the single source of truth for the packaged secret-shape detector, but
// nothing enforced it: check-mcp-package.mjs re-declared the regex as its own local constant and the two could
// drift apart unnoticed (#6290). These assertions pin both halves of the claim -- the structural one (each
// checker imports the constant rather than owning a copy) and the behavioral one (each checker actually rejects
// what the shared detector matches).
const PACKAGE_CHECKERS = ["scripts/check-miner-package.mjs", "scripts/check-mcp-package.mjs"];

// A minimal file list that passes each checker's path/allowlist/required-file guards, so the run reaches the
// shared secret-content read. Mirrors the file lists each checker's own "rejects secret-like content" test uses.
const REACHABLE_FILES: Record<string, string[]> = {
  "scripts/check-miner-package.mjs": ["package.json", "bin/loopover-miner.js", "lib/cli.js"],
  "scripts/check-mcp-package.mjs": ["package.json", "bin/loopover-mcp.js"],
};

// Assembled from fragments so this file never itself contains a credential-shaped literal -- the same
// convention check-mcp-package.test.ts and check-miner-package.test.ts already use for their probes.
const SECRET_SHAPED_PROBE = ["PROBE", "_", "SECRET", "=", "value"].join("");

// Run a checker as a subprocess (never import it): both scripts run `npm pack` at import time, and neither has a
// .d.mts, so importing them from TS would also break the typecheck gate. Their env seams let a single file drive
// the whole file list + content.
function runChecker(
  checker: string,
  files: string[],
  content: string,
): { status: number; out: string } {
  const isMiner = checker.includes("miner");
  const env = {
    ...process.env,
    [isMiner ? "CHECK_MINER_PACK_TEST_FILES" : "CHECK_MCP_PACK_TEST_FILES"]: JSON.stringify(files),
    [isMiner ? "CHECK_MINER_PACK_TEST_CONTENT" : "CHECK_MCP_PACK_TEST_CONTENT"]: content,
  };
  try {
    return { status: 0, out: execFileSync(process.execPath, [checker], { encoding: "utf8", env }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("FORBIDDEN_CONTENT is the single source of truth (#6290)", () => {
  it.each(PACKAGE_CHECKERS)("%s imports the shared constant instead of re-declaring it", (checker) => {
    const source = readFileSync(checker, "utf8");
    expect(source).toContain('import { FORBIDDEN_CONTENT } from "./forbidden-content.mjs";');
    expect(source).toContain("FORBIDDEN_CONTENT.test(");
    // The drift this guards against: a checker owning its own copy of the detector.
    expect(source).not.toMatch(/const\s+FORBIDDEN_CONTENT\s*=/);
  });

  it.each(PACKAGE_CHECKERS)("%s rejects content the shared detector matches", (checker) => {
    // Sanity-check the probe really is what the shared detector flags, then that the checker enforces it.
    expect(FORBIDDEN_CONTENT.test(SECRET_SHAPED_PROBE)).toBe(true);
    const result = runChecker(checker, REACHABLE_FILES[checker]!, SECRET_SHAPED_PROBE);
    expect(result.status).toBe(1);
    expect(result.out).toContain("Secret-like content found in");
  });

  // Scoped to the MCP checker: the miner one layers required-file / lib-artifact / docs guards on top of a
  // minimal file list, so a clean-content pass there would be asserting its allowlist rather than the shared
  // detector. The reject case above already proves the miner checker runs content through the shared constant.
  it("scripts/check-mcp-package.mjs accepts content the shared detector leaves alone", () => {
    const result = runChecker(
      "scripts/check-mcp-package.mjs",
      REACHABLE_FILES["scripts/check-mcp-package.mjs"]!,
      "export const answer = 42;",
    );
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/MCP package dry-run ok:/);
  });

  it("is a stateless matcher, so the shared instance is safe across checkers", () => {
    // A global/sticky regex would carry lastIndex between .test() calls and make shared use order-dependent.
    expect(FORBIDDEN_CONTENT.global).toBe(false);
    expect(FORBIDDEN_CONTENT.sticky).toBe(false);
    expect(FORBIDDEN_CONTENT.test(SECRET_SHAPED_PROBE)).toBe(true);
    expect(FORBIDDEN_CONTENT.test(SECRET_SHAPED_PROBE)).toBe(true);
  });
});

// #7433: FORBIDDEN_CONTENT only matched 4 shapes (private-key block, github_pat_, gh[pousr]_, gts_, and a
// generic TOKEN/SECRET/PRIVATE_KEY= assignment) even though this same repo already ships a materially larger,
// individually-verified-precise set of concrete secret-format patterns in src/review/secret-patterns.ts's
// SECRET_PATTERNS. Each fixture below is assembled from fragments (never a contiguous credential-shaped literal
// in this file's own source) and uses the same fake bodies the repo's own secrets-scan.test.ts and
// content-lane-security-scan.test.ts already use for these exact formats.
describe("FORBIDDEN_CONTENT matches the repo's other known-precise secret formats (#7433)", () => {
  it.each([
    ["aws_access_key", "AKIA" + "ABCDEFGHIJKLMNOP"],
    ["slack_token", "xoxb-" + "123456789012-ABCDEFabcdef"],
    ["google_api_key", "AIza" + "SyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456"],
    ["gitlab_token", "glpat-" + "aBcDeFgHiJkLmNoPqRsT"],
    ["npm_token", "npm_" + "a".repeat(36)],
    ["stripe_secret_key", "sk_live_" + "a".repeat(24)],
    ["sendgrid_key", "SG." + "a".repeat(22) + "." + "b".repeat(43)],
    ["huggingface_token", "hf_" + "a".repeat(34)],
    ["voyage_api_key", "pa-" + "aK9xQ2mZw7Ln4Rv8Pt3B"],
    ["firecrawl_api_key", "fc-" + "aK9xQ2mZw7Ln4Rv8"],
    ["openai_api_key", "sk-" + "a".repeat(20) + "T3BlbkFJ" + "b".repeat(20)],
    ["anthropic_api_key", "sk-ant-api03-" + "a".repeat(93) + "AA"],
  ])("matches a %s-shaped value", (_kind, fixture) => {
    expect(FORBIDDEN_CONTENT.test(fixture)).toBe(true);
  });

  it("still matches the 4 pre-existing formats unchanged", () => {
    expect(FORBIDDEN_CONTENT.test("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(FORBIDDEN_CONTENT.test("github_pat_" + "a".repeat(20))).toBe(true);
    expect(FORBIDDEN_CONTENT.test("ghp_" + "a".repeat(20))).toBe(true);
    expect(FORBIDDEN_CONTENT.test("gts_" + "0123456789abcdef".repeat(4))).toBe(true);
    expect(FORBIDDEN_CONTENT.test(SECRET_SHAPED_PROBE)).toBe(true);
  });

  // jwt/seed_or_mnemonic/bittensor_key were deliberately left out of this widening (see the code comment on
  // FORBIDDEN_CONTENT) -- pinned here so a future edit can't silently reintroduce them without this test
  // flagging the scope change.
  it("does NOT match jwt/seed_or_mnemonic/bittensor_key shapes (deliberately out of scope)", () => {
    const jwtShaped = "eyJ" + "a".repeat(10) + "." + "b".repeat(10) + "." + "c".repeat(10);
    expect(FORBIDDEN_CONTENT.test(jwtShaped)).toBe(false);
    expect(FORBIDDEN_CONTENT.test("our seed phrase backup process")).toBe(false);
    expect(FORBIDDEN_CONTENT.test("hotkey = ss58addresshere")).toBe(false);
  });
});
