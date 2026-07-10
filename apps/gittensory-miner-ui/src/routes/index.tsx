import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

// Empty routing/layout shell only (issue #4303). The run-history table (#4305) and portfolio/queue
// summary cards (#4306) are separate, dependent follow-up issues.
function IndexPage() {
  return (
    <div className="rounded-md border border-dashed border-gray-300 p-8 text-center text-gray-500">
      No views yet -- this is a scaffold shell.
    </div>
  );
}
