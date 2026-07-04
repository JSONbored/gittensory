import { describe, expect, it, vi } from "vitest";
import type { RejectionReason } from "../../packages/gittensory-miner/lib/rejection-templates.d.ts";
import {
  parseRejectionListArgs,
  parseRejectionRenderArgs,
  renderRejectionReasonTable,
  runRejectionCli,
  runRejectionList,
  runRejectionRender,
} from "../../packages/gittensory-miner/lib/rejection-templates-cli.js";

describe("gittensory-miner rejection templates CLI (#2324)", () => {
  it("parseRejectionListArgs and parseRejectionRenderArgs validate argv", () => {
    expect(parseRejectionListArgs(["--json"])).toEqual({ json: true });
    expect(
      parseRejectionRenderArgs(["gate_close", "JSONbored/gittensory", "2751", "--json"]),
    ).toEqual({
      reason: "gate_close",
      repoFullName: "JSONbored/gittensory",
      prNumber: 2751,
      json: true,
    });
    expect(parseRejectionRenderArgs(["bogus", "o/r", "1"])).toEqual({
      error: expect.stringMatching(/Invalid reason/),
    });
    expect(parseRejectionRenderArgs(["gate_close", "bad", "1"])).toEqual({
      error: "Repository must be in owner/repo form.",
    });
    expect(parseRejectionRenderArgs(["gate_close", "o/r", "0"])).toEqual({
      error: "pr# must be a positive integer.",
    });
  });

  it("renderRejectionReasonTable formats reason rows and empty output", () => {
    const reasons: RejectionReason[] = ["gate_close", "maintainer_close_no_reason"];
    expect(renderRejectionReasonTable([])).toBe("no rejection reasons");
    expect(renderRejectionReasonTable(reasons)).toContain("gate_close");
  });

  it("runRejectionList prints table and JSON output", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runRejectionList([])).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("gate_close");

    log.mockClear();
    expect(runRejectionList(["--json"])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      reasons: expect.arrayContaining(["gate_close", "superseded_by_duplicate"]),
    });
  });

  it("runRejectionRender prints message and JSON output", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runRejectionRender(["gate_close", "JSONbored/gittensory", "2751"])).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("#2751");

    log.mockClear();
    expect(
      runRejectionRender(["maintainer_close_no_reason", "JSONbored/gittensory", "9", "--json"]),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      reason: "maintainer_close_no_reason",
      repoFullName: "JSONbored/gittensory",
      prNumber: 9,
      message: expect.stringContaining("JSONbored/gittensory"),
    });
  });

  it("runRejectionRender fails closed on malformed render context", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runRejectionRender(["gate_close", "owner/repo/extra", "1"])).toBe(2);
    expect(error).toHaveBeenCalledWith("invalid_repo_full_name");
  });

  it("runRejectionCli dispatches list and render subcommands", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runRejectionCli("list", ["--json"])).toBe(0);
    expect(runRejectionCli("render", ["gate_close", "JSONbored/gittensory", "1"])).toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it("rejects unknown rejection subcommands and options", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runRejectionCli("save", [])).toBe(2);
    expect(runRejectionList(["--verbose"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown rejection subcommand");
  });
});
