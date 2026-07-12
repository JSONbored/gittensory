import { afterEach, describe, expect, it, vi } from "vitest";
import { emitCliError, wantsJsonOutput } from "../../packages/gittensory-miner/lib/cli-error.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wantsJsonOutput (#4836)", () => {
  it("is true only when raw argv contains --json", () => {
    expect(wantsJsonOutput(["queue", "next", "--json"])).toBe(true);
    expect(wantsJsonOutput(["queue", "next"])).toBe(false);
    expect(wantsJsonOutput([])).toBe(false);
  });

  it("treats a non-array argv as no --json (an arg-parse path that never produced one)", () => {
    expect(wantsJsonOutput(undefined)).toBe(false);
    expect(wantsJsonOutput("--json")).toBe(false);
  });
});

describe("emitCliError (#4836)", () => {
  it("emits a parseable { error } JSON object on stderr when --json is requested", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    emitCliError("boom", { json: true });
    expect(err).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(err.mock.calls[0]?.[0]))).toEqual({ error: "boom" });
  });

  it("emits the plain message on stderr when --json is not requested", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    emitCliError("boom", { json: false });
    expect(err).toHaveBeenCalledWith("boom");
  });

  it("defaults to plain output when no options are passed", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    emitCliError("boom");
    expect(err).toHaveBeenCalledWith("boom");
  });

  it("coerces a non-string message to a string on both output paths", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    emitCliError(new Error("wrapped"), { json: true });
    expect(JSON.parse(String(err.mock.calls[0]?.[0]))).toEqual({ error: "Error: wrapped" });
    emitCliError(42, { json: false });
    expect(err).toHaveBeenCalledWith("42");
  });
});
