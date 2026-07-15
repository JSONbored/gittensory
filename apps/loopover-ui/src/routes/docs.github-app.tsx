import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/github-app.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/github-app")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["github-app"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "GitHub App configuration — LoopOver docs" },
      {
        name: "description",
        content:
          "How the LoopOver GitHub App reviews pull requests once installed. Self-hosting is the only currently available path; a shared, centrally hosted App is planned as a future offering. The LoopOver Orb Review Agent check plus a review comment posted as loopover[bot]. Choose repos, configure sticky PR panels, advisory checks, and optional review-agent enforcement.",
      },
      { property: "og:title", content: "GitHub App configuration — LoopOver docs" },
      {
        property: "og:description",
        content:
          "How the LoopOver GitHub App reviews pull requests once installed. Self-hosting is the only currently available path; a shared, centrally hosted App is planned as a future offering. Choose repos, configure sticky PR panels, advisory checks, and optional review-agent enforcement.",
      },
      { property: "og:url", content: "/docs/github-app" },
    ],
    links: [{ rel: "canonical", href: "/docs/github-app" }],
  }),
  component: GithubApp,
});

function GithubApp() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Workflows" title={title} description={description}>
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
