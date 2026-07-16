// Verbatim governor pause-state copy shared with GovernorControlSection (ledgers.tsx) for chat inline
// results (#6521). Keep these strings identical to the Ledgers control — do not invent parallel wording.

import type { GovernorPauseStateResult } from "./governor";

/** In-flight copy while a chat-issued pause/resume POST is outstanding (mirrors Ledgers `actionPending`). */
export const GOVERNOR_CHAT_ACTION_PENDING_MESSAGE = "Updating governor…";

/** Format a `GovernorPauseStateResult` using the exact Ledgers `GovernorControlSection` strings. */
export function formatGovernorPauseChatMessage(result: GovernorPauseStateResult): string {
  if (!result.ok) {
    return `Could not read the local governor state: ${result.error}`;
  }
  if (result.pauseState.paused) {
    return `Paused since ${result.pauseState.pausedAt}${result.pauseState.reason ? ` (${result.pauseState.reason})` : ""}`;
  }
  return "Not paused";
}
