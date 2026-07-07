import { describe, expect, it } from "vitest";

import {
  compileFocusManifestPolicy,
  matchesManifestPath,
  parseFocusManifest,
  parseFocusManifestContent,
} from "../../packages/gittensory-engine/src/focus-manifest";

describe("gittensory-engine focus-manifest barrel exports (#2280)", () => {
  it("re-exports the focus-manifest parse/compile API from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.parseFocusManifest).toBe("function");
    expect(typeof barrel.parseFocusManifestContent).toBe("function");
    expect(typeof barrel.compileFocusManifestPolicy).toBe("function");
    expect(typeof barrel.matchesManifestPath).toBe("function");
    expect(typeof barrel.isFocusManifestPublicSafe).toBe("function");
    expect(barrel.MAX_FOCUS_MANIFEST_BYTES).toBeGreaterThan(0);
    expect(typeof barrel.parseFocusManifest).toBe(typeof parseFocusManifest);
    expect(typeof barrel.parseFocusManifestContent).toBe(typeof parseFocusManifestContent);
    expect(typeof barrel.compileFocusManifestPolicy).toBe(typeof compileFocusManifestPolicy);
    expect(typeof barrel.matchesManifestPath).toBe(typeof matchesManifestPath);
  });
});
