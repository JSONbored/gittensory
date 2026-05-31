import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/miner")({
  beforeLoad: () => {
    throw redirect({ to: "/app/workbench", search: { tab: "miner" } });
  },
});
