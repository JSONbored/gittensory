#!/usr/bin/env node
import { runAttempt } from "../lib/attempt-cli.js";
import { printHelp, printVersion, runCli } from "../lib/cli.js";
import { configureLogger, extractLogOptions } from "../lib/logger.js";
import { runDenyCheck } from "../lib/deny-check.js";
import { runDiscover } from "../lib/discover-cli.js";
import { runFeasibilityCli } from "../lib/feasibility-cli.js";
import { runIdeaFeasibilityCli } from "../lib/idea-feasibility-cli.js";
import { runGovernorCli } from "../lib/governor-ledger-cli.js";
import { runLedgerCli } from "../lib/event-ledger-cli.js";
import { runCalibrationCli } from "../lib/calibration-cli.js";
import { runLoop } from "../lib/loop-cli.js";
import { runManagePoll } from "../lib/manage-poll.js";
import { runManageStatus } from "../lib/manage-status.js";
import { runMetrics } from "../lib/metrics-cli.js";
import { runPlanCli } from "../lib/plan-store-cli.js";
import { runClaimCli } from "../lib/claim-ledger-cli.js";
import { runPurge } from "../lib/purge-cli.js";
import { runQueueCli } from "../lib/portfolio-queue-cli.js";
import { runOrbExportCli } from "../lib/orb-export.js";
import { runTenantCli } from "../lib/tenant-cli.js";
import { installCliSignalHandlers } from "../lib/process-lifecycle.js";
import { captureMinerErrorAndFlush, initMinerSentry } from "../lib/sentry.js";
import { runStateCli } from "../lib/run-state-cli.js";
import { runInit } from "../lib/laptop-init.js";
import { createWizardIo, runInteractiveInit } from "../lib/init-wizard.js";
import { loadMinerFileSecrets } from "../lib/env-file-indirection.js";
import { runMigrate } from "../lib/migrate-cli.js";
import { runDoctor, runStatus } from "../lib/status.js";
import { awaitOpportunisticUpdateCheck, resolveUpgradeCommand, startUpdateCheck, } from "../lib/update-check.js";
import { resolveMinerVersion } from "../lib/version.js";
// Resolve any `<NAME>_FILE` secret-mount vars (GITHUB_TOKEN_FILE, etc.) into their plain counterparts FIRST,
// before anything else reads process.env -- every subcommand below (and the coding-agent driver construction
// deeper in the call graph) reads plain env vars, so this single early pass is all that's needed for the whole
// CLI (#5178). A broken secret mount fails the process fast and loud with a clear message, instead of an
// uncaught-exception stack trace or a silent empty credential surfacing as a confusing GitHub 401 later.
// Exits 2, not 1: docs/unattended-scheduling.md's contract only defines 0 (success) and 2 (failure -- "Alert
// on this"), so an operator alerting strictly on 2 would otherwise miss a broken secret mount entirely.
try {
    loadMinerFileSecrets();
}
catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
}
// Opt-in Sentry (#6011): a complete no-op unless the operator sets LOOPOVER_MINER_SENTRY_DSN themselves. Must
// run AFTER loadMinerFileSecrets (so a `_FILE`-mounted DSN resolves first) and BEFORE installCliSignalHandlers
// (so a startup crash is still captured).
/* v8 ignore start -- process entry point (this bin's top level runs unconditionally, every invocation);
 * exercised by the real --help/--version subprocess spawn in miner-package-skeleton.test.ts (a different
 * Node process, invisible to this test run's own coverage instrumentation), not unit-coverable here. The
 * functions themselves (initMinerSentry, installCliSignalHandlers) are fully unit-tested in isolation
 * (miner-sentry.test.ts, miner-process-lifecycle.test.ts) -- this is only the top-level wiring that calls
 * them, mirroring src/server.ts's identical, already-established exemption in codecov.yml. */
