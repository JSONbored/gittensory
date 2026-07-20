import { describe, expect, it } from "vitest";
import { createTestEnv } from "../helpers/d1";

describe("orb_relay_pending created_at prune index", () => {
  it("creates the (created_at, delivery_id) index and pruneRelayPending's queries use it (SEARCH, not SCAN)", async () => {
    const env = createTestEnv();

    const idx = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
      .bind("idx_orb_relay_pending_created_at")
      .first<{ name: string }>();
    expect(idx?.name).toBe("idx_orb_relay_pending_created_at");

    // pruneRelayPending's SELECT: WHERE created_at < ? ORDER BY created_at, delivery_id — must SEARCH via
    // the new index, whose column order matches the ORDER BY so no separate sort (temp B-tree) is needed.
    const selectPlan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT delivery_id, event_name, installation_id FROM orb_relay_pending WHERE created_at < datetime('now', '-' || ? || ' hours') ORDER BY created_at, delivery_id LIMIT ?",
    )
      .bind(24, 20)
      .all<{ detail: string }>();
    const selectDetail = (selectPlan.results ?? []).map((row) => row.detail).join(" ");
    expect(selectDetail).toContain("idx_orb_relay_pending_created_at");
    expect(selectDetail).not.toContain("SCAN orb_relay_pending ");
    expect(selectDetail).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    // pruneRelayPending's DELETE: WHERE created_at < ? — must SEARCH via the same index.
    const deletePlan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN DELETE FROM orb_relay_pending WHERE created_at < datetime('now', '-' || ? || ' hours')",
    )
      .bind(24)
      .all<{ detail: string }>();
    const deleteDetail = (deletePlan.results ?? []).map((row) => row.detail).join(" ");
    expect(deleteDetail).toContain("idx_orb_relay_pending_created_at");
    expect(deleteDetail).not.toContain("SCAN orb_relay_pending ");
  });
});
