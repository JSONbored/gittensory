// Chat rail message-input control (#6514). A self-contained, backend-agnostic composer built on the ui-kit's
// raw `Textarea`/`Button` primitives (which carry no submit/auto-grow behavior of their own). It owns its own
// draft-value state and is uncontrolled from the caller's perspective: the only behavioral prop is `onSubmit`,
// invoked with the current textarea value when the user submits a non-empty message. Submit fires on `Enter`
// (no modifier) or a click of the Send button; `Shift+Enter` inserts a literal newline instead. This component
// ships UNWIRED — it makes no network/MCP/action-dispatch call; mounting it into the persistent chat rail is a
// separate, later issue.
import * as React from "react";

import { Button } from "@loopover/ui-kit/components/button";
import { Textarea } from "@loopover/ui-kit/components/textarea";

// The textarea auto-grows with its content up to this height; beyond it the height is pinned here and the
// textarea scrolls internally instead of pushing the rail taller without bound.
const MAX_TEXTAREA_HEIGHT_PX = 200;

export interface ChatComposerProps {
  /** Called with the current textarea value on a non-empty submit (Enter or Send click). */
  onSubmit: (message: string) => void;
  /** Placeholder shown while the textarea is empty. */
  placeholder?: string;
  /** Disables both the textarea and the Send button. */
  disabled?: boolean;
  /** Accessible label / visible text for the submit button. */
  submitLabel?: string;
}

export function ChatComposer({
  onSubmit,
  placeholder = "Type a message…",
  disabled = false,
  submitLabel = "Send",
}: ChatComposerProps) {
  const [value, setValue] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Auto-grow: collapse to `auto` so a deleted line lets the box shrink, then grow to fit the content up to
  // the cap. At/above the cap the height is pinned and internal scrolling takes over (overflowY:auto).
  const resize = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT_PX ? "auto" : "hidden";
  }, []);

  // useLayoutEffect (not useEffect) so the height is corrected before the browser paints, avoiding a
  // one-frame flash at the wrong size as the draft grows or is cleared after submit.
  React.useLayoutEffect(() => {
    resize();
  }, [value, resize]);

  const submit = React.useCallback(() => {
    // Trim only for the emptiness check — a value of "   " is blocked exactly like "". The message passed to
    // the caller is the current textarea value itself.
    if (value.trim() === "") return;
    onSubmit(value);
    setValue("");
  }, [value, onSubmit]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Enter is the newline affordance: let the default insert the line break and do not submit.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex items-end gap-2">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className="max-h-[200px] resize-none"
      />
      <Button type="button" onClick={submit} disabled={disabled}>
        {submitLabel}
      </Button>
    </div>
  );
}
