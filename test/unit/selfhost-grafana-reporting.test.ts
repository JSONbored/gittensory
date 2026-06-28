import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpRoots: string[] = [];
const sqliteCliAvailable = (() => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-reporting-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function sqlite(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

function runExporter(root: string, sourceDb: string, outDb: string): void {
  execFileSync("sh", ["scripts/export-grafana-reporting-db.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GITTENSORY_REPORTING_SOURCE_DB: sourceDb,
      GITTENSORY_REPORTING_DIR: root,
      GITTENSORY_REPORTING_DB: outDb,
    },
    stdio: "pipe",
  });
}

(sqliteCliAvailable ? describe : describe.skip)("Grafana reporting exporter", () => {
  it("copies durable AI usage estimate rows into the redacted reporting database", () => {
    const root = tmpRoot();
    const appDb = join(root, "app.sqlite");
    const outDb = join(root, "reporting.sqlite");
    sqlite(appDb, `
      CREATE TABLE ai_usage_events (
        feature TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        estimated_neurons INTEGER NOT NULL DEFAULT 0,
        detail TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO ai_usage_events (feature, model, status, estimated_neurons, detail, metadata_json, created_at)
      VALUES ('ai_review_pr', 'codex:gpt-5.5', 'ok', 42, 'done', '{"repoFullName":"JSONbored/gittensory","pullNumber":1678,"private":"drop"}', '2026-06-28T00:00:00Z');
    `);

    runExporter(root, appDb, outDb);

    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT estimated_neurons FROM ai_usage_events;")).toBe("42");
    expect(sqlite(outDb, "SELECT json_extract(metadata_json, '$.repoFullName') FROM ai_usage_events;")).toBe("JSONbored/gittensory");
    expect(sqlite(outDb, "SELECT json_extract(metadata_json, '$.private') IS NULL FROM ai_usage_events;")).toBe("1");
    expect(sqlite(outDb, "SELECT sum(estimated_neurons) FROM ai_usage_events WHERE feature = 'ai_review_pr' AND (('+' || model || '+') LIKE '%+codex+%' OR ('+' || model || '+') LIKE '%+codex:%');")).toBe("42");
  });

  it("keeps the dashboard schema valid when an older source DB has no estimate column", () => {
    const root = tmpRoot();
    const appDb = join(root, "app.sqlite");
    const outDb = join(root, "reporting.sqlite");
    sqlite(appDb, `
      CREATE TABLE ai_usage_events (
        feature TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO ai_usage_events (feature, model, status, detail, metadata_json, created_at)
      VALUES ('ai_review_pr', 'codex', 'error', 'failed', '{"repoFullName":"JSONbored/gittensory","pullNumber":1678}', '2026-06-28T00:00:00Z');
    `);

    runExporter(root, appDb, outDb);

    expect(sqlite(outDb, "PRAGMA quick_check;")).toBe("ok");
    expect(sqlite(outDb, "SELECT estimated_neurons FROM ai_usage_events;")).toBe("0");
  });
});
