import { createInterface } from "node:readline";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODING_AGENT_DRIVER_CONFIG_ENV, CODING_AGENT_DRIVER_NAMES } from "@loopover/engine";
import { initLaptopState } from "./laptop-init.js";
import { resolveMinerStateDir, runDoctor } from "./status.js";
import { DeviceFlowError, resolveAmsOauthClientId, runDeviceFlowAuthorization } from "./oauth-device-flow.js";
const COMPANION_VAR_LABELS = { model: "model override", timeoutMs: "timeout in milliseconds" };
/** Where the wizard writes its starter .env file: the miner state dir, the same directory `init` already uses
 *  for laptop-state.sqlite3. */
export function resolveWizardEnvFilePath(env = process.env) {
    return join(resolveMinerStateDir(env), ".env");
}
/** Render collected `[KEY, value]` pairs as sourceable `KEY=value` lines, one per entry, insertion order. Pure
 *  and filesystem-free so it is directly testable. */
export function renderWizardEnvFile(entries) {
    if (entries.length === 0)
        return "";
    return `${entries.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}
async function promptRequiredMasked(io, question) {
    for (;;) {
        const answer = (await io.promptMasked(question)).trim();
        if (answer)
            return answer;
        io.writeLine("A value is required -- please try again.");
    }
}
async function promptAuthMethod(io) {
    io.writeLine("How would you like to authorize loopover-miner?");
    io.writeLine("  1) Authorize with GitHub (recommended -- no token to copy)");
    io.writeLine("  2) Paste a GitHub token (personal access token)");
    for (;;) {
        const answer = (await io.promptText("Choice [1/2, default 1]: ")).trim();
        if (!answer || answer === "1")
            return "device";
        if (answer === "2")
            return "token";
        io.writeLine("Enter 1 or 2.");
    }
}
/**
 * Collect a GitHub credential for the wizard's starter .env. When LOOPOVER_MINER_AMS_OAUTH_CLIENT_ID isn't
 * configured (today's default, before the loopover-ams App is registered), this is IDENTICAL to the original
 * masked-token-only prompt -- no menu, no behavior change. Once configured, offers device-flow authorization as
 * the default choice, with the original pasted-token path still available (option 2) and as the automatic
 * fallback on any device-flow failure -- never a hard dependency.
 */
async function collectGithubToken(io, env, options) {
    const clientId = resolveAmsOauthClientId(env);
    if (!clientId)
        return promptRequiredMasked(io, "GitHub token (input hidden): ");
    const method = await promptAuthMethod(io);
    if (method === "token")
        return promptRequiredMasked(io, "GitHub token (input hidden): ");
    try {
        const { accessToken } = await runDeviceFlowAuthorization({
            clientId,
            fetchFn: options.fetchImpl,
            sleepFn: options.sleepFn,
            onCode: (code) => {
                io.writeLine("");
                io.writeLine(`To authorize, visit ${code.verificationUri} and enter code: ${code.userCode}`);
                io.writeLine("Waiting for authorization...");
            },
        });
        io.writeLine("Authorized.");
        return accessToken;
    }
    catch (error) {
        const reason = error instanceof DeviceFlowError ? error.code : "device_flow_failed";
        io.writeLine(`Device-flow authorization failed (${reason}) -- falling back to a pasted token.`);
        return promptRequiredMasked(io, "GitHub token (input hidden): ");
    }
}
/**
 * Menu selection sourced from the engine's own `CODING_AGENT_DRIVER_NAMES`, so the choices can never drift from
 * what the driver factory actually resolves. Empty input SKIPS provider selection entirely (leaves
 * MINER_CODING_AGENT_PROVIDER unwritten, deferring to whatever default the CLI already resolves) -- distinct
 * from explicitly choosing the `noop` entry.
 */
export async function promptProviderSelection(io) {
    io.writeLine("Select a coding-agent provider (press Enter to skip and use the default):");
    CODING_AGENT_DRIVER_NAMES.forEach((name, index) => {
        io.writeLine(`  ${index + 1}) ${name}`);
    });
    for (;;) {
        const answer = (await io.promptText(`Provider [1-${CODING_AGENT_DRIVER_NAMES.length}, or Enter to skip]: `)).trim();
        if (!answer)
            return null;
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && index >= 0 && index < CODING_AGENT_DRIVER_NAMES.length) {
            return CODING_AGENT_DRIVER_NAMES[index];
        }
        io.writeLine(`Enter a number from 1 to ${CODING_AGENT_DRIVER_NAMES.length}, or press Enter to skip.`);
    }
}
/**
 * Optional, skippable per-provider companion vars (model override / timeout), sourced from the same
 * `CODING_AGENT_DRIVER_CONFIG_ENV` map the real driver factory reads -- never a hand-duplicated var-name list
 * that could drift. Empty input skips that one var; its built-in default (if any) applies at run time as usual.
 */
export async function promptCompanionVars(io, provider) {
    const varsForProvider = CODING_AGENT_DRIVER_CONFIG_ENV[provider] ?? {};
    const collected = [];
    for (const [kind, envVarName] of Object.entries(varsForProvider)) {
        const label = COMPANION_VAR_LABELS[kind];
        const answer = (await io.promptText(`Optional ${label} for ${provider} (env ${envVarName}) [Enter to skip]: `)).trim();
        if (answer)
            collected.push([envVarName, answer]);
    }
    return collected;
}
/**
 * Run the interactive onboarding wizard end to end: collect GITHUB_TOKEN (pasted, or via device-flow
 * authorization when configured -- see collectGithubToken) + optional provider config, write the starter .env,
 * initialize laptop state, then rerun the existing offline doctor checks against the collected values. Returns
 * doctor's exit code. `io` is injected so tests never touch a real terminal; `options.fetchImpl`/`sleepFn` are
 * injected so tests never make a real network call or wait on a real timer during device-flow polling.
 */
export async function runInteractiveInit(env, cwd, io, options = {}) {
    // #6846: fail fast, not silently forever. `io.isInteractive` is only ever `false` for a real
    // `createWizardIo()` adapter over a non-TTY stdin (a test's fake `io` has no such field and stays
    // interactive by default, so every existing test is unaffected) -- an operator running this over a
    // no-pty SSH session or a CI/fleet script gets clear, actionable guidance instead of a hang on the
    // wizard's first prompt, which can never receive a real line of input.
    if (io.isInteractive === false) {
        io.writeLine("init --interactive requires a real terminal (no TTY detected on stdin).");
        io.writeLine("For an unattended/fleet setup, skip this wizard and set these env vars directly instead:");
        io.writeLine("  - GITHUB_TOKEN (your GitHub credential)");
        io.writeLine("  - MINER_CODING_AGENT_PROVIDER (claude-cli or codex-cli)");
        io.writeLine("  - ANTHROPIC_API_KEY for claude-cli, or OPENAI_API_KEY for codex-cli");
        io.writeLine("Then verify with: loopover-miner doctor");
        return 3;
    }
    const githubToken = await collectGithubToken(io, env, options);
    const provider = await promptProviderSelection(io);
    const entries = [["GITHUB_TOKEN", githubToken]];
    if (provider) {
        entries.push(["MINER_CODING_AGENT_PROVIDER", provider]);
        entries.push(...(await promptCompanionVars(io, provider)));
    }
    const stateDir = resolveMinerStateDir(env);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const envFilePath = resolveWizardEnvFilePath(env);
    // { mode: 0o600 } on writeFileSync applies only when the file is newly created -- an existing file (e.g. from
    // a prior wizard run, or hand-created by the operator with looser permissions) keeps its current mode across
    // a write. The chmodSync below still runs unconditionally so the end state is always 0600 either way; the
    // writeFileSync mode option exists so a BRAND NEW file is never briefly readable at the default umask
    // permissions between being created and being locked down.
    writeFileSync(envFilePath, renderWizardEnvFile(entries), { mode: 0o600 });
    chmodSync(envFilePath, 0o600);
    io.writeLine(`wrote ${envFilePath}`);
    const initResult = initLaptopState(env);
    io.writeLine(`initialized ${initResult.stateDir}`);
    io.writeLine(`sqlite: ${initResult.dbPath}${initResult.created ? "" : " (already existed)"}`);
    const mergedEnv = { ...env };
    for (const [key, value] of entries)
        mergedEnv[key] = value;
    io.writeLine("");
    io.writeLine("Running doctor against the new configuration:");
    return runDoctor([], mergedEnv, cwd);
}
/**
 * Real terminal I/O for the wizard. Masked input is implemented by overriding readline's own output-write hook
 * to render `*` instead of the typed prompt's characters while the interface is still doing its normal
 * cooked-mode line editing (Enter/Backspace all still work exactly as with a plain prompt) -- no raw-mode byte
 * handling and no extra dependency. `input`/`output` are parameters (defaulting to the real stdio) purely so
 * tests can drive the exact same code path with fake streams instead of a real terminal.
 */
export function createWizardIo(input = process.stdin, output = process.stdout) {
    const rl = createInterface({ input, output, terminal: true });
    // `_writeToOutput` is readline's own undocumented internal hook (not part of Node's public Interface type),
    // the standard technique for masking input while keeping normal cooked-mode line editing.
    const rlInternal = rl;
    const originalWriteToOutput = rlInternal._writeToOutput.bind(rl);
    let masking = false;
    rlInternal._writeToOutput = (stringToWrite) => {
        originalWriteToOutput(masking ? "*" : stringToWrite);
    };
    return {
        // #6846: whether `input` is a real, interactive terminal -- `runInteractiveInit` checks this BEFORE
        // issuing its first prompt, so a no-TTY invocation (piped stdin, a plain `ssh host "loopover-miner init
        // --interactive"` with no allocated pty) fails fast with actionable guidance instead of hanging forever
        // on a `readline` prompt that can never receive a real line of input.
        isInteractive: Boolean(input.isTTY),
        promptText(question) {
            return new Promise((resolve) => rl.question(question, resolve));
        },
        promptMasked(question) {
            return new Promise((resolve) => {
                rl.question(question, (answer) => {
                    masking = false;
                    resolve(answer);
                });
                masking = true;
            });
        },
        writeLine(text) {
            output.write(`${text}\n`);
        },
        close() {
            rl.close();
        },
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5pdC13aXphcmQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbml0LXdpemFyZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sZUFBZSxDQUFDO0FBQ2hELE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxFQUFFLGFBQWEsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUM5RCxPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQ2pDLE9BQU8sRUFBRSw4QkFBOEIsRUFBRSx5QkFBeUIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQzdGLE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUNuRCxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsU0FBUyxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBQzlELE9BQU8sRUFBRSxlQUFlLEVBQUUsdUJBQXVCLEVBQUUsMEJBQTBCLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQWdDOUcsTUFBTSxvQkFBb0IsR0FBMkIsRUFBRSxLQUFLLEVBQUUsZ0JBQWdCLEVBQUUsU0FBUyxFQUFFLHlCQUF5QixFQUFFLENBQUM7QUFFdkg7Z0NBQ2dDO0FBQ2hDLE1BQU0sVUFBVSx3QkFBd0IsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUM1RixPQUFPLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxHQUFHLENBQUMsRUFBRSxNQUFNLENBQUMsQ0FBQztBQUNqRCxDQUFDO0FBRUQ7c0RBQ3NEO0FBQ3RELE1BQU0sVUFBVSxtQkFBbUIsQ0FBQyxPQUFpRDtJQUNuRixJQUFJLE9BQU8sQ0FBQyxNQUFNLEtBQUssQ0FBQztRQUFFLE9BQU8sRUFBRSxDQUFDO0lBQ3BDLE9BQU8sR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLEVBQUUsRUFBRSxDQUFDLEdBQUcsR0FBRyxJQUFJLEtBQUssRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUM7QUFDNUUsQ0FBQztBQUVELEtBQUssVUFBVSxvQkFBb0IsQ0FBQyxFQUFZLEVBQUUsUUFBZ0I7SUFDaEUsU0FBUyxDQUFDO1FBQ1IsTUFBTSxNQUFNLEdBQUcsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxZQUFZLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUN4RCxJQUFJLE1BQU07WUFBRSxPQUFPLE1BQU0sQ0FBQztRQUMxQixFQUFFLENBQUMsU0FBUyxDQUFDLDBDQUEwQyxDQUFDLENBQUM7SUFDM0QsQ0FBQztBQUNILENBQUM7QUFFRCxLQUFLLFVBQVUsZ0JBQWdCLENBQUMsRUFBWTtJQUMxQyxFQUFFLENBQUMsU0FBUyxDQUFDLGlEQUFpRCxDQUFDLENBQUM7SUFDaEUsRUFBRSxDQUFDLFNBQVMsQ0FBQyw4REFBOEQsQ0FBQyxDQUFDO0lBQzdFLEVBQUUsQ0FBQyxTQUFTLENBQUMsbURBQW1ELENBQUMsQ0FBQztJQUNsRSxTQUFTLENBQUM7UUFDUixNQUFNLE1BQU0sR0FBRyxDQUFDLE1BQU0sRUFBRSxDQUFDLFVBQVUsQ0FBQywyQkFBMkIsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDekUsSUFBSSxDQUFDLE1BQU0sSUFBSSxNQUFNLEtBQUssR0FBRztZQUFFLE9BQU8sUUFBUSxDQUFDO1FBQy9DLElBQUksTUFBTSxLQUFLLEdBQUc7WUFBRSxPQUFPLE9BQU8sQ0FBQztRQUNuQyxFQUFFLENBQUMsU0FBUyxDQUFDLGVBQWUsQ0FBQyxDQUFDO0lBQ2hDLENBQUM7QUFDSCxDQUFDO0FBRUQ7Ozs7OztHQU1HO0FBQ0gsS0FBSyxVQUFVLGtCQUFrQixDQUFDLEVBQVksRUFBRSxHQUF1QyxFQUFFLE9BQWtDO0lBQ3pILE1BQU0sUUFBUSxHQUFHLHVCQUF1QixDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQzlDLElBQUksQ0FBQyxRQUFRO1FBQUUsT0FBTyxvQkFBb0IsQ0FBQyxFQUFFLEVBQUUsK0JBQStCLENBQUMsQ0FBQztJQUVoRixNQUFNLE1BQU0sR0FBRyxNQUFNLGdCQUFnQixDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQzFDLElBQUksTUFBTSxLQUFLLE9BQU87UUFBRSxPQUFPLG9CQUFvQixDQUFDLEVBQUUsRUFBRSwrQkFBK0IsQ0FBQyxDQUFDO0lBRXpGLElBQUksQ0FBQztRQUNILE1BQU0sRUFBRSxXQUFXLEVBQUUsR0FBRyxNQUFNLDBCQUEwQixDQUFDO1lBQ3ZELFFBQVE7WUFDUixPQUFPLEVBQUUsT0FBTyxDQUFDLFNBQVM7WUFDMUIsT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPO1lBQ3hCLE1BQU0sRUFBRSxDQUFDLElBQUksRUFBRSxFQUFFO2dCQUNmLEVBQUUsQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDLENBQUM7Z0JBQ2pCLEVBQUUsQ0FBQyxTQUFTLENBQUMsdUJBQXVCLElBQUksQ0FBQyxlQUFlLG9CQUFvQixJQUFJLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztnQkFDN0YsRUFBRSxDQUFDLFNBQVMsQ0FBQyw4QkFBOEIsQ0FBQyxDQUFDO1lBQy9DLENBQUM7U0FDa0QsQ0FBQyxDQUFDO1FBQ3ZELEVBQUUsQ0FBQyxTQUFTLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDNUIsT0FBTyxXQUFXLENBQUM7SUFDckIsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixNQUFNLE1BQU0sR0FBRyxLQUFLLFlBQVksZUFBZSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxvQkFBb0IsQ0FBQztRQUNwRixFQUFFLENBQUMsU0FBUyxDQUFDLHFDQUFxQyxNQUFNLHNDQUFzQyxDQUFDLENBQUM7UUFDaEcsT0FBTyxvQkFBb0IsQ0FBQyxFQUFFLEVBQUUsK0JBQStCLENBQUMsQ0FBQztJQUNuRSxDQUFDO0FBQ0gsQ0FBQztBQUVEOzs7OztHQUtHO0FBQ0gsTUFBTSxDQUFDLEtBQUssVUFBVSx1QkFBdUIsQ0FBQyxFQUFZO0lBQ3hELEVBQUUsQ0FBQyxTQUFTLENBQUMsMkVBQTJFLENBQUMsQ0FBQztJQUMxRix5QkFBeUIsQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUU7UUFDaEQsRUFBRSxDQUFDLFNBQVMsQ0FBQyxLQUFLLEtBQUssR0FBRyxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUMsQ0FBQztJQUMxQyxDQUFDLENBQUMsQ0FBQztJQUNILFNBQVMsQ0FBQztRQUNSLE1BQU0sTUFBTSxHQUFHLENBQUMsTUFBTSxFQUFFLENBQUMsVUFBVSxDQUFDLGVBQWUseUJBQXlCLENBQUMsTUFBTSx1QkFBdUIsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDcEgsSUFBSSxDQUFDLE1BQU07WUFBRSxPQUFPLElBQUksQ0FBQztRQUN6QixNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ2pDLElBQUksTUFBTSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsSUFBSSxLQUFLLElBQUksQ0FBQyxJQUFJLEtBQUssR0FBRyx5QkFBeUIsQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUN0RixPQUFPLHlCQUF5QixDQUFDLEtBQUssQ0FBRSxDQUFDO1FBQzNDLENBQUM7UUFDRCxFQUFFLENBQUMsU0FBUyxDQUFDLDRCQUE0Qix5QkFBeUIsQ0FBQyxNQUFNLDJCQUEyQixDQUFDLENBQUM7SUFDeEcsQ0FBQztBQUNILENBQUM7QUFFRDs7OztHQUlHO0FBQ0gsTUFBTSxDQUFDLEtBQUssVUFBVSxtQkFBbUIsQ0FBQyxFQUFZLEVBQUUsUUFBZ0I7SUFDdEUsTUFBTSxlQUFlLEdBQTRCLDhCQUF5RSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUMzSSxNQUFNLFNBQVMsR0FBNEIsRUFBRSxDQUFDO0lBQzlDLEtBQUssTUFBTSxDQUFDLElBQUksRUFBRSxVQUFVLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLGVBQWUsQ0FBQyxFQUFFLENBQUM7UUFDakUsTUFBTSxLQUFLLEdBQUcsb0JBQW9CLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDekMsTUFBTSxNQUFNLEdBQUcsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxVQUFVLENBQUMsWUFBWSxLQUFLLFFBQVEsUUFBUSxTQUFTLFVBQVUscUJBQXFCLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ3ZILElBQUksTUFBTTtZQUFFLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxVQUFVLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQztJQUNuRCxDQUFDO0lBQ0QsT0FBTyxTQUFTLENBQUM7QUFDbkIsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILE1BQU0sQ0FBQyxLQUFLLFVBQVUsa0JBQWtCLENBQ3RDLEdBQXVDLEVBQ3ZDLEdBQVcsRUFDWCxFQUFZLEVBQ1osVUFBcUMsRUFBRTtJQUV2Qyw2RkFBNkY7SUFDN0Ysa0dBQWtHO0lBQ2xHLG1HQUFtRztJQUNuRyxtR0FBbUc7SUFDbkcsdUVBQXVFO0lBQ3ZFLElBQUksRUFBRSxDQUFDLGFBQWEsS0FBSyxLQUFLLEVBQUUsQ0FBQztRQUMvQixFQUFFLENBQUMsU0FBUyxDQUFDLHlFQUF5RSxDQUFDLENBQUM7UUFDeEYsRUFBRSxDQUFDLFNBQVMsQ0FBQywwRkFBMEYsQ0FBQyxDQUFDO1FBQ3pHLEVBQUUsQ0FBQyxTQUFTLENBQUMsMkNBQTJDLENBQUMsQ0FBQztRQUMxRCxFQUFFLENBQUMsU0FBUyxDQUFDLDJEQUEyRCxDQUFDLENBQUM7UUFDMUUsRUFBRSxDQUFDLFNBQVMsQ0FBQyx1RUFBdUUsQ0FBQyxDQUFDO1FBQ3RGLEVBQUUsQ0FBQyxTQUFTLENBQUMseUNBQXlDLENBQUMsQ0FBQztRQUN4RCxPQUFPLENBQUMsQ0FBQztJQUNYLENBQUM7SUFDRCxNQUFNLFdBQVcsR0FBRyxNQUFNLGtCQUFrQixDQUFDLEVBQUUsRUFBRSxHQUFHLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDL0QsTUFBTSxRQUFRLEdBQUcsTUFBTSx1QkFBdUIsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUVuRCxNQUFNLE9BQU8sR0FBNEIsQ0FBQyxDQUFDLGNBQWMsRUFBRSxXQUFXLENBQUMsQ0FBQyxDQUFDO0lBQ3pFLElBQUksUUFBUSxFQUFFLENBQUM7UUFDYixPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsNkJBQTZCLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztRQUN4RCxPQUFPLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLG1CQUFtQixDQUFDLEVBQUUsRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDN0QsQ0FBQztJQUVELE1BQU0sUUFBUSxHQUFHLG9CQUFvQixDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQzNDLFNBQVMsQ0FBQyxRQUFRLEVBQUUsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQ3RELE1BQU0sV0FBVyxHQUFHLHdCQUF3QixDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ2xELDhHQUE4RztJQUM5Ryw2R0FBNkc7SUFDN0csMEdBQTBHO0lBQzFHLHNHQUFzRztJQUN0RywyREFBMkQ7SUFDM0QsYUFBYSxDQUFDLFdBQVcsRUFBRSxtQkFBbUIsQ0FBQyxPQUFPLENBQUMsRUFBRSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQzFFLFNBQVMsQ0FBQyxXQUFXLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDOUIsRUFBRSxDQUFDLFNBQVMsQ0FBQyxTQUFTLFdBQVcsRUFBRSxDQUFDLENBQUM7SUFFckMsTUFBTSxVQUFVLEdBQUcsZUFBZSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3hDLEVBQUUsQ0FBQyxTQUFTLENBQUMsZUFBZSxVQUFVLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztJQUNuRCxFQUFFLENBQUMsU0FBUyxDQUFDLFdBQVcsVUFBVSxDQUFDLE1BQU0sR0FBRyxVQUFVLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLG9CQUFvQixFQUFFLENBQUMsQ0FBQztJQUU5RixNQUFNLFNBQVMsR0FBdUMsRUFBRSxHQUFHLEdBQUcsRUFBRSxDQUFDO0lBQ2pFLEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsSUFBSSxPQUFPO1FBQUUsU0FBUyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEtBQUssQ0FBQztJQUUzRCxFQUFFLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ2pCLEVBQUUsQ0FBQyxTQUFTLENBQUMsK0NBQStDLENBQUMsQ0FBQztJQUM5RCxPQUFPLFNBQVMsQ0FBQyxFQUFFLEVBQUUsU0FBUyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQ3ZDLENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxNQUFNLFVBQVUsY0FBYyxDQUM1QixRQUErQixPQUFPLENBQUMsS0FBSyxFQUM1QyxTQUFnQyxPQUFPLENBQUMsTUFBTTtJQUU5QyxNQUFNLEVBQUUsR0FBRyxlQUFlLENBQUMsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQzlELDRHQUE0RztJQUM1RywwRkFBMEY7SUFDMUYsTUFBTSxVQUFVLEdBQUcsRUFBd0QsQ0FBQztJQUM1RSxNQUFNLHFCQUFxQixHQUFHLFVBQVUsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ2pFLElBQUksT0FBTyxHQUFHLEtBQUssQ0FBQztJQUNwQixVQUFVLENBQUMsY0FBYyxHQUFHLENBQUMsYUFBcUIsRUFBRSxFQUFFO1FBQ3BELHFCQUFxQixDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQztJQUN2RCxDQUFDLENBQUM7SUFDRixPQUFPO1FBQ0wsb0dBQW9HO1FBQ3BHLHdHQUF3RztRQUN4Ryx3R0FBd0c7UUFDeEcsc0VBQXNFO1FBQ3RFLGFBQWEsRUFBRSxPQUFPLENBQUUsS0FBMkIsQ0FBQyxLQUFLLENBQUM7UUFDMUQsVUFBVSxDQUFDLFFBQWdCO1lBQ3pCLE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUM7UUFDbEUsQ0FBQztRQUNELFlBQVksQ0FBQyxRQUFnQjtZQUMzQixPQUFPLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLEVBQUU7Z0JBQzdCLEVBQUUsQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFLENBQUMsTUFBTSxFQUFFLEVBQUU7b0JBQy9CLE9BQU8sR0FBRyxLQUFLLENBQUM7b0JBQ2hCLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQztnQkFDbEIsQ0FBQyxDQUFDLENBQUM7Z0JBQ0gsT0FBTyxHQUFHLElBQUksQ0FBQztZQUNqQixDQUFDLENBQUMsQ0FBQztRQUNMLENBQUM7UUFDRCxTQUFTLENBQUMsSUFBWTtZQUNwQixNQUFNLENBQUMsS0FBSyxDQUFDLEdBQUcsSUFBSSxJQUFJLENBQUMsQ0FBQztRQUM1QixDQUFDO1FBQ0QsS0FBSztZQUNILEVBQUUsQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUNiLENBQUM7S0FDRixDQUFDO0FBQ0osQ0FBQyJ9