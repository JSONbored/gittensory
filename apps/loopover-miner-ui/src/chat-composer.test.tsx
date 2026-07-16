import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatComposer } from "./components/chat-composer";

// jsdom computes no real layout, so a rendered <textarea>'s scrollHeight is 0. Stub it to a fixed pixel
// value so the auto-grow branch can be exercised deterministically (per the issue's jsdom gotcha note).
function stubScrollHeight(el: HTMLElement, value: number) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value });
}

describe("ChatComposer (#6514)", () => {
  it("submits the typed value on Enter and clears the textarea", () => {
    const onSubmit = vi.fn();
    render(<ChatComposer onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "hello fleet" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("hello fleet");
    expect(textarea.value).toBe(""); // cleared after a successful submit
  });

  it("inserts a newline on Shift+Enter without submitting", () => {
    const onSubmit = vi.fn();
    render(<ChatComposer onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "line one" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("line one"); // not cleared — no submit happened
  });

  it("submits identically when the Send button is clicked", () => {
    const onSubmit = vi.fn();
    render(<ChatComposer onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "via button" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("via button");
    expect(textarea.value).toBe("");
  });

  it("does NOT submit whitespace-only content — via Enter", () => {
    const onSubmit = vi.fn();
    render(<ChatComposer onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("   "); // left intact, not cleared
  });

  it("does NOT submit whitespace-only content — via the button", () => {
    const onSubmit = vi.fn();
    render(<ChatComposer onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "  \n\t " } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("auto-grows to fit content below the height cap (overflow hidden)", () => {
    render(<ChatComposer onSubmit={vi.fn()} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    stubScrollHeight(textarea, 48);
    fireEvent.change(textarea, { target: { value: "a\nb" } });

    expect(textarea.style.height).toBe("48px");
    expect(textarea.style.overflowY).toBe("hidden");
  });

  it("stops growing and scrolls internally once content exceeds the cap", () => {
    render(<ChatComposer onSubmit={vi.fn()} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    stubScrollHeight(textarea, 640);
    fireEvent.change(textarea, { target: { value: "many\nlines\nof\ntext\nhere" } });

    expect(textarea.style.height).toBe("200px"); // pinned at the cap
    expect(textarea.style.overflowY).toBe("auto"); // internal scroll takes over
  });

  it("disables both the textarea and the Send button when disabled", () => {
    render(<ChatComposer onSubmit={vi.fn()} disabled placeholder="Ask a question" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    const button = screen.getByRole("button", { name: /send/i }) as HTMLButtonElement;

    expect(textarea.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(textarea.getAttribute("placeholder")).toBe("Ask a question");
  });
});
