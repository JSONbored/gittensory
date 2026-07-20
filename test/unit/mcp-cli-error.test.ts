import { afterEach, describe, expect, it, vi } from "vitest";

async function loadCliError() {
  return await import("../../packages/loopover-mcp/lib/cli-error.js");
}

describe("mcp cli-error helpers (#7328)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("argsWantJson detects --json and --json= forms", async () => {
    const { argsWantJson } = await loadCliError();
    expect(argsWantJson([])).toBe(false);
    expect(argsWantJson(["--help"])).toBe(false);
    expect(argsWantJson(["--json"])).toBe(true);
    expect(argsWantJson(["--json=true"])).toBe(true);
    expect(argsWantJson([undefined, "--json"])).toBe(true);
  });

  it("describeCliError prefers Error.message and stringifies other throws", async () => {
    const { describeCliError } = await loadCliError();
    expect(describeCliError(new Error("boom"))).toBe("boom");
    expect(describeCliError("plain")).toBe("plain");
    expect(describeCliError(42)).toBe("42");
  });

  it("reportCliFailure emits JSON on stdout when wantsJson is true", async () => {
    const { reportCliFailure } = await loadCliError();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(reportCliFailure(true, "nope", 3)).toBe(3);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "nope" }, null, 2));
    expect(err).not.toHaveBeenCalled();
  });

  it("reportCliFailure writes plain text to stderr otherwise (default exit 2)", async () => {
    const { reportCliFailure } = await loadCliError();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(reportCliFailure(false, "plain failure")).toBe(2);
    expect(err).toHaveBeenCalledWith("plain failure");
    expect(log).not.toHaveBeenCalled();
  });
});
