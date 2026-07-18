// Client bridge to the read-only streaming chat endpoint (#6518, wiring the rail to the #6517 backend).
// `POST /api/chat` answers as `text/event-stream` — one `data: <json>\n\n` frame per event, consumed here via
// fetch() + ReadableStream (not the native EventSource, which can't send the POST body the endpoint needs).
// This yields only the human-readable `text` deltas as an async string stream, so it slots straight in as a
// `ChunkSource` for the shared `useStreamingText`/`StreamingText` renderer; grounding `tool_call`/`tool_result`
// frames are consumed and skipped (they carry no display text), `error` frames reject, and `done` ends the
// stream. A validation failure comes back as a plain non-streamed 4xx JSON body, surfaced here as a thrown error
// before any token is yielded.

import { demoStreamChat } from "./demo-data";
import { isDemoMode } from "./demo-mode";

/** The wire event union the endpoint emits (mirrored from vite-chat-api.ts's `ChatSseEvent`; the app
 *  deliberately doesn't import the server plugin module just for its type). */
export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; output: unknown }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

/** The message shape the endpoint grounds against — only the two conversational roles cross the wire. */
export type ChatWireMessage = { role: "user" | "assistant"; content: string };

export const CHAT_API_PATH = "/api/chat";

type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

/** Parse one accumulated SSE frame (its `data:` line) into a typed event, or null when it carries no data. */
function parseFrame(frame: string): ChatStreamEvent | null {
  const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  const payload = dataLine.slice("data:".length).trim();
  if (!payload) return null;
  return JSON.parse(payload) as ChatStreamEvent;
}

/**
 * Open the chat stream for `messages` and yield each `text` delta as it arrives. Throws before the first yield on
 * a non-2xx / non-streamed response, and mid-stream on an `error` frame, so the caller's stream renderer lands in
 * its error state. Injectable `fetchImpl` keeps it unit-testable against a fake ReadableStream.
 */
export async function* streamChat(
  messages: ChatWireMessage[],
  fetchImpl: FetchImpl = (input, init) => fetch(input, init),
): AsyncGenerator<string> {
  if (isDemoMode()) {
    yield* demoStreamChat();
    return;
  }
  const response = await fetchImpl(CHAT_API_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`chat backend responded ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are delimited by a blank line; drain every complete frame the buffer now holds.
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) {
          if (event.type === "text") yield event.text;
          else if (event.type === "error") throw new Error(event.message || event.code || "chat stream error");
          else if (event.type === "done") return;
          // tool_call / tool_result carry grounding, not display text — consume and skip.
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
