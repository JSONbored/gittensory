import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TEST_FRAMEWORKS } from "../../packages/loopover-engine/src/signals/test-evidence";

// #6149: the hosted server (src/mcp/server.ts) has registered the 8 #780 write-tools since #780, and this
// file's own AGENT_PROFILES["miner-auto-dev"].recommendedTools promised six of them — but none were registered
// on the LOCAL stdio server, so that profile recommended tools a contributor could not call.
//
// Every write-tool is a pure spec builder: it returns a LOCAL-execution action spec and loopover never performs
// the write. That is why this suite deliberately starts the server with NO LOOPOVER_TOKEN and NO
// LOOPOVER_API_URL — these tools must work with neither, unlike every read tool on this server. If one ever
// starts reaching for the API, this suite fails rather than silently requiring auth for a local-only action.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let configDir: string | null = null;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-write-tools-"));
  const env: Record<string, string> = {};
  // A deliberately auth-less environment: strip anything that could let a tool fall back to a real API/token.
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("LOOPOVER_")) env[k] = v;
  }
  env.LOOPOVER_CONFIG_DIR = configDir;
  transport = new StdioClientTransport({ command: "node", args: [bin, "--stdio"], env });
  client = new Client({ name: "write-tools-test", version: "0.0.1" });
  await client.connect(transport);
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = null;
  transport = null;
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  configDir = null;
});

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

/** The spec object the tool embeds in its text payload. */
function specOf(result: unknown): Record<string, unknown> {
  const text = textOf(result);
  const start = text.indexOf("{");
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

const REPO = "acme/widgets";

const WRITE_TOOLS: Array<{ name: string; args: Record<string, unknown>; expect: RegExp }> = [
  {
    name: "loopover_open_pr",
    args: { repoFullName: REPO, base: "main", head: "fix/thing", title: "fix: the thing", body: "Closes #1" },
    expect: /pr|pull/i,
  },
  { name: "loopover_file_issue", args: { repoFullName: REPO, title: "Bug: crash", body: "steps" }, expect: /issue/i },
  { name: "loopover_apply_labels", args: { repoFullName: REPO, number: 7, labels: ["bug"] }, expect: /label/i },
  {
    name: "loopover_post_eligibility_comment",
    args: { repoFullName: REPO, number: 7, body: "context" },
    expect: /comment/i,
  },
  { name: "loopover_create_branch", args: { branch: "fix/thing", base: "main" }, expect: /branch/i },
  { name: "loopover_delete_branch", args: { branch: "fix/thing", remote: true }, expect: /branch/i },
  {
    name: "loopover_generate_tests",
    args: { repoFullName: REPO, targetFiles: ["src/a.ts"], framework: "vitest" },
    expect: /test/i,
  },
  {
    name: "loopover_file_follow_up_issue",
    args: { repoFullName: REPO, path: "src/a.ts", line: 12, finding: "unchecked nullable" },
    expect: /issue|follow/i,
  },
];

describe("loopover-mcp stdio write-tools (#6149)", () => {
  it("registers all 8 write-tools the hosted server exposes", async () => {
    await connect();
    const listed = new Set((await client!.listTools()).tools.map((t) => t.name));
    for (const { name } of WRITE_TOOLS) expect(listed, `${name} must be registered`).toContain(name);
  });

  it("delivers every tool the miner-auto-dev profile's recommendedTools promises", async () => {
    // The exact gap #6149 reports: the profile recommended these six, the local server registered none.
    await connect();
    const listed = new Set((await client!.listTools()).tools.map((t) => t.name));
    for (const name of [
      "loopover_create_branch",
      "loopover_open_pr",
      "loopover_file_issue",
      "loopover_apply_labels",
      "loopover_post_eligibility_comment",
      "loopover_delete_branch",
    ]) {
      expect(listed, `miner-auto-dev recommends ${name}`).toContain(name);
    }
  });

  it.each(WRITE_TOOLS)("$name returns a runnable local-execution spec, with no token or API", async ({ name, args, expect: pattern }) => {
    await connect();
    const result = await client!.callTool({ name, arguments: args });
    expect((result as { isError?: boolean }).isError ?? false).toBe(false);

    const spec = specOf(result);
    expect(typeof spec.action).toBe("string");
    expect(typeof spec.command).toBe("string");
    expect(String(spec.command).length).toBeGreaterThan(0);
    expect(spec).toHaveProperty("inputs");
    expect(`${spec.action} ${spec.description ?? ""}`).toMatch(pattern);

    // The boundary the whole design rests on: we hand back a command, we never run it.
    expect(textOf(result)).toMatch(/loopover never performs the write/i);
  });

  it("carries the caller's own inputs into the spec rather than inventing them", async () => {
    await connect();
    const result = await client!.callTool({
      name: "loopover_open_pr",
      arguments: { repoFullName: REPO, base: "main", head: "fix/thing", title: "fix: the thing", body: "Closes #1" },
    });
    const text = textOf(result);
    expect(text).toContain(REPO);
    expect(text).toContain("fix/thing");
    expect(text).toContain("fix: the thing");
  });

  describe("input validation mirrors the hosted server's own bounds", () => {
    // The local server duplicates the framework vocabulary because it depends on the PUBLISHED engine ^1.0.0,
    // which predates the TEST_FRAMEWORKS export. This pins that copy to the engine's real list so the two
    // cannot drift: a framework the detector can produce must be accepted, and the copy must be exhaustive.
    it("DRIFT GUARD: accepts exactly the engine's own TEST_FRAMEWORKS vocabulary", async () => {
      await connect();
      expect(TEST_FRAMEWORKS.length).toBeGreaterThan(0);
      for (const framework of TEST_FRAMEWORKS) {
        const result = await client!.callTool({
          name: "loopover_generate_tests",
          arguments: { repoFullName: REPO, targetFiles: ["src/a.ts"], framework },
        });
        expect((result as { isError?: boolean }).isError ?? false, `${framework} must be accepted`).toBe(false);
      }
    });

    it("rejects an out-of-vocabulary test framework", async () => {
      await connect();
      const result = await client!.callTool({
        name: "loopover_generate_tests",
        arguments: { repoFullName: REPO, targetFiles: ["src/a.ts"], framework: "not-a-framework" },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
    });

    it("rejects an empty required field", async () => {
      await connect();
      const result = await client!.callTool({
        name: "loopover_open_pr",
        arguments: { repoFullName: REPO, base: "main", head: "fix/thing", title: "", body: "x" },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
    });

    it("rejects a non-positive issue number", async () => {
      await connect();
      const result = await client!.callTool({
        name: "loopover_apply_labels",
        arguments: { repoFullName: REPO, number: 0, labels: ["bug"] },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
    });

    it("rejects an empty label list", async () => {
      await connect();
      const result = await client!.callTool({
        name: "loopover_apply_labels",
        arguments: { repoFullName: REPO, number: 7, labels: [] },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
    });
  });
});
