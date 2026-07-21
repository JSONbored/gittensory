// APR (auto-provisioned repo) transfer-to-customer initiation (#7638, decision #7590). An APR repo is created
// under a loopover-controlled GitHub org (#7637) and can later be transferred, on explicit customer request, to
// the customer's own account via GitHub's standard repository-transfer flow.
//
// This module owns ONLY the initiation call. Detecting when a pending transfer is accepted or expires, any
// customer-facing UI, and the policy of *when* a transfer should be offered are deliberately out of scope
// (separate follow-ons per #7638). No provisioning or repo-creation logic lives here.

import { createInstallationToken } from "../github/app";
import { githubHeaders, timeoutFetch } from "../github/client";
// `Env` is the ambient Cloudflare Worker binding interface (worker-configuration.d.ts) — a global, not imported.

/**
 * Result of initiating an APR repo transfer.
 *
 * IMPORTANT: `initiated: true` means GitHub ACCEPTED the transfer request, NOT that the transfer is complete.
 * GitHub's transfer flow is asynchronous and acceptance-gated — the recipient must accept via a confirmation
 * email within a time window — so the repo does not actually move when this call returns. Anything built on top
 * of this must treat a successful result as "transfer pending", never "transfer done".
 */
export type AprRepoTransferResult =
  | { initiated: true; status: number; newFullName: string | null }
  | { initiated: false; status: number; error: string };

/**
 * Initiate a transfer of `repoFullName` (a loopover-org APR repo, `owner/name`) to the GitHub account `newOwner`,
 * using the App installation token — the same token source as APR repo creation (#7637).
 *
 * Calls GitHub's `POST /repos/{owner}/{repo}/transfer` with `new_owner`. Returns the initiation outcome WITHOUT
 * throwing on an API error (a non-existent target account, or missing admin access to the repo, come back as a
 * structured `{ initiated: false }` result), so callers get a total function they can branch on. A successful
 * result models the transfer as INITIATED, not complete — see {@link AprRepoTransferResult}.
 */
export async function initiateAprRepoTransfer(
  env: Env,
  installationId: number,
  repoFullName: string,
  newOwner: string,
): Promise<AprRepoTransferResult> {
  const token = await createInstallationToken(env, installationId);
  const response = await timeoutFetch(`https://api.github.com/repos/${repoFullName}/transfer`, {
    method: "POST",
    headers: githubHeaders({ token, json: true }),
    body: JSON.stringify({ new_owner: newOwner }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { initiated: false, status: response.status, error: detail.slice(0, 200) || `transfer request failed (${response.status})` };
  }
  // GitHub returns 202 Accepted with the repository object; `full_name` reflects the pending destination path.
  const payload = (await response.json().catch(() => null)) as { full_name?: string } | null;
  return { initiated: true, status: response.status, newFullName: payload?.full_name ?? null };
}
