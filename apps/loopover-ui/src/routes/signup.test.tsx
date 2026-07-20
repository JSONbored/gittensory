import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

const signIn = vi.fn();
let authState: { status: string; message?: string } = { status: "idle" };
vi.mock("@/lib/api/session", () => ({
  useSession: () => ({ auth: authState, signIn }),
}));

import { SignupPage } from "./signup";

// Self-serve signup surface (part of #4802).
describe("SignupPage (#4802 self-serve signup)", () => {
  it("presents the signup entry with the GitHub-account explanation points", () => {
    authState = { status: "idle" };
    render(<SignupPage />);
    expect(screen.getByRole("heading", { name: /Create your account with GitHub/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "GitHub is your identity" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Scoped from the start" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Straight to connecting a repo" })).toBeTruthy();
  });

  it("starts the real GitHub OAuth flow via signIn(), not a fabricated credential form", () => {
    authState = { status: "idle" };
    signIn.mockClear();
    render(<SignupPage />);
    // No password/email fields — identity is GitHub's.
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Continue with GitHub/i }));
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("shows a starting state while sign-in is in flight and disables the button", () => {
    authState = { status: "starting" };
    render(<SignupPage />);
    const button = screen.getByRole("button", { name: /Starting sign-up/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces an auth error message when sign-in fails", () => {
    authState = { status: "error", message: "GitHub sign-in was cancelled." };
    render(<SignupPage />);
    expect(screen.getByText("GitHub sign-in was cancelled.")).toBeTruthy();
  });

  it("routes onward to the install setup steps", () => {
    authState = { status: "idle" };
    render(<SignupPage />);
    expect(screen.getByRole("link", { name: /See the setup steps/i }).getAttribute("href")).toBe(
      "/install",
    );
  });
});
