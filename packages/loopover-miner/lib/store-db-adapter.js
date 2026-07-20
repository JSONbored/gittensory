// Shared SqliteDriver / D1 adapter seam for AMS local stores (#7175 part 1).
//
// Mirrors ORB's `src/selfhost/d1-adapter.ts` so hosted AMS can later swap in `createPgAdapter` without
// inventing a second abstraction. Self-host default remains node:sqlite via `nodeSqliteDriver`.
// Keep this surface in sync with the ORB module when either side grows (Postgres interactive txn /
// `runOn` arrives in a later #7175 slice — not this file yet).
function meta(changes = 0, lastRowId = 0) {
    return {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: changes,
        last_row_id: lastRowId,
        changed_db: changes > 0,
        changes,
    };
}
/** One prepared (and optionally bound) statement — D1 statements are immutable after bind. */
class Statement {
    constructor(driver, sql, values = []) {
        this.driver = driver;
        this.sql = sql;
        this.values = values;
    }
    bind(...values) {
        return new Statement(this.driver, this.sql, values);
    }
    execSync() {
        const r = this.driver.query(this.sql, this.values);
        return { results: r.rows, success: true, meta: meta(r.changes, r.lastInsertRowid) };
    }
    async all() {
        return this.execSync();
    }
    async run() {
        return this.execSync();
    }
    async first(colName) {
        const row = this.driver.query(this.sql, this.values).rows[0];
        if (row == null)
            return null;
        return ((colName != null ? row[colName] : row) ?? null);
    }
    async raw() {
        return this.driver.query(this.sql, this.values).rows.map((row) => Object.values(row));
    }
}
/**
 * Wrap a synchronous SqliteDriver as a D1-shaped database (async prepare/batch/exec).
 */
export function createD1Adapter(driver) {
    return {
        prepare(sql) {
            return new Statement(driver, sql);
        },
        async batch(statements) {
            driver.exec("BEGIN");
            try {
                const out = statements.map((s) => s.execSync());
                driver.exec("COMMIT");
                return out;
            }
            catch (error) {
                try {
                    driver.exec("ROLLBACK");
                }
                catch {
                    /* ignore */
                }
                throw error;
            }
        },
        async exec(sql) {
            driver.exec(sql);
            return { count: (sql.match(/;/g) ?? []).length || 1, duration: 0 };
        },
        async dump() {
            return new ArrayBuffer(0);
        },
    };
}
/**
 * Build a SqliteDriver from a node:sqlite DatabaseSync.
 * A statement with zero result columns is a WRITE; otherwise a READ.
 *
 * LIMITATION (#7175 follow-up): `INSERT/UPDATE/DELETE … RETURNING` statements report result columns, so
 * this heuristic would treat them as reads and drop `changes`/`lastInsertRowid`. claim-ledger and other
 * RETURNING callers must not migrate onto `driver.query` until the heuristic is sharpened (e.g. statement
 * class detection) or those stores use `createD1Adapter`/`run` exclusively.
 */
export function nodeSqliteDriver(db) {
    return {
        query(sql, params) {
            const stmt = db.prepare(sql);
            if (stmt.columns().length > 0) {
                return { rows: stmt.all(...params), changes: 0, lastInsertRowid: 0 };
            }
            const info = stmt.run(...params);
            return { rows: [], changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
        },
        exec(sql) {
            db.exec(sql);
        },
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RvcmUtZGItYWRhcHRlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInN0b3JlLWRiLWFkYXB0ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsNkVBQTZFO0FBQzdFLEVBQUU7QUFDRix1R0FBdUc7QUFDdkcsZ0dBQWdHO0FBQ2hHLG1HQUFtRztBQUNuRywrREFBK0Q7QUE2Qi9ELFNBQVMsSUFBSSxDQUFDLE9BQU8sR0FBRyxDQUFDLEVBQUUsU0FBUyxHQUFHLENBQUM7SUFDdEMsT0FBTztRQUNMLFFBQVEsRUFBRSxDQUFDO1FBQ1gsVUFBVSxFQUFFLENBQUM7UUFDYixTQUFTLEVBQUUsQ0FBQztRQUNaLFlBQVksRUFBRSxPQUFPO1FBQ3JCLFdBQVcsRUFBRSxTQUFTO1FBQ3RCLFVBQVUsRUFBRSxPQUFPLEdBQUcsQ0FBQztRQUN2QixPQUFPO0tBQ1IsQ0FBQztBQUNKLENBQUM7QUFFRCw4RkFBOEY7QUFDOUYsTUFBTSxTQUFTO0lBS2IsWUFBWSxNQUFvQixFQUFFLEdBQVcsRUFBRSxTQUFvQixFQUFFO1FBQ25FLElBQUksQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDO1FBQ3JCLElBQUksQ0FBQyxHQUFHLEdBQUcsR0FBRyxDQUFDO1FBQ2YsSUFBSSxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUM7SUFDdkIsQ0FBQztJQUVELElBQUksQ0FBQyxHQUFHLE1BQWlCO1FBQ3ZCLE9BQU8sSUFBSSxTQUFTLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxJQUFJLENBQUMsR0FBRyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ3RELENBQUM7SUFFRCxRQUFRO1FBQ04sTUFBTSxDQUFDLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDbkQsT0FBTyxFQUFFLE9BQU8sRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsSUFB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