import { describe, expect, it } from "vitest";

import { createApp } from "../../src/api/routes";
import { insertNotificationDeliveryIfAbsent } from "../../src/db/repositories";
import { buildContributorPrOutcomes } from "../../src/signals/contributor-pr-outcomes";
import { createTestEnv } from "../helpers/d1";

async function seedMerged(env: Env, login: string, dedupKey: string, pullNumber: number, body: string): Promise<void> {
  await insertNotificationDeliveryIfAbsent(env, {
    dedupKey,
    channel: "badge",
    recipientLogin: login,
    eventType: "pull_request_merged",
    repoFullName: "owner/repo",
    pullNumber,
    title: `Merged: owner/repo#${pullNumber}`,
    body,
    deeplink: `https://github.com/owner/repo/pull/${pullNumber}`,
    actorLogin: login,
  });
}

describe("buildContributorPrOutcomes (#6747)", () => {
  it("maps a contributor's pull_request_merged deliveries to outcomes (newest first, login lowercased), excluding other event types", async () => {
    const env = createTestEnv();
    await seedMerged(env, "Miner", "m1", 7, "PR #7 merged.");
    await seedMerged(env, "Miner", "m2", 8, "PR #8 merged.");
    // A non-merge delivery for the same login must NOT surface as an outcome.
    await insertNotificationDeliveryIfAbsent(env, {
      dedupKey: "changes:1",
      channel: "badge",
      recipientLogin: "Miner",
      eventType: "pull_request_changes_requested",
      repoFullName: "owner/repo",
      pullNumber: 9,
      title: "Changes requested",
      body: "A reviewer requested changes.",
      deeplink: "https://github.com/owner/repo/pull/9",
      actorLogin: "reviewer",
    });

    const result = await buildContributorPrOutcomes(env, "Miner");
    expect(result.login).toBe("miner");
    expect(result.count).toBe(2);
    expect(result.outcomes.map((o) => o.pullNumber)).toEqual([8, 7]); // deliveries are returned newest-first
    expect(result.outcomes[0]).toMatchObject({
      repoFullName: "owner/repo",
      pullNumber: 8,
      outcome: "merged",
      attribution: "PR #8 merged.",
      deeplink: "https://github.com/owner/repo/pull/8",
    });
    expect(typeof result.outcomes[0]!.recordedAt).toBe("string");
  });

  it("returns an empty history for a contributor with no merged deliveries", async () => {
    const env = createTestEnv();
    expect(await buildContributorPrOutcomes(env, "nobody")).toEqual({ login: "nobody", count: 0, outcomes: [] });
  });

  it("honors an explicit limit", async () => {
    const env = createTestEnv();
    for (let i = 1; i <= 3; i += 1) await seedMerged(env, "miner", `k${i}`, i, `PR #${i} merged.`);
    expect((await buildContributorPrOutcomes(env, "miner", 2)).count).toBe(2);
  });
});

describe("GET /v1/contributors/:login/pr-outcomes (#6747) — REST mirror", () => {
  it("returns byte-for-byte what the shared builder produces (parity with the MCP surface)", async () => {
    const env = createTestEnv();
    await seedMerged(env, "miner", "r1", 7, "PR #7 merged.");
    await seedMerged(env, "miner", "r2", 8, "PR #8 merged.");
    const app = createApp();

    // Operator (api) token: the contributor's private surface is reached over HTTP via a trusted token, not a
    // browser session (contributor routes aren't in the session path allowlist).
    const res = await app.request(
      "/v1/contributors/miner/pr-outcomes",
      { headers: { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await buildContributorPrOutcomes(env, "miner", 50));
  });

  it("honors the limit query parameter", async () => {
    const env = createTestEnv();
    for (let i = 1; i <= 3; i += 1) await seedMerged(env, "miner", `q${i}`, i, `PR #${i} merged.`);
    const app = createApp();
    const res = await app.request(
      "/v1/contributors/miner/pr-outcomes?limit=2",
      { headers: { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { count: number }).count).toBe(2);
  });

  it("refuses the shared, end-user MCP token reading an arbitrary contributor (forbidden_contributor)", async () => {
    // A scoped MCP allowlist (not the wildcard opt-in) — the shared LOOPOVER_MCP_TOKEN must not read an
    // arbitrary contributor's private history over HTTP, mirroring the MCP tool surface's own guard.
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    const app = createApp();
    const res = await app.request(
      "/v1/contributors/miner/pr-outcomes",
      { headers: { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}` } },
      env,
    );
    expect(res.status).toBe(403);
  });
});
