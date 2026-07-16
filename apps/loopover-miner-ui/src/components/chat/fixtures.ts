// Fixture data for the miner-ui chat components (#6515). These components are backend-agnostic — driven
// entirely by props (a message array + a composing flag); a real data source arrives in a later,
// separately-scoped issue. The shapes below are exactly what MessageBubble / MessageList render against.

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** ISO-8601 timestamp; MessageBubble renders it through a <time dateTime={…}> element. */
  timestamp: string;
  /** Optional display name; falls back to the role for the avatar initials and image alt text. */
  authorName?: string;
  /** Optional avatar image URL; when absent, MessageBubble renders the initials fallback only. */
  avatarUrl?: string;
}

/** Empty conversation — drives MessageList's StateBoundary empty branch. */
export const emptyConversation: ChatMessage[] = [];

export const singleMessage: ChatMessage[] = [
  {
    id: "m1",
    role: "assistant",
    content: "Hi — ask me anything about this miner's queue, runs, or ledgers.",
    timestamp: "2026-07-16T08:00:00.000Z",
    authorName: "LoopOver",
  },
];

/** A representative multi-turn exchange spanning all three roles, with and without an avatar image. */
export const multiTurnConversation: ChatMessage[] = [
  {
    id: "m1",
    role: "user",
    content: "What's stuck in the portfolio queue?",
    timestamp: "2026-07-16T08:00:10.000Z",
    authorName: "operator",
    avatarUrl: "https://avatars.example.test/operator.png",
  },
  {
    id: "m2",
    role: "assistant",
    content: "Two items are leased but idle past their TTL. Want me to reclaim them?",
    timestamp: "2026-07-16T08:00:15.000Z",
    authorName: "LoopOver",
  },
  {
    id: "m3",
    role: "user",
    content: "Yes, reclaim both.",
    timestamp: "2026-07-16T08:00:20.000Z",
    authorName: "operator",
    avatarUrl: "https://avatars.example.test/operator.png",
  },
  {
    id: "m4",
    role: "system",
    content: "Reclaimed 2 stuck items back to queued.",
    timestamp: "2026-07-16T08:00:21.000Z",
  },
];

/** A long-content edge case — exercises wrapping/overflow in MessageBubble and MessageList's viewport. */
export const longContentConversation: ChatMessage[] = [
  {
    id: "m1",
    role: "assistant",
    content: `Full run breakdown follows. ${"token ".repeat(120)}`.trim(),
    timestamp: "2026-07-16T08:05:00.000Z",
    authorName: "LoopOver",
  },
];
