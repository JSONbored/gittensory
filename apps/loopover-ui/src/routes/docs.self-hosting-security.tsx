import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/self-hosting-security.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-security")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["self-hosting-security"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Self-host security — LoopOver docs" },
      {
        name: "description",
        content:
          "Secure the self-hosted LoopOver review service: secrets, private rules, network exposure, public output boundaries, REES, AI credentials, and observability.",
      },
      { property: "og:title", content: "Self-host security — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Secure the self-hosted LoopOver review service: secrets, private rules, network exposure, public output boundaries, REES, AI credentials, and observability.",
      },
      { property: "og:url", content: "/docs/self-hosting-security" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-security" }],
  }),
  component: SelfHostingSecurity,
});

function SelfHostingSecurity() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Self-hosting" title={title} description={description}>
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
