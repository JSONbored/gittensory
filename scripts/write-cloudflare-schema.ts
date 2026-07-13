#!/usr/bin/env tsx
// Cloudflare's Schema Validation (Security > Settings > Schema validation) rejects an uploaded schema
// once it exceeds the zone's schema-storage limit — 204800 bytes (200 KiB) on the Free plan. The full
// public apps/gittensory-ui/public/openapi.json (pretty-printed, full response bodies + component
// schemas + prose descriptions) is ~480KB, since it's meant for human developers and doesn't need to fit
// under a WAF's storage cap.
//
// Schema Validation only inspects INCOMING requests (path/method/parameters/request body), never
// responses, so this strips everything response- and prose-related and re-derives a minimal,
// spec-valid variant sized for upload. Prints compact (no whitespace) JSON to stdout — redirect it to a
// file to upload: `npm run cloudflare:schema --silent > cloudflare-schema.json` (plain `npm run`
// without --silent interleaves npm's own "> package@version script-name" banner into stdout ahead of
// the JSON, corrupting the file).
import { buildOpenApiSpec } from "../src/openapi/spec";

type JsonValue = { [key: string]: unknown } | unknown[] | string | number | boolean | null;

export function buildCloudflareSchema(): Record<string, unknown> {
  const spec = buildOpenApiSpec() as unknown as Record<string, unknown>;
  spec.servers = [{ url: "https://api.loopover.ai", description: "Production" }];

  const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
  for (const methods of Object.values(paths ?? {})) {
    for (const operation of Object.values(methods)) {
      delete operation.description;
      delete operation.summary;
      for (const param of (operation.parameters as Array<Record<string, unknown>> | undefined) ?? []) {
        delete param.description;
      }
      const responses = operation.responses as Record<string, Record<string, unknown>> | undefined;
      for (const response of Object.values(responses ?? {})) {
        delete response.content;
        // OpenAPI 3.0 requires responses.<code>.description to be present; Schema Validation never
        // reads it, so an empty string satisfies the spec without spending upload-size budget on prose.
        response.description = "";
      }
    }
  }

  // components.schemas is response-only in this generator (every request body is inline Zod, never a
  // registered $ref) as of this writing, so it becomes fully unreferenced once response content is
  // stripped above. Prune by actual reachability rather than assuming that stays true forever: walk
  // every remaining $ref under paths, expand transitively through the schemas they point to, and keep
  // only what is (still) reachable.
  const components = spec.components as { schemas?: Record<string, unknown> } | undefined;
  const schemas = components?.schemas ?? {};
  const reachable = new Set<string>();
  const frontier = [...collectRefs(paths)];
  while (frontier.length > 0) {
    const ref = frontier.pop()!;
    const name = ref.split("/").pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    frontier.push(...collectRefs(schemas[name]));
  }
  if (components) {
    components.schemas = Object.fromEntries(Object.entries(schemas).filter(([name]) => reachable.has(name)));
  }

  return spec;
}

export function collectRefs(value: unknown): string[] {
  const refs: string[] = [];
  walk(value as JsonValue);
  return refs;

  function walk(node: JsonValue) {
    if (Array.isArray(node)) {
      for (const item of node) walk(item as JsonValue);
      return;
    }
    if (node && typeof node === "object") {
      const ref = (node as Record<string, unknown>).$ref;
      if (typeof ref === "string") refs.push(ref);
      for (const v of Object.values(node)) walk(v as JsonValue);
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  process.stdout.write(JSON.stringify(buildCloudflareSchema()));
}
