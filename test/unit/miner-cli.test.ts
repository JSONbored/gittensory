import { describe, expect, it, vi } from "vitest";
import { printHelp, printVersion, runCli } from "../../packages/gittensory-miner/lib/cli.js";

describe("gittensory-miner CLI helpers", () => {
  it("prints the package version with the node runtime", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printVersion({ packageName: "@jsonbored/gittensory-miner", packageVersion: "0.1.0" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("@jsonbored/gittensory-miner/0.1.0"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(process.version));
    log.mockRestore();
  });

  it("prints help text with the supported commands", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printHelp({ packageName: "@jsonbored/gittensory-miner" });
    const text = log.mock.calls[0]?.[0];
    expect(text).toContain("gittensory-miner --help");
    expect(text).toContain("gittensory-miner version");
    log.mockRestore();
  });

  it("returns exit code 1 for unknown commands", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runCli(["mystery"], { packageName: "@jsonbored/gittensory-miner" })).toBe(1);
    expect(error).toHaveBeenCalledWith("Unknown command: mystery. Run @jsonbored/gittensory-miner --help.");
    error.mockRestore();
  });
});
