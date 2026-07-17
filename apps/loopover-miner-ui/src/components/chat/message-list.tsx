import { ScrollArea } from "@loopover/ui-kit/components/scroll-area";
import { StateBoundary } from "@loopover/ui-kit/components/state-views";
import { MessageBubble } from "./message-bubble";
import { TypingIndicator } from "./typing-indicator";
import type { ChatMessage } from "./fixtures";

// The scrollable message list for the chat rail (#6515). Backend-agnostic: it renders whatever message
// array it's given, wrapping the content in ui-kit's StateBoundary for its own loading/empty/error states
// and using ui-kit's ScrollArea (not a raw overflow div) for the viewport. The composing flag surfaces the
// TypingIndicator below the list regardless of the message-array state.
export function MessageList({
  messages,
  isLoading = false,
  isError = false,
  composing = false,
}: {
  messages: ChatMessage[];
  isLoading?: boolean;
  isError?: boolean;
  composing?: boolean;
}) {
  return (
    <ScrollArea className="h-full">
      <StateBoundary
        isLoading={isLoading}
        isError={isError}
        isEmpty={messages.length === 0}
        loadingTitle="Loading conversation…"
        emptyTitle="No messages yet"
        emptyDescription="Start the conversation to see messages here."
        errorTitle="Couldn't load the conversation"
        errorDescription="The conversation source did not respond. Retry, or check back once it has recovered."
      >
        {/* The committed-message list is the live region (#7081): a completed turn appends one <li>, so
            screen readers announce the finished answer once. `polite` (not `assertive`) — chat answers
            aren't interrupting content. The live-streaming StreamingText renders OUTSIDE this <ol> (in
            ChatConversation), so its per-chunk token updates never fire an announcement; only the single
            committed bubble does. StateBoundary's own role="status"/"alert" branches are unaffected — they
            replace this subtree entirely when loading/empty/error. */}
        <ol className="flex flex-col gap-4 p-3" aria-live="polite" aria-relevant="additions">
          {messages.map((message) => (
            <li key={message.id}>
              <MessageBubble message={message} />
            </li>
          ))}
        </ol>
      </StateBoundary>
      {composing ? <TypingIndicator composing authorName="Assistant" /> : null}
    </ScrollArea>
  );
}
