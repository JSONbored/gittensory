// Loop escalation evaluator (pure) — decides when a rented loop needs a human, and what action to take, so
// a support/escalation path can route "something's wrong" to a stop-and-review state (#4806, part of the
// Rent-a-Loop path #4778). Composes with the loop-health evaluator (#4808): it takes an already-computed
// run outcome + health tier + operator/customer signals and returns one deterministic escalation decision.
// No IO, no notifying, no stopping — it decides; the caller wires the action (a stop maps to #4809's
// kill-switch once that lands). Mirrors the quota (#4796) / loop-health (#4808) evaluator pattern.

export type LoopRunOutcome = "running" | "converged" | "abandoned" | "error";
export type LoopHealthTier = "healthy" | "degraded" | "critical";
export type EscalationAction = "none" | "notify" | "human_review" | "stop";
export type EscalationSeverity = "none" | "low" | "medium" | "high";

export type LoopEscalationInput = {
  runStatus: LoopRunOutcome;
  healthStatus?: LoopHealthTier | undefined;
  /** The customer explicitly asked for help / review on their own loop. */
  customerFlagged?: boolean | undefined;
  /** An operator (or the customer) requested a hard stop. */
  killRequested?: boolean | undefined;
};

export type EscalationDecision = {
  shouldEscalate: boolean;
  action: EscalationAction;
  severity: EscalationSeverity;
  reasons: string[];
};

/** Decide whether — and how — a loop should be escalated to a human (#4806). Pure and deterministic. */
export function evaluateEscalation(input: LoopEscalationInput): EscalationDecision {
  // Independent reasons (never folded), so every triggering signal surfaces even when several fire at once.
  const reasons: string[] = [];
  if (input.killRequested === true) reasons.push("kill_requested");
  if (input.runStatus === "error") reasons.push("run_errored");
  if (input.healthStatus === "critical") reasons.push("health_critical");
  if (input.runStatus === "abandoned") reasons.push("run_abandoned");
  if (input.customerFlagged === true) reasons.push("customer_flagged");
  if (input.healthStatus === "degraded") reasons.push("health_degraded");

  // Action + severity by precedence: a requested stop wins; a hard failure (errored/critical) needs a human
  // now; a give-up/customer ask needs a human soon; a soft degradation only notifies.
  let action: EscalationAction;
  let severity: EscalationSeverity;
  if (input.killRequested === true) {
    action = "stop";
    severity = "high";
  } else if (input.runStatus === "error" || input.healthStatus === "critical") {
    action = "human_review";
    severity = "high";
  } else if (input.runStatus === "abandoned" || input.customerFlagged === true) {
    action = "human_review";
    severity = "medium";
  } else if (input.healthStatus === "degraded") {
    action = "notify";
    severity = "low";
  } else {
    action = "none";
    severity = "none";
  }

  return { shouldEscalate: action !== "none", action, severity, reasons };
}
