import { RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getRouter } from "./router";

describe("router shell (#4303)", () => {
  it("renders the root layout and the index route's placeholder shell", async () => {
    const router = getRouter();
    render(<RouterProvider router={router} />);

    await waitFor(() => expect(screen.getByText("gittensory-miner")).toBeTruthy());
    expect(screen.getByText("No views yet -- this is a scaffold shell.")).toBeTruthy();
  });
});
