import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7798: in-process coverage for loopover_get_selftune_override_audit stdio + `maintain selftune-audit`.
// Subprocess spawn (mcp-cli-maintain.test.ts) cannot instrument the .ts bin for Codecov — same #7764 pattern
// as mcp-cli-plan-issues.test.ts (import .ts, drive maintainCli + server.connect(InMemoryTransport)).
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  maintainCli: (args: string[]) => Promise<void>;
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const capturedRequests: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-selftune-audit-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/selftune/overrides/audit")) {
        capturedRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
      }
    },
  });
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  for (const specifier of MODULES) {
    loaded.set(specifier, (await import(specifier)) as unknown as BinModule);
  }
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TOKEN;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

describe("bin loopover_get_selftune_override_audit stdio tool (in-process, #7798)", () => {
  it.each(MODULES)("registers and proxies GET .../selftune/overrides/audit — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "selftune-audit-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_get_selftune_override_audit");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/self-tune override audit/i);

      const unlimited = await client.callTool({
        name: "loopover_get_selftune_override_audit",
        arguments: { owner: "owner", repo: "repo" },
      });
      expect(capturedRequests.length).toBe(1);
      expect(capturedRequests[0]!.url).toContain("/v1/repos/owner/repo/selftune/overrides/audit");
      expect(capturedRequests[0]!.url).not.toContain("limit=");
      expect(capturedRequests[0]!.method).toBe("GET");
      expect(unlimited.isError).toBeFalsy();
      expect(JSON.stringify(unlimited)).toContain("override_promoted");

      capturedRequests.length = 0;
      const limited = await client.callTool({
        name: "loopover_get_selftune_override_audit",
        arguments: { owner: "owner", repo: "repo", limit: 1 },
      });
      expect(capturedRequests.length).toBe(1);
      expect(capturedRequests[0]!.url).toContain("limit=1");
      expect(limited.isError).toBeFalsy();
      const data = limited.structuredContent as { audit: unknown[] };
      expect(data.audit).toHaveLength(1);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe("bin maintain selftune-audit CLI (in-process, #7798)", () => {
  it.each(MODULES)("prints the audit trail and passes --limit — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.maintainCli(["selftune-audit", "--repo", "owner/repo"]));
    expect(capturedRequests.some((r) => r.url.includes("/selftune/overrides/audit") && !r.url.includes("limit="))).toBe(true);
    expect(out).toMatch(/Self-tune override audit for owner\/repo: 3 event\(s\)\./);
    expect(out).toMatch(/override_promoted/);

    capturedRequests.length = 0;
    const limited = await captureStdout(() => mod.maintainCli(["selftune-audit", "--repo", "owner/repo", "--limit", "1"]));
    expect(capturedRequests.some((r) => r.url.includes("limit=1"))).toBe(true);
    expect(limited).toMatch(/Self-tune override audit for owner\/repo: 1 event\(s\)\./);
  });

  it.each(MODULES)("emits machine-readable JSON with --json — %s", async (specifier) => {
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.maintainCli(["selftune-audit", "--repo", "owner/repo", "--json"]));
    const payload = JSON.parse(out) as { audit: Array<{ eventType: string }> };
    expect(payload.audit).toHaveLength(3);
    expect(payload.audit[0]?.eventType).toBe("override_promoted");
  });

  it.each(MODULES)("unknown-subcommand help lists selftune-audit — %s", async (specifier) => {
    const mod = loaded.get(specifier)!;
    await expect(mod.maintainCli(["not-a-real-subcommand", "--repo", "owner/repo"])).rejects.toThrow(
      /Unknown maintain subcommand.*selftune-audit/,
    );
  });

  it.each(MODULES)("maintain --help mentions selftune-audit — %s", async (specifier) => {
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.maintainCli(["--help"]));
    expect(out).toMatch(/selftune-audit/);
  });
});
