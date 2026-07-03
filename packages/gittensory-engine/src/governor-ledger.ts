/** Immutable governor decision vocabulary — unknown values fail closed before insert. */
export const GOVERNOR_LEDGER_EVENT_TYPES = Object.freeze([
  "allowed",
  "denied",
  "throttled",
  "kill_switch",
] as const);

export type GovernorLedgerEventType = (typeof GOVERNOR_LEDGER_EVENT_TYPES)[number];

export type GovernorLedgerEvent = {
  eventType: GovernorLedgerEventType;
  repoFullName?: string | null | undefined;
  actionClass: string;
  decision: string;
  reason: string;
  payload?: Record<string, unknown> | undefined;
};

export type NormalizedGovernorLedgerEvent = {
  eventType: GovernorLedgerEventType;
  repoFullName: string | null;
  actionClass: string;
  decision: string;
  reason: string;
  payloadJson: string;
};

const governorEventTypeSet = new Set<string>(GOVERNOR_LEDGER_EVENT_TYPES);

/* v8 ignore start -- Normalization helpers are covered through normalizeGovernorLedgerEvent export tests. */
// Self-contained structural-equality check (no node:util) so this package stays runtime-portable across the
// Worker backend and the Node-only miner CLI. Scoped to serializePayload's own round-trip-fidelity use: both
// sides here are always plain objects/arrays/primitives (one is a fresh JSON.parse result), so this never needs
// to handle Maps, Dates, RegExps, or prototypes the way a general-purpose deep-equal would.
function deepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(bRecord, key) && deepStrictEqual(aRecord[key], bRecord[key]),
  );
}

function normalizeRequiredString(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(code);
  return trimmed;
}

function normalizeOptionalRepoFullName(repoFullName: unknown): string | null {
  if (repoFullName === undefined || repoFullName === null) return null;
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function serializePayload(payload: unknown): string {
  if (payload === undefined) return "{}";
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid_payload");
  }
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    throw new Error("invalid_payload");
  }
  if (!deepStrictEqual(JSON.parse(json), payload)) {
    throw new Error("invalid_payload");
  }
  return json;
}
/* v8 ignore stop */

/**
 * Validate and normalize a governor ledger row before append-only insert. Mirrors the structured-event shape of
 * `logAudit` in `src/selfhost/audit.ts`, but for local SQLite storage. This module does NOT wire into live
 * governor enforcement — it only defines the storage contract other issues will write into. (#2328)
 */
export function normalizeGovernorLedgerEvent(input: unknown): NormalizedGovernorLedgerEvent {
  if (!input || typeof input !== "object") throw new Error("invalid_event");
  const event = input as Partial<GovernorLedgerEvent>;
  const eventType = normalizeRequiredString(event.eventType, "invalid_event_type");
  if (!governorEventTypeSet.has(eventType)) throw new Error("invalid_event_type");
  return {
    eventType: eventType as GovernorLedgerEventType,
    repoFullName: normalizeOptionalRepoFullName(event.repoFullName),
    actionClass: normalizeRequiredString(event.actionClass, "invalid_action_class"),
    decision: normalizeRequiredString(event.decision, "invalid_decision"),
    reason: normalizeRequiredString(event.reason, "invalid_reason"),
    payloadJson: serializePayload(event.payload),
  };
}