await initMinerSentry(process.env);
// Register signal + crash handlers once, before any command runs, so an interrupted run closes its open ledgers
// cleanly instead of dying mid-write (#4826). Covers every subcommand below, including the local ones.
installCliSignalHandlers({ captureError: captureMinerErrorAndFlush });
/* v8 ignore stop */
// Peel the global logging flags (--quiet/--verbose/--log-level) off the front of argv and configure the
// process-wide logger once (#4835), so every command below shares one level-aware logger without re-parsing
// them; the stripped `cliArgs` is what the command dispatch sees.
const { options: logOptions, rest: cliArgs } = extractLogOptions(process.argv.slice(2));
configureLogger({ ...logOptions, env: process.env });
// `status` and `doctor` are strictly local, offline commands — their contract is to make NO network calls.
// `init` stays local by default and only makes a network call when the operator explicitly passes
// `--verify-token`.
// Dispatch the local commands BEFORE the opportunistic npm-registry update check is even started, so they can
// never reach that network path (the update check runs for the remaining commands below).
if (cliArgs[0] === "init") {
    if (cliArgs.includes("--interactive")) {
        const wizardIo = createWizardIo();
        try {
            process.exit(await runInteractiveInit(process.env, process.cwd(), wizardIo));
        }
        finally {
            wizardIo.close();
        }
    }
    process.exit(await runInit(cliArgs.slice(1)));
}
if (cliArgs[0] === "status") {
    process.exit(runStatus(cliArgs.slice(1)));
}
if (cliArgs[0] === "doctor") {
    process.exit(runDoctor(cliArgs.slice(1)));
}
// `migrate` is strictly local + offline like `status`/`doctor` (it only opens the local SQLite stores), so it is
// dispatched here too, before the opportunistic npm-registry update check is ever started.
if (cliArgs[0] === "migrate") {
    process.exit(runMigrate(cliArgs.slice(1)));
}
// `metrics` is strictly local + offline like `status`/`doctor` (it reads only the local prediction ledger), so it
// is dispatched here, before the opportunistic npm-registry update check is ever started.
if (cliArgs[0] === "metrics") {
    process.exit(runMetrics(cliArgs.slice(1)));
}
if (cliArgs[0] === "manage" && cliArgs[1] === "status") {
    process.exit(runManageStatus(cliArgs.slice(2)));
}
if (cliArgs[0] === "queue") {
    process.exit(runQueueCli(cliArgs[1], cliArgs.slice(2)));
}
if (cliArgs[0] === "orb" && cliArgs[1] === "export") {
    process.exit(await runOrbExportCli(cliArgs.slice(2)));
}
// `tenant` (#7275) talks to the hosting control-plane's provisioning API — a deliberate, Bearer-authed admin
// action that is inert unless LOOPOVER_MINER_CONTROL_PLANE is set. Grouped with `orb export` above (also a
// network command) rather than the strictly-local commands; it fails loud on any control-plane error.
if (cliArgs[0] === "tenant") {
    process.exit(await runTenantCli(cliArgs[1], cliArgs.slice(2)));
}
if (cliArgs[0] === "claim") {
    process.exit(runClaimCli(cliArgs[1], cliArgs.slice(2)));
}
if (cliArgs[0] === "ledger") {
    process.exit(runLedgerCli(cliArgs[1], cliArgs.slice(2)));
}
if (cliArgs[0] === "calibration") {
    process.exit(runCalibrationCli(cliArgs.slice(1)));
}
if (cliArgs[0] === "plan") {
    process.exit(runPlanCli(cliArgs[1], cliArgs.slice(2)));
}
if (cliArgs[0] === "governor") {
    process.exit(await runGovernorCli(cliArgs[1], cliArgs.slice(2)));
}
if (cliArgs[0] === "feasibility") {
    process.exit(runFeasibilityCli(cliArgs.slice(1)));
}
if (cliArgs[0] === "idea-feasibility") {
    process.exit(runIdeaFeasibilityCli(cliArgs.slice(1)));
}
// `purge` (#5564) is strictly local + offline like `queue`/`claim`/`governor` above -- it only opens the local
// SQLite stores, so it is dispatched here too, before the opportunistic npm-registry update check ever starts.
if (cliArgs[0] === "purge") {
    process.exit(runPurge(cliArgs.slice(1)));
}
const packageName = "@loopover/miner";
const packageVersion = resolveMinerVersion(process.env);
const upgradeCommand = resolveUpgradeCommand(packageName);
const updateCheck = startUpdateCheck(cliArgs, {
    packageName,
    packageVersion,
    upgradeCommand,
    env: process.env,
});
if (cliArgs.length === 0 ||
    cliArgs.includes("--help") ||
    cliArgs.includes("-h") ||
    cliArgs[0] === "help") {
    printHelp({ packageName });
    await awaitOpportunisticUpdateCheck(updateCheck);
    process.exit(0);
}
if (cliArgs.includes("--version") ||
    cliArgs.includes("-v") ||
    cliArgs[0] === "version") {
    printVersion({ packageName, packageVersion });
    await awaitOpportunisticUpdateCheck(updateCheck);
    process.exit(0);
}
if (cliArgs[0] === "hooks" && cliArgs[1] === "check") {
    const exitCode = runDenyCheck(cliArgs.slice(2));
    await awaitOpportunisticUpdateCheck(updateCheck);
    process.exit(exitCode);
}
if (cliArgs[0] === "state") {
    const exitCode = runStateCli(cliArgs[1], cliArgs.slice(2));
    await awaitOpportunisticUpdateCheck(updateCheck);
    process.exit(exitCode);
}
if (cliArgs[0] === "manage" && cliArgs[1] === "poll") {
    const exitCode = await runManagePoll(cliArgs.slice(2));
    await awaitOpportunisticUpdateCheck(updateCheck);
    process.exit(exitCode);
}
if (cliArgs[0] === "discover") {
    const exitCode = await runDiscover(cliArgs.slice(1));
    await awaitOpportunisticUpdateCheck(updateCheck);
    process.exit(exitCode);
}
if (cliArgs[0] === "attempt") {
    const exitCode = await runAttempt(cliArgs.slice(1));
    await awaitOpportunisticUpdateCheck(updateCheck);
    process.exit(exitCode);
}
if (cliArgs[0] === "loop") {
    const exitCode = await runLoop(cliArgs.slice(1));
    await awaitOpportunisticUpdateCheck(updateCheck);
    process.exit(exitCode);
}
const exitCode = runCli(cliArgs, { packageName });
await awaitOpportunisticUpdateCheck(updateCheck);
process.exit(exitCode);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9vcG92ZXItbWluZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJsb29wb3Zlci1taW5lci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQ0EsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBQ25ELE9BQU8sRUFBRSxTQUFTLEVBQUUsWUFBWSxFQUFFLE1BQU0sRUFBRSxNQUFNLGVBQWUsQ0FBQztBQUNoRSxPQUFPLEVBQUUsZUFBZSxFQUFFLGlCQUFpQixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDdEUsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBQ3BELE9BQU8sRUFBRSxXQUFXLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUNyRCxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSwyQkFBMkIsQ0FBQztBQUM5RCxPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSxnQ0FBZ0MsQ0FBQztBQUN2RSxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sK0JBQStCLENBQUM7QUFDL0QsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLDRCQUE0QixDQUFDO0FBQzFELE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBQzlELE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQUM3QyxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sdUJBQXVCLENBQUM7QUFDdEQsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLHlCQUF5QixDQUFDO0FBQzFELE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSx1QkFBdUIsQ0FBQztBQUNuRCxPQUFPLEVBQUUsVUFBVSxFQUFFLE1BQU0sMEJBQTBCLENBQUM7QUFDdEQsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLDRCQUE0QixDQUFDO0FBQ3pELE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUMvQyxPQUFPLEVBQUUsV0FBVyxFQUFFLE1BQU0sK0JBQStCLENBQUM7QUFDNUQsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBQ3ZELE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUNwRCxPQUFPLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSw2QkFBNkIsQ0FBQztBQUN2RSxPQUFPLEVBQUUseUJBQXlCLEVBQUUsZUFBZSxFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDOUUsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLHlCQUF5QixDQUFDO0FBQ3RELE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSx1QkFBdUIsQ0FBQztBQUNoRCxPQUFPLEVBQUUsY0FBYyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sdUJBQXVCLENBQUM7QUFDM0UsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sZ0NBQWdDLENBQUM7QUFDdEUsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBQ25ELE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDeEQsT0FBTyxFQUNMLDZCQUE2QixFQUM3QixxQkFBcUIsRUFDckIsZ0JBQWdCLEdBQ2pCLE1BQU0sd0JBQXdCLENBQUM7QUFDaEMsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFFeEQsNkdBQTZHO0FBQzdHLDZHQUE2RztBQUM3RywrR0FBK0c7QUFDL0cseUdBQXlHO0FBQ3pHLHlHQUF5RztBQUN6Ryw2R0FBNkc7QUFDN0csd0dBQXdHO0FBQ3hHLElBQUksQ0FBQztJQUNILG9CQUFvQixFQUFFLENBQUM7QUFDekIsQ0FBQztBQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7SUFDZixPQUFPLENBQUMsS0FBSyxDQUFDLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3RFLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbEIsQ0FBQztBQUVELDhHQUE4RztBQUM5RywrR0FBK0c7QUFDL0csMENBQTBDO0FBQzFDOzs7Ozs4RkFLOEY7QUFDOUYsTUFBTSxlQUFlLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBRW5DLGdIQUFnSDtBQUNoSCx1R0FBdUc7QUFDdkcsd0JBQXdCLENBQUMsRUFBRSxZQUFZLEVBQUUseUJBQXlCLEVBQUUsQ0FBQyxDQUFDO0FBQ3RFLG9CQUFvQjtBQUVwQix3R0FBd0c7QUFDeEcsNEdBQTRHO0FBQzVHLGtFQUFrRTtBQUNsRSxNQUFNLEVBQUUsT0FBTyxFQUFFLFVBQVUsRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLEdBQUcsaUJBQWlCLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN4RixlQUFlLENBQUMsRUFBRSxHQUFHLFVBQVUsRUFBRSxHQUFHLEVBQUUsT0FBTyxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUM7QUFFckQsMkdBQTJHO0FBQzNHLGtHQUFrRztBQUNsRyxvQkFBb0I7QUFDcEIsOEdBQThHO0FBQzlHLDBGQUEwRjtBQUMxRixJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxNQUFNLEVBQUUsQ0FBQztJQUMxQixJQUFJLE9BQU8sQ0FBQyxRQUFRLENBQUMsZUFBZSxDQUFDLEVBQUUsQ0FBQztRQUN0QyxNQUFNLFFBQVEsR0FBRyxjQUFjLEVBQUUsQ0FBQztRQUNsQyxJQUFJLENBQUM7WUFDSCxPQUFPLENBQUMsSUFBSSxDQUFDLE1BQU0sa0JBQWtCLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxPQUFPLENBQUMsR0FBRyxFQUFFLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztRQUMvRSxDQUFDO2dCQUFTLENBQUM7WUFDVCxRQUFRLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDbkIsQ0FBQztJQUNILENBQUM7SUFDRCxPQUFPLENBQUMsSUFBSSxDQUFDLE1BQU0sT0FBTyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2hELENBQUM7QUFFRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxRQUFRLEVBQUUsQ0FBQztJQUM1QixPQUFPLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM1QyxDQUFDO0FBRUQsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssUUFBUSxFQUFFLENBQUM7SUFDNUIsT0FBTyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDNUMsQ0FBQztBQUVELGlIQUFpSDtBQUNqSCwyRkFBMkY7QUFDM0YsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssU0FBUyxFQUFFLENBQUM7SUFDN0IsT0FBTyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDN0MsQ0FBQztBQUVELGtIQUFrSDtBQUNsSCwwRkFBMEY7QUFDMUYsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssU0FBUyxFQUFFLENBQUM7SUFDN0IsT0FBTyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDN0MsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLFFBQVEsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssUUFBUSxFQUFFLENBQUM7SUFDdkQsT0FBTyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbEQsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLE9BQU8sRUFBRSxDQUFDO0lBQzNCLE9BQU8sQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMxRCxDQUFDO0FBRUQsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssS0FBSyxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxRQUFRLEVBQUUsQ0FBQztJQUNwRCxPQUFPLENBQUMsSUFBSSxDQUFDLE1BQU0sZUFBZSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3hELENBQUM7QUFFRCw2R0FBNkc7QUFDN0csMkdBQTJHO0FBQzNHLHNHQUFzRztBQUN0RyxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxRQUFRLEVBQUUsQ0FBQztJQUM1QixPQUFPLENBQUMsSUFBSSxDQUFDLE1BQU0sWUFBWSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNqRSxDQUFDO0FBRUQsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssT0FBTyxFQUFFLENBQUM7SUFDM0IsT0FBTyxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzFELENBQUM7QUFFRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxRQUFRLEVBQUUsQ0FBQztJQUM1QixPQUFPLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDM0QsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLGFBQWEsRUFBRSxDQUFDO0lBQ2pDLE9BQU8sQ0FBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEQsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLE1BQU0sRUFBRSxDQUFDO0lBQzFCLE9BQU8sQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN6RCxDQUFDO0FBRUQsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssVUFBVSxFQUFFLENBQUM7SUFDOUIsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLGNBQWMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbkUsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLGFBQWEsRUFBRSxDQUFDO0lBQ2pDLE9BQU8sQ0FBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEQsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLGtCQUFrQixFQUFFLENBQUM7SUFDdEMsT0FBTyxDQUFDLElBQUksQ0FBQyxxQkFBcUIsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN4RCxDQUFDO0FBRUQsK0dBQStHO0FBQy9HLCtHQUErRztBQUMvRyxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxPQUFPLEVBQUUsQ0FBQztJQUMzQixPQUFPLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzQyxDQUFDO0FBRUQsTUFBTSxXQUFXLEdBQUcsaUJBQWlCLENBQUM7QUFDdEMsTUFBTSxjQUFjLEdBQUcsbUJBQW1CLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ3hELE1BQU0sY0FBYyxHQUFHLHFCQUFxQixDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBRTFELE1BQU0sV0FBVyxHQUFHLGdCQUFnQixDQUFDLE9BQU8sRUFBRTtJQUM1QyxXQUFXO0lBQ1gsY0FBYztJQUNkLGNBQWM7SUFDZCxHQUFHLEVBQUUsT0FBTyxDQUFDLEdBQUc7Q0FDakIsQ0FBQyxDQUFDO0FBRUgsSUFDRSxPQUFPLENBQUMsTUFBTSxLQUFLLENBQUM7SUFDcEIsT0FBTyxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUM7SUFDMUIsT0FBTyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUM7SUFDdEIsT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLE1BQU0sRUFDckIsQ0FBQztJQUNELFNBQVMsQ0FBQyxFQUFFLFdBQVcsRUFBRSxDQUFDLENBQUM7SUFDM0IsTUFBTSw2QkFBNkIsQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUNqRCxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xCLENBQUM7QUFFRCxJQUNFLE9BQU8sQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDO0lBQzdCLE9BQU8sQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDO0lBQ3RCLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxTQUFTLEVBQ3hCLENBQUM7SUFDRCxZQUFZLENBQUMsRUFBRSxXQUFXLEVBQUUsY0FBYyxFQUFFLENBQUMsQ0FBQztJQUM5QyxNQUFNLDZCQUE2QixDQUFDLFdBQVcsQ0FBQyxDQUFDO0lBQ2pELE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbEIsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssT0FBTyxFQUFFLENBQUM7SUFDckQsTUFBTSxRQUFRLEdBQUcsWUFBWSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNoRCxNQUFNLDZCQUE2QixDQUFDLFdBQVcsQ0FBQyxDQUFDO0lBQ2pELE9BQU8sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDekIsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLE9BQU8sRUFBRSxDQUFDO0lBQzNCLE1BQU0sUUFBUSxHQUFHLFdBQVcsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzNELE1BQU0sNkJBQTZCLENBQUMsV0FBVyxDQUFDLENBQUM7SUFDakQsT0FBTyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUN6QixDQUFDO0FBRUQsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssUUFBUSxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxNQUFNLEVBQUUsQ0FBQztJQUNyRCxNQUFNLFFBQVEsR0FBRyxNQUFNLGFBQWEsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDdkQsTUFBTSw2QkFBNkIsQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUNqRCxPQUFPLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBQ3pCLENBQUM7QUFFRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxVQUFVLEVBQUUsQ0FBQztJQUM5QixNQUFNLFFBQVEsR0FBRyxNQUFNLFdBQVcsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDckQsTUFBTSw2QkFBNkIsQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUNqRCxPQUFPLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBQ3pCLENBQUM7QUFFRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxTQUFTLEVBQUUsQ0FBQztJQUM3QixNQUFNLFFBQVEsR0FBRyxNQUFNLFVBQVUsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDcEQsTUFBTSw2QkFBNkIsQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUNqRCxPQUFPLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBQ3pCLENBQUM7QUFFRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxNQUFNLEVBQUUsQ0FBQztJQUMxQixNQUFNLFFBQVEsR0FBRyxNQUFNLE9BQU8sQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDakQsTUFBTSw2QkFBNkIsQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUNqRCxPQUFPLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBQ3pCLENBQUM7QUFFRCxNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsT0FBTyxFQUFFLEVBQUUsV0FBVyxFQUFFLENBQUMsQ0FBQztBQUNsRCxNQUFNLDZCQUE2QixDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBQ2pELE9BQU8sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMifQ==