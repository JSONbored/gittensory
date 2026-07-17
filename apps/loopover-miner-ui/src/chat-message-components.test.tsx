import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageList } from "./components/chat/message-list";
import { MessageBubble } from "./components/chat/message-bubble";
import { TypingIndicator } from "./components/chat/typing-indicator";
import { emptyConversation, multiTurnConversation, singleMessage, type ChatMessage } from "./components/chat/fixtures";

describe("MessageList (#6515) — StateBoundary branches", () => {
  it("renders one bubble per message in the populated state", () => {
    render(<MessageList messages={multiTurnConversation} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(multiTurnConversation.length);
    expect(screen.getByText(multiTurnConversation[0]!.content)).toBeTruthy();
  });

  it("shows the empty state (not a bare list) when there are no messages", () => {
    render(<MessageList messages={emptyConversation} />);
    expect(screen.getByText(/No messages yet/i)).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("shows the loading state", () => {
    render(<MessageList messages={emptyConversation} isLoading />);
    expect(screen.getByText(/Loading conversation/i)).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("shows the error state", () => {
    render(<MessageList messages={emptyConversation} isError />);
    expect(screen.getByText(/Couldn't load the conversation/i)).toBeTruthy();
  });

  it("renders the typing indicator (below the list) when composing, independent of message state", () => {
    render(<MessageList messages={singleMessage} composing />);
    expect(screen.getByRole("status", { name: /is typing/i })).toBeTruthy();
    // still renders the list itself
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("does not render the typing indicator when not composing", () => {
    render(<MessageList messages={singleMessage} />);
    expect(screen.queryByRole("status", { name: /is typing/i })).toBeNull();
  });

  it("marks the committed-message list as a polite live region (#7081)", () => {
    render(<MessageList messages={singleMessage} />);
    const list = screen.getByRole("list");
    expect(list.getAttribute("aria-live")).toBe("polite");
    // `additions` (not the default `additions text`) so a completed turn announces the new bubble once,
    // not on every mutation of already-present nodes.
    expect(list.getAttribute("aria-relevant")).toBe("additions");
  });

  it("appends the completed turn into the same live region so it is announced once (#7081)", () => {
    const { rerender } = render(<MessageList messages={singleMessage} />);
    const before = screen.getByRole("list");
    expect(before.getAttribute("aria-live")).toBe("polite");
    expect(within(before).getAllByRole("listitem")).toHaveLength(singleMessage.length);

    const completedTurn: ChatMessage[] = [
      ...singleMessage,
      {
        id: "turn-done",
        role: "assistant",
        content: "the finished answer",
        timestamp: "2026-07-16T08:05:00.000Z",
        authorName: "LoopOver",
      },
    ];
    rerender(<MessageList messages={completedTurn} />);
    // Same live region, now carrying the newly-appended bubble — a single announce-able addition.
    const after = screen.getByRole("list");
    expect(after.getAttribute("aria-live")).toBe("polite");
    expect(within(after).getAllByRole("listitem")).toHaveLength(completedTurn.length);
    expect(within(after).getByText("the finished answer")).toBeTruthy();
  });
});

describe("MessageBubble (#6515) — role-color + avatar branches", () => {
  const base: ChatMessage = {
    id: "x",
    role: "assistant",
    content: "hello world",
    timestamp: "2026-07-16T08:00:00.000Z",
  };

  it("applies a distinct role-colored background per role, from theme tokens only", () => {
    const roleToClass: Record<ChatMessage["role"], string> = {
      user: "bg-primary",
      assistant: "bg-muted",
      system: "bg-secondary",
    };
    for (const [role, cls] of Object.entries(roleToClass) as [ChatMessage["role"], string][]) {
      const { unmount } = render(<MessageBubble message={{ ...base, role, content: `c-${role}` }} />);
      expect(screen.getByText(`c-${role}`).className).toContain(cls);
      unmount();
    }
  });

  it("renders the initials fallback from the author name (or role when unnamed)", () => {
    const { unmount } = render(<MessageBubble message={{ ...base, authorName: "operator" }} />);
    expect(screen.getByText("OP")).toBeTruthy();
    unmount();
    render(<MessageBubble message={base} />); // no authorName → falls back to the role
    expect(screen.getByText("AS")).toBeTruthy();
  });

  it("renders no <img> and shows the initials fallback when no avatarUrl is given", () => {
    const { container } = render(<MessageBubble message={base} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("AS")).toBeTruthy();
  });

  it("accepts an avatarUrl without breaking the fallback path", () => {
    // Radix AvatarImage mounts the real <img> only after it loads (which never happens in jsdom), so the
    // initials fallback is the state that renders here — exercising the avatarUrl-present branch safely.
    render(
      <MessageBubble message={{ ...base, role: "user", authorName: "operator", avatarUrl: "https://a.test/o.png" }} />,
    );
    expect(screen.getByText("OP")).toBeTruthy();
  });

  it("renders a machine-readable timestamp", () => {
    render(<MessageBubble message={base} />);
    const time = document.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe(base.timestamp);
  });
});

describe("TypingIndicator (#6515) — composing branches + accessible name", () => {
  it("renders a typing-specific accessible name (not 'loading') when composing", () => {
    render(<TypingIndicator composing authorName="LoopOver" />);
    const status = screen.getByRole("status", { name: /LoopOver is typing/i });
    expect(status).toBeTruthy();
    expect(status.getAttribute("aria-label")).toMatch(/typing/i);
    expect(status.getAttribute("aria-label")).not.toMatch(/loading/i);
  });

  it("renders nothing when not composing", () => {
    const { container } = render(<TypingIndicator composing={false} />);
    expect(container.firstChild).toBeNull();
  });
});
