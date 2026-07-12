import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFileSecrets } from "../../packages/gittensory-miner/lib/load-file-secrets.js";

afterEach(() => vi.restoreAllMocks());

describe("loadFileSecrets (#5178)", () => {
  it("resolves a <NAME>_FILE var into <NAME> with the trimmed file contents", () => {
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN_FILE: "/run/secrets/gh",
    };
    const readFile = vi.fn((path: string) =>
      path === "/run/secrets/gh" ? "  file-sourced-value\n" : "",
    );
    loadFileSecrets(env, readFile);
    expect(env.GITHUB_TOKEN).toBe("file-sourced-value");
    expect(readFile).toHaveBeenCalledWith("/run/secrets/gh");
  });

  it("leaves non-_FILE vars untouched", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      GITHUB_TOKEN: "already",
    };
    const readFile = vi.fn(() => "unused");
    loadFileSecrets(env, readFile);
    expect(env).toEqual({ PATH: "/usr/bin", GITHUB_TOKEN: "already" });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("skips a _FILE var with an empty value", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY_FILE: "",
    };
    const readFile = vi.fn(() => "x");
    loadFileSecrets(env, readFile);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("never dereferences Compose-reserved _FILE vars", () => {
    const env: Record<string, string | undefined> = {
      COMPOSE_FILE: "a.yml:b.yml",
      COMPOSE_ENV_FILE: "/x/.env",
    };
    const readFile = vi.fn(() => "x");
    loadFileSecrets(env, readFile);
    expect(env.COMPOSE).toBeUndefined();
    expect(env.COMPOSE_ENV).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("lets an explicit <NAME> win over the file", () => {
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN: "explicit",
      GITHUB_TOKEN_FILE: "/run/secrets/gh",
    };
    const readFile = vi.fn(() => "from_file");
    loadFileSecrets(env, readFile);
    expect(env.GITHUB_TOKEN).toBe("explicit");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("respects an explicit EMPTY value — never overwrites it from the file (presence, not truthiness)", () => {
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN: "",
      GITHUB_TOKEN_FILE: "/run/secrets/gh",
    };
    const readFile = vi.fn(() => "from_file");
    loadFileSecrets(env, readFile);
    expect(env.GITHUB_TOKEN).toBe(""); // the deliberate empty value stands; the file must not clobber it
    expect(readFile).not.toHaveBeenCalled();
  });

  it("logs and skips an unreadable secret file instead of throwing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY_FILE: "/missing",
    };
    const readFile = vi.fn(() => {
      throw new Error("ENOENT");
    });
    expect(() => loadFileSecrets(env, readFile)).not.toThrow();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("miner_secret_file_unreadable"),
    );
  });

  it("defaults to process.env and the real filesystem when called with no arguments", () => {
    const dir = mkdtempSync(join(tmpdir(), "miner-secret-"));
    const file = join(dir, "token");
    writeFileSync(file, "  value-from-real-fs\n");
    process.env.MINER_TEST_TOKEN_FILE = file;
    delete process.env.MINER_TEST_TOKEN;
    try {
      loadFileSecrets();
      expect(process.env.MINER_TEST_TOKEN).toBe("value-from-real-fs");
    } finally {
      delete process.env.MINER_TEST_TOKEN;
      delete process.env.MINER_TEST_TOKEN_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
