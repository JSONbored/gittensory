// APR (auto-provisioned repo) transfer-to-customer initiation (#7638, decision #7590). An APR repo is created
// under a loopover-controlled GitHub org (#7637) and can later be transferred, on explicit customer request, to
// the customer's own account via GitHub's standard repository-transfer flow.
//
// Initiation (#7638) lives here; the customer-facing request gate (#7742) does too. Detecting when a pending
// transfer is accepted or expires (#7741) remains out of scope. No provisioning or repo-creation logic lives
// here. Transfer is NEVER offered or nudged proactively in v1 — request-only, and only once a TRUSTED
// server-side idea-completion signal (#7591) says the task-graph is done. Callers must NEVER supply that
// boolean over the wire; {@link loadAprIdeaCompletion} is the sole source, and it fail-closes until #7664
// persists a completion record.

import { createInstallationToken } from "../github/app";
import { githubHeaders, timeoutFetch } from "../github/client";
import { loadAprIdeaCompletion, type AprIdeaCompletionLookup } from "./apr-idea-completion";
// `Env` is the ambient Cloudflare Worker binding interface (worker-configuration.d.ts) — a global, not imported.

export type { AprIdeaCompletionLookup, AprIdeaCompletionLookupInput } from "./apr-idea-completion";
export { loadAprIdeaCompletion } from "./apr-idea-completion";

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
 * #7742 policy gate: a transfer may be requested only after the idea's completion signal (#7591) is true.
 * Plan/payment tiers are deliberately NOT consulted — this stays clear of the billing track. Pure: no IO.
 * The boolean MUST come from {@link loadAprIdeaCompletion} (or a test double of it), never from a client body.
 */
export type AprRepoTransferRequestEligibility =
  | { allowed: true }
  | { allowed: false; reason: "idea_not_complete" };

export type RequestAprRepoTransferInput = {
  installationId: number;
  repoFullName: string;
  newOwner: string;
  ideaId?: string | undefined;
};

/**
 * Outcome of a customer-initiated transfer request (#7742).
 *
 * - `rejected` — the completion gate blocked the call; GitHub was never contacted.
 * - `initiated` / `failed` — the gate passed and {@link initiateAprRepoTransfer} ran; `initiated` still means
 *   GitHub accepted a *pending* transfer (see {@link AprRepoTransferResult}), never "transfer done".
 */
export type RequestAprRepoTransferResult =
  | { status: "rejected"; reason: "idea_not_complete" }
  | { status: "initiated"; transfer: Extract<AprRepoTransferResult, { initiated: true }> }
  | { status: "failed"; transfer: Extract<AprRepoTransferResult, { initiated: false }> };

/** Decide whether a customer may request an APR repo transfer right now (#7742). Pure and deterministic. */
export function evaluateAprRepoTransferRequestEligibility(input: {
  ideaComplete: boolean;
}): AprRepoTransferRequestEligibility {
  if (input.ideaComplete !== true) return { allowed: false, reason: "idea_not_complete" };
  return { allowed: true };
}

/**
 * Initiate a transfer of `repoFullName` (a loopover-org APR repo, `owner/name`) to the GitHub account `newOwner`,
 * using the App installation token — the same token source as APR repo creation (#7637).
 *
 * Calls GitHub's `POST /repos/{owner}/{repo}/transfer` with `new_owner`. Returns the initiation outcome WITHOUT
 * throwing on an API error (a non-existent target account, or missing admin access to the repo, come back as a
 * structured `{ initiated: false }` result), so callers get a total function they can branch on. A successful
 * result models the transfer as INITIATED, not complete — see {@link AprRepoTransferResult}.
 *
 * Prefer {@link requestAprRepoTransfer} for the customer-facing path — it applies the #7742 completion gate
 * before calling this. Direct callers are for tests / internal seams that already enforced the gate.
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

/**
 * Customer-facing "request transfer" action (#7742): resolve idea completion via a trusted server lookup
 * ({@link loadAprIdeaCompletion}), gate on that result, then call {@link initiateAprRepoTransfer}. Never
 * initiates when incomplete — and nothing in this module (or its REST mirror) auto-offers or nudges a transfer,
 * or accepts a client-supplied completion boolean.
 */
export async function requestAprRepoTransfer(
  env: Env,
  input: RequestAprRepoTransferInput,
  options: {
    initiate?: (
      env: Env,
      installationId: number,
      repoFullName: string,
      newOwner: string,
    ) => Promise<AprRepoTransferResult>;
    loadCompletion?: AprIdeaCompletionLookup;
  } = {},
): Promise<RequestAprRepoTransferResult> {
  const loadCompletion = options.loadCompletion ?? loadAprIdeaCompletion;
  const { ideaComplete } = await loadCompletion(env, { repoFullName: input.repoFullName, ideaId: input.ideaId });
  const eligibility = evaluateAprRepoTransferRequestEligibility({ ideaComplete });
  if (!eligibility.allowed) return { status: "rejected", reason: eligibility.reason };

  const initiate = options.initiate ?? initiateAprRepoTransfer;
  const transfer = await initiate(env, input.installationId, input.repoFullName, input.newOwner);
  if (transfer.initiated) return { status: "initiated", transfer };
  return { status: "failed", transfer };
}
