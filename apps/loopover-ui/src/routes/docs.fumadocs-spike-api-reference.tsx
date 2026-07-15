import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";

// SPIKE (#6037): standalone Scalar API reference page against the existing OpenAPI
// output (npm run ui:openapi), per the issue's "add @scalar/api-reference as a
// standalone page ... instead of fumadocs-openapi" requirement. Scalar's underlying
// Vue widget mounts into the DOM directly and isn't SSR-safe, so it's wrapped in
// ClientOnly (client-hydration-only, same category of constraint the MDX-body
// rendering hit -- but here it's an isolated widget, not something that needs to
// participate in SSR content, so ClientOnly is a clean, non-hacky fit).
export const Route = createFileRoute("/docs/fumadocs-spike-api-reference")({
  component: SpikeApiReference,
});

function SpikeApiReference() {
  return (
    <ClientOnly
      fallback={
        <div className="p-6 text-token-sm text-muted-foreground">Loading API reference…</div>
      }
    >
      <ApiReferenceReact configuration={{ url: "/openapi.json" }} />
    </ClientOnly>
  );
}
