import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/playground")({
  beforeLoad: () => {
    throw redirect({ to: "/app/workbench", search: { tab: "playground" } });
  },
});
