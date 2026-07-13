import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBackup, runRestore } from "../../packages/gittensory-miner/lib/backup-cli.js";

const roots: string[] = [];
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-backup-"));
  roots.push(root);
  return root;
}

/** A populated state directory + the env that points the miner at it. */
function seedStateDir() {
  const root = tempRoot();
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "portfolio-queue.sqlite3"), "queue-bytes");
  writeFileSync(join(stateDir, "claim-ledger.sqlite3"), "claim-bytes");
  writeFileSync(join(stateDir, "portfolio-queue.sqlite3-wal"), "wal-bytes"); // sidecar comes along too
  return { root, stateDir, env: { GITTENSORY_MINER_CONFIG_DIR: stateDir } };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner backup / restore (#4872)", () => {
  it("backup copies the whole state directory (SQLite files + WAL sidecars) to the target", () => {
    const { root, stateDir, env } = seedStateDir();
    const target = join(root, "backup");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runBackup([target], { env })).toBe(0);
    expect(existsSync(join(target, "portfolio-queue.sqlite3"))).toBe(true);
    expect(existsSync(join(target, "claim-ledger.sqlite3"))).toBe(true);
    expect(existsSync(join(target, "portfolio-queue.sqlite3-wal"))).toBe(true);
    expect(readFileSync(join(target, "portfolio-queue.sqlite3"), "utf8")).toBe("queue-bytes");
    expect(String(log.mock.calls[0]?.[0])).toContain(`backed up 3 file(s)`);
    void stateDir;
  });

  it("backup refuses to overwrite an existing target directory", () => {
    const { root, env } = seedStateDir();
    const target = join(root, "backup");
    mkdirSync(target); // already exists
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(runBackup([target], { env })).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("backup_target_exists");
  });

  it("backup fails when there is no state directory to copy", () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "does-not-exist") };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(runBackup([join(root, "backup")], { env })).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("no_state_directory");
  });

  it("backup emits a structured object under --json", () => {
    const { root, stateDir, env } = seedStateDir();
    const target = join(root, "backup");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runBackup([target, "--json"], { env })).toBe(0);
    const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(printed).toMatchObject({ ok: true, source: stateDir, target });
    expect(printed.files).toEqual(["claim-ledger.sqlite3", "portfolio-queue.sqlite3", "portfolio-queue.sqlite3-wal"]);
  });

  it("restore copies a backup back over the state directory (round-trips the data)", () => {
    const { root, stateDir, env } = seedStateDir();
    const backup = join(root, "backup");
    expect(runBackup([backup], { env })).toBe(0);

    // Simulate data loss / a bad edit, then restore.
    writeFileSync(join(stateDir, "portfolio-queue.sqlite3"), "corrupted");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runRestore([backup], { env })).toBe(0);
    expect(readFileSync(join(stateDir, "portfolio-queue.sqlite3"), "utf8")).toBe("queue-bytes");
    expect(String(log.mock.calls[0]?.[0])).toContain("restored");
  });

  it("restore fails when the backup directory does not exist", () => {
    const { root, env } = seedStateDir();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runRestore([join(root, "no-such-backup")], { env })).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("no_backup_directory");
  });

  it("restore emits a structured object under --json", () => {
    const { root, stateDir, env } = seedStateDir();
    const backup = join(root, "backup");
    runBackup([backup], { env });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runRestore([backup, "--json"], { env })).toBe(0);
    const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(printed).toMatchObject({ ok: true, source: backup, target: stateDir });
  });

  it("both commands reject a missing/extra positional and an unknown option", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runBackup([])).toBe(2);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain("Usage: gittensory-miner backup");
    expect(runBackup(["a", "b"])).toBe(2);
    expect(runRestore(["--verbose", "dir"])).toBe(2);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain("Unknown option: --verbose");
  });

  it("a parse error respects --json (structured failure, still exit 2)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runBackup(["--json"], {})).toBe(2); // no dir positional
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ ok: false });
  });

  it("both commands fail safe (exit 2) when the copy itself throws (a path component is a file, not a dir)", () => {
    const { root, env } = seedStateDir();
    const fileNotDir = join(root, "afile");
    writeFileSync(fileNotDir, "x");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A target/state path *under* a regular file makes cpSync throw ENOTDIR → caught → exit 2.
    expect(runBackup([join(fileNotDir, "backup")], { env })).toBe(2);
    const backup = join(root, "backup");
    runBackup([backup], { env });
    expect(runRestore([backup], { env: { GITTENSORY_MINER_CONFIG_DIR: join(fileNotDir, "state") } })).toBe(2);
    expect(error).toHaveBeenCalled();
  });

  it("rejects an empty directory argument", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runBackup([""])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Usage: gittensory-miner backup");
  });

  it("falls back to process.env when no env is injected", () => {
    const { root, stateDir } = seedStateDir();
    const target = join(root, "backup");
    const saved = process.env.GITTENSORY_MINER_CONFIG_DIR;
    process.env.GITTENSORY_MINER_CONFIG_DIR = stateDir;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(runBackup([target])).toBe(0); // no options → resolves via process.env
      expect(existsSync(join(target, "portfolio-queue.sqlite3"))).toBe(true);
      expect(runRestore([target])).toBe(0); // restore likewise resolves the state dir via process.env
    } finally {
      if (saved === undefined) delete process.env.GITTENSORY_MINER_CONFIG_DIR;
      else process.env.GITTENSORY_MINER_CONFIG_DIR = saved;
    }
    void log;
  });
});
