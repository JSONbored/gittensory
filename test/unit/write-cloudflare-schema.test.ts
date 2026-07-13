import { describe, expect, it } from "vitest";
import { buildCloudflareSchema, collectRefs } from "../../scripts/write-cloudflare-schema";

// Cloudflare Schema Validation rejects an upload once it exceeds the zone's schema-storage limit
// (204800 bytes / 200 KiB on the Free plan, confirmed against a real "Zone schema storage limit of
// 204800 bytes exceeded" (code 20400) upload error). This pins the trimmed variant well under that
// budget with real margin for the API surface to keep growing.
describe("buildCloudflareSchema", () => {
  it("stays comfortably under Cloudflare's 204800-byte Free-plan schema-storage limit", () => {
    const compact = JSON.stringify(buildCloudflareSchema());
    expect(compact.length).toBeLessThan(100_000);
  });

  it("is valid, spec-compliant JSON with every response carrying the OpenAPI-required description field", () => {
    const spec = buildCloudflareSchema() as { paths: Record<string, Record<string, { responses?: Record<string, { description?: unknown; content?: unknown }> }>> };
    for (const methods of Object.values(spec.paths)) {
      for (const operation of Object.values(methods)) {
        for (const response of Object.values(operation.responses ?? {})) {
          expect(typeof response.description).toBe("string");
          expect(response.content).toBeUndefined();
        }
      }
    }
  });

  it("keeps an in:path parameter declared for every {templated} path segment", () => {
    const spec = buildCloudflareSchema() as { paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }> }>> };
    for (const [path, methods] of Object.entries(spec.paths)) {
      const templateParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
      if (templateParams.length === 0) continue;
      for (const operation of Object.values(methods)) {
        const declared = new Set((operation.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name));
        for (const param of templateParams) expect(declared.has(param)).toBe(true);
      }
    }
  });

  it("prunes components.schemas down to only what's still $ref-reachable from paths", () => {
    const spec = buildCloudflareSchema() as { paths: unknown; components?: { schemas?: Record<string, unknown> } };
    const reachable = new Set(collectRefs(spec.paths).map((ref) => ref.split("/").pop()));
    const kept = Object.keys(spec.components?.schemas ?? {});
    for (const name of kept) expect(reachable.has(name)).toBe(true);
  });
});

describe("collectRefs", () => {
  it("finds every $ref in a nested structure, including inside arrays", () => {
    const refs = collectRefs({
      a: { $ref: "#/components/schemas/Foo" },
      b: [{ $ref: "#/components/schemas/Bar" }, { c: { $ref: "#/components/schemas/Baz" } }],
      d: "not a ref object",
    });
    expect(refs.sort()).toEqual(["#/components/schemas/Bar", "#/components/schemas/Baz", "#/components/schemas/Foo"]);
  });

  it("returns an empty array when nothing references a schema", () => {
    expect(collectRefs({ a: { type: "string" }, b: [1, 2, 3] })).toEqual([]);
  });
});
