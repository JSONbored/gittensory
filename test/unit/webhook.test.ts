import { describe, expect, it } from "vitest";
import { readRequestTextWithinLimit } from "../../src/github/webhook";

describe("GitHub webhook body limits", () => {
  it("treats requests without a body as an empty string", async () => {
    const request = new Request("https://example.test/webhook", { method: "POST" });

    await expect(readRequestTextWithinLimit(request, 3)).resolves.toEqual({ ok: true, text: "" });
  });

  it("stops reading streamed bodies once the byte limit is exceeded", async () => {
    const request = new Request("https://example.test/webhook", {
      method: "POST",
      body: new Blob(["ab", "cd"]).stream(),
      duplex: "half",
    } as RequestInit);

    await expect(readRequestTextWithinLimit(request, 3)).resolves.toEqual({ ok: false });
  });
});
