import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Github, Loader2, ShieldCheck, GitPullRequest } from "lucide-react";

import { Section, SectionTitle, Card, Callout, Eyebrow } from "@/components/site/primitives";
import { useSession } from "@/lib/api/session";

// Self-serve signup surface (part of #4802). The install flow's first step ("Sign up") previously had
// no dedicated page -- this is it: it explains the GitHub-backed account model and starts the real
// GitHub OAuth flow (useSession().signIn -> /v1/auth/github/start), then points to /install to connect
// a repository. No credential form is collected here; identity is GitHub's, matching how the rest of the
// app authenticates. Reads no secrets and fabricates no session.

export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [
      { title: "Sign up — LoopOver self-serve" },
      {
        name: "description",
        content:
          "Create your LoopOver account with GitHub, then install the App on your own repository — self-serve, no engineering step required.",
      },
      { property: "og:title", content: "Sign up — LoopOver self-serve" },
      {
        property: "og:description",
        content: "Sign up with GitHub and connect your repository, self-serve.",
      },
      { property: "og:url", content: "/signup" },
    ],
    links: [{ rel: "canonical", href: "/signup" }],
  }),
  component: SignupPage,
});

const POINTS = [
  {
    icon: Github,
    title: "GitHub is your identity",
    description:
      "No separate password to manage. You sign in with GitHub, and your account is tied to the repositories you already own.",
  },
  {
    icon: ShieldCheck,
    title: "Scoped from the start",
    description:
      "Signing up grants nothing on your repositories. Access is requested only when you install the App, and you confirm the exact scopes then.",
  },
  {
    icon: GitPullRequest,
    title: "Straight to connecting a repo",
    description:
      "Once you're signed in, connect a repository and LoopOver starts reviewing its pull requests — no engineering handoff.",
  },
];

export function SignupPage() {
  const { auth, signIn } = useSession();
  const isStarting = auth.status === "starting";

  return (
    <>
      <Section className="pt-16 pb-12 sm:pt-24">
        <div className="max-w-3xl">
          <Eyebrow accent>Step 1 · Sign up</Eyebrow>
          <h1 className="mt-4 text-token-2xl font-medium tracking-tight text-foreground">
            Create your account with GitHub.
          </h1>
          <p className="mt-4 max-w-2xl text-token-md text-muted-foreground">
            LoopOver is self-serve: sign up with GitHub, then install the App on your own repository
            and confirm the scoped permissions — no manual or engineering step.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void signIn()}
              disabled={isStarting}
              className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-token bg-coral px-4 text-token-sm font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] focus-ring motion-reduce:transition-none motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isStarting ? (
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Github className="size-3.5" />
              )}
              {isStarting ? "Starting sign-up…" : "Continue with GitHub"}
            </button>
            <Link
              to="/install"
              className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-token border border-border bg-transparent px-4 text-token-sm font-medium text-foreground transition-colors duration-150 hover:bg-accent focus-ring motion-reduce:transition-none"
            >
              See the setup steps
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
          {auth.status === "error" ? (
            <p className="mt-3 max-w-md rounded-token border border-danger/40 bg-danger/10 px-3 py-2 text-token-xs text-danger">
              {auth.message}
            </p>
          ) : null}
        </div>
      </Section>

      <Section className="py-0">
        <SectionTitle
          eyebrow="What signing up means"
          title="An account you already control"
          description="Signup is a GitHub sign-in, not a new credential store. You stay in control of what LoopOver can access, and when."
        />
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {POINTS.map((point) => {
            const Icon = point.icon;
            return (
              <Card key={point.title}>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Icon aria-hidden className="size-4" />
                  <h3 className="text-token-md font-medium text-foreground">{point.title}</h3>
                </div>
                <p className="mt-2 text-token-sm text-muted-foreground">{point.description}</p>
              </Card>
            );
          })}
        </div>
      </Section>

      <Section className="pt-12 pb-24">
        <div className="max-w-3xl">
          <Callout variant="safety" title="Nothing is granted by signing up">
            Creating an account grants LoopOver no access to any repository. That happens only at
            install, where you pick the repositories and confirm the scopes. See{" "}
            <Link to="/install" className="text-foreground underline underline-offset-2">
              the setup steps
            </Link>{" "}
            for what comes next.
          </Callout>
        </div>
      </Section>
    </>
  );
}
