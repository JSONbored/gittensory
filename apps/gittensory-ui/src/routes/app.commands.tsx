import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/commands")({
  beforeLoad: () => {
    throw redirect({ to: "/app/workbench", search: { tab: "commands" } });
  },
});
