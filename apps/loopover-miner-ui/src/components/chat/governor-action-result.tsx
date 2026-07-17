// Inline chat rendering for governor pause/resume action results (#6521). Reuses GovernorControlSection's
// copy verbatim via formatGovernorPauseChatMessage; surfaces a pending state while the POST is in flight.

import {
  formatGovernorPauseChatMessage,
  GOVERNOR_CHAT_ACTION_PENDING_MESSAGE,
} from "../../lib/chat-governor-action-copy";
import type { GovernorPauseStateResult } from "../../lib/governor";

export function GovernorChatActionResult({
  pending,
  result,
}: {
  /** True while the pause/resume round-trip is outstanding (Ledgers `actionPending` equivalent). */
  pending: boolean;
  /** Latest resolved result; ignored while `pending` is true so the surface never looks stuck. */
  result: GovernorPauseStateResult | null;
}) {
  if (pending) {
    return (
      <p role="status" aria-live="polite" className="text-token-sm text-muted-foreground">
        {GOVERNOR_CHAT_ACTION_PENDING_MESSAGE}
      </p>
    );
  }
  if (result === null) return null;
  if (!result.ok) {
    return (
      <p role="alert" className="text-token-sm text-danger">
        {formatGovernorPauseChatMessage(result)}
      </p>
    );
  }
  return <p className="text-token-sm text-muted-foreground">{formatGovernorPauseChatMessage(result)}</p>;
}
