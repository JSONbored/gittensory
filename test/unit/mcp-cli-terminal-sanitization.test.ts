import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, runAsync, startFixtureServer } from "./support/mcp-cli-harness";

// #6261: sanitizePlainTextTerminalOutput guarded exactly one output path (validateConfigCli's warnings) while
// every other command that prints API-controlled free text wrote it straight to the terminal. A hostile response
// could therefore repaint the screen, erase the lines above it, or park a convincing fake verdict next to the real
// one -- the terminal cannot tell our text from the payload's.
//
// Each test drives a real command against a fixture that answers with the attack string, and asserts the escape
// never lands. All of them fail against the pre-fix CLI.

const ESC = "\u001b";
/** A realistic payload: colour + cursor-up + line-erase + an OSC title-set (BEL-terminated) + a bare NUL. */
const INJECTION = `${ESC}[31mRED${ESC}[0m${ESC}[1A${ESC}[2K${ESC}]0;pwned\u0007\u0000TAIL`;
/** Exactly the class the sanitizer strips: C0/C1 controls and DEL. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** The text must still be readable -- sanitized, not merely dropped -- with every escape gone. */
function expectNeutralized(output: string) {
  expect(output).not.toContain(ESC);
  expect(output).not.toMatch(CONTROL_CHARS);
  expect(output).toContain("TAIL");
}

describe("loopover-mcp CLI — terminal-escape sanitization (#6261)", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function env() {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer({ terminalInjection: INJECTION });
    return { LOOPOVER_API_URL: url, LOOPOVER_TOKEN: "session-token", LOOPOVER_CONFIG_DIR: tempDir, LOOPOVER_API_TIMEOUT_MS: "1000" };
  }

  it("slop-risk: a hostile finding title/detail and band cannot reach the terminal", async () => {
    const out = await runAsync(["slop-risk", "--changed-file", "src/widget.ts:80:2", "--description", "A description."], await env());
    expectNeutralized(out);
  });

  it("issue-slop: a hostile finding title/detail and band cannot reach the terminal", async () => {
    // The sharpest case: the body assessed here is routinely a third party's issue text.
    const out = await runAsync(["issue-slop", "--title", "Fix bug", "--body", "Some body."], await env());
    expectNeutralized(out);
  });

  it("decision-pack: a hostile summary and rerunGuidance cannot reach the terminal", async () => {
    const out = await runAsync(["decision-pack", "--login", "JSONbored"], await env());
    expectNeutralized(out);
  });

  it("repo-decision: a hostile nextActions entry and rerunGuidance cannot reach the terminal", async () => {
    const out = await runAsync(["repo-decision", "--login", "JSONbored", "--repo", "JSONbored/gittensory"], await env());
    expectNeutralized(out);
  });

  it("maintain status: a hostile action reason/actionClass cannot reach the terminal", async () => {
    const out = await runAsync(["maintain", "status", "--repo", "owner/repo"], await env());
    expectNeutralized(out);
  });

  it("maintain queue: a hostile action reason/actionClass cannot reach the terminal", async () => {
    const out = await runAsync(["maintain", "queue", "--repo", "owner/repo"], await env());
    expectNeutralized(out);
  });

  // --json is deliberately NOT sanitized: JSON.stringify escapes U+001B as a \u001b literal, so an escape
  // sequence cannot survive into the printed document, and stripping bytes there would corrupt the
  // machine-readable contract callers parse. This pins that reasoning instead of trusting it.
  it("--json keeps the payload verbatim yet still cannot emit a raw escape", async () => {
    const out = await runAsync(["maintain", "status", "--repo", "owner/repo", "--json"], await env());
    expect(out).not.toContain(ESC);
    expect(out).not.toMatch(CONTROL_CHARS);
    const parsed = JSON.parse(out) as { pendingActions: Array<{ reason: string }> };
    expect(parsed.pendingActions[0]!.reason).toBe(INJECTION);
  });
});
