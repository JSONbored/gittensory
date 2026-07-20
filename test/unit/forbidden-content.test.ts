import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_CONTENT } from "../../scripts/forbidden-content.mjs";

// forbidden-content.mjs calls itself the single source of truth for the packaged secret-shape detector, but
// nothing enforced it: check-mcp-package.mjs re-declared the regex as its own local constant and the two could
// drift apart unnoticed (#6290). These assertions pin both halves of the claim -- the structural one (each
// checker imports the constant rather than owning a copy) and the behavioral one (each checker actually rejects
// what the shared detector matches).
const PACKAGE_CHECKERS = [
  "scripts/check-miner-package.mjs",
  "scripts/check-mcp-package.mjs",
];

// A minimal file list that passes each checker's path/allowlist/required-file guards, so the run reaches the
// shared secret-content read. Mirrors the file lists each checker's own "rejects secret-like content" test uses.
const REACHABLE_FILES: Record<string, string[]> = {
  "scripts/check-miner-package.mjs": [
    "package.json",
    "bin/loopover-miner.js",
    "lib/cli.js",
  ],
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
    [isMiner ? "CHECK_MINER_PACK_TEST_FILES" : "CHECK_MCP_PACK_TEST_FILES"]:
      JSON.stringify(files),
    [isMiner ? "CHECK_MINER_PACK_TEST_CONTENT" : "CHECK_MCP_PACK_TEST_CONTENT"]:
      content,
  };
  try {
    return {
      status: 0,
      out: execFileSync(process.execPath, [checker], { encoding: "utf8", env }),
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("FORBIDDEN_CONTENT is the single source of truth (#6290)", () => {
  it.each(PACKAGE_CHECKERS)(
    "%s imports the shared constant instead of re-declaring it",
    (checker) => {
      const source = readFileSync(checker, "utf8");
      expect(source).toContain(
        'import { FORBIDDEN_CONTENT } from "./forbidden-content.mjs";',
      );
      expect(source).toContain("FORBIDDEN_CONTENT.test(");
      // The drift this guards against: a checker owning its own copy of the detector.
      expect(source).not.toMatch(/const\s+FORBIDDEN_CONTENT\s*=/);
    },
  );

  it.each(PACKAGE_CHECKERS)(
    "%s rejects content the shared detector matches",
    (checker) => {
      // Sanity-check the probe really is what the shared detector flags, then that the checker enforces it.
      expect(FORBIDDEN_CONTENT.test(SECRET_SHAPED_PROBE)).toBe(true);
      const result = runChecker(
        checker,
        REACHABLE_FILES[checker]!,
        SECRET_SHAPED_PROBE,
      );
      expect(result.status).toBe(1);
      expect(result.out).toContain("Secret-like content found in");
    },
  );

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

// #7433: FORBIDDEN_CONTENT was widened beyond its original 5 shapes to also match the 12 concrete secret formats
// that src/review/secret-patterns.ts's HARD_SECRET_KINDS already hard-block, so a packed miner/mcp file (or an
// MCP tool response) embedding an AWS/Slack/OpenAI/Anthropic/etc. key is caught here too. Every probe is assembled
// from fragments so this file never itself contains a contiguous credential-shaped literal -- the same convention
// secret-patterns.test.ts / check-*-package.test.ts already use so the repo's own secret scanners don't flag it.
describe("FORBIDDEN_CONTENT matches the concrete secret formats it hard-blocks (#7433)", () => {
  const MATCHES: Record<string, string> = {
    "AWS access key": "AKIA" + "IOSFODNN7EXAMPLE",
    "Slack token": "xox" + "b-" + "1234567890-AbCdEfGhIj",
    "Google API key": "AIza" + "B".repeat(35),
    "GitLab token": "glp" + "at-" + "abcDEF1234567890ghij",
    "npm token": "npm" + "_" + "a".repeat(36),
    "Stripe live key": "sk" + "_live_" + "a".repeat(24),
    "SendGrid key": "SG." + "a".repeat(22) + "." + "b".repeat(43),
    "Hugging Face token": "hf" + "_" + "a".repeat(34),
    "Voyage key": "pa-" + "abcdefghij1234567890AB",
    "Firecrawl key": "fc-" + "abcdef1234567890",
    "OpenAI key":
      "sk-" +
      "proj-" +
      "abcdefghij1234567890" +
      "T3Blbk" +
      "FJ" +
      "abcdefghij1234567890",
    "Anthropic key": "sk-" + "ant-api03-" + "a".repeat(93) + "AA",
    // The 4 shapes it already covered, re-pinned so the widening can't silently regress one.
    "PEM private-key header": "-----BEGIN RSA PRIVATE KEY-----",
    "GitHub PAT": "github" + "_pat_" + "A".repeat(22),
    "gh*_ token": "gh" + "p_" + "A".repeat(30),
    "generic <NAME>_SECRET= assignment": [
      "PROBE",
      "_",
      "SECRET",
      "=",
      "value",
    ].join(""),
  };
  it.each(Object.entries(MATCHES))("flags a %s", (_name, probe) => {
    expect(FORBIDDEN_CONTENT.test(probe)).toBe(true);
  });

  // Deliberately kept OUT of the hard-block set (see forbidden-content.mjs's own comment): `jwt` is out of scope
  // for this packaged-secret detector, and `seed_or_mnemonic` / `bittensor_key` are documented in
  // secret-patterns.ts as weak, false-positive-prone heuristics -- a JWT-shaped string, a doc sentence mentioning
  // a mnemonic/seed phrase, or a Bittensor hotkey/coldkey line must NOT be flagged as a leaked packaged secret.
  const NON_MATCHES: Record<string, string> = {
    JWT:
      "ey" +
      "JhbGciOiJIUzI1NiJ9" +
      "." +
      "eyJzdWIiOiIxMjM0In0" +
      "." +
      "abcDEF1234567890",
    "mnemonic / seed-phrase prose":
      "restore it from your mnemonic or seed phrase if lost",
    "Bittensor hotkey/coldkey line":
      "hot" + "key = default\ncold" + "key: main",
    "ordinary text": "just a normal sentence, nothing secret here at all",
  };
  it.each(Object.entries(NON_MATCHES))("does not flag %s", (_name, probe) => {
    expect(FORBIDDEN_CONTENT.test(probe)).toBe(false);
  });
});
