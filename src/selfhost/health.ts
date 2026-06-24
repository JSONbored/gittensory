// Self-host liveness/readiness probes (#982). Liveness is binding-free (the process is up); readiness asserts
// the things a request actually depends on — the DB answers and the schema migrations have been applied.
import type { SqliteDriver } from "./d1-adapter";

export interface Readiness {
  ok: boolean;
  checks: Record<string, boolean>;
}

/** Readiness: the DB answers a trivial query and the migrations table shows applied rows. */
export function readiness(driver: SqliteDriver): Readiness {
  let db = false;
  let migrations = false;
  try {
    driver.query("SELECT 1", []);
    db = true;
  } catch {
    /* db down */
  }
  try {
    migrations = Number((driver.query("SELECT COUNT(*) AS c FROM _selfhost_migrations", []).rows[0] as { c: number }).c) > 0;
  } catch {
    /* migrations table missing */
  }
  return { ok: db && migrations, checks: { db, migrations } };
}
