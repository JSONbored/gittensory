import { formatLaptopDoctor, initLaptopMode, inspectLaptopMode } from "./laptop-mode.js";

export function printVersion(input) {
  console.log(`${input.packageName}/${input.packageVersion} (node ${process.version})`);
}

export function printHelp(input) {
  console.log(
    [
      input.packageName,
      "",
      "Foundation CLI for the local Gittensory miner runtime.",
      "",
      "Usage:",
      "  gittensory-miner --help",
      "  gittensory-miner --version",
      "  gittensory-miner help",
      "  gittensory-miner version",
      "  gittensory-miner init",
      "  gittensory-miner doctor",
      "  gittensory-miner hooks check --tool <name> --input <json> [--json]",
      "  gittensory-miner state get <owner/repo> [--json]",
      "  gittensory-miner state set <owner/repo> <idle|discovering|planning|preparing> [--json]",
      "",
      "Options:",
      "  --no-update-check  Skip the npm registry version nudge (also GITTENSORY_MINER_NO_UPDATE_CHECK=1)",
    ].join("\n"),
  );
}

export function runCli(cliArgs, input) {
  const command = cliArgs[0] ?? "";
  const commandArgs = cliArgs.slice(1).filter((arg) => arg !== "--no-update-check");
  if (command === "init") return runInit(commandArgs);
  if (command === "doctor") return runDoctor(commandArgs);
  console.error(`Unknown command: ${command}. Run ${input.packageName} --help.`);
  return 1;
}

function runInit(commandArgs) {
  if (commandArgs.length > 0) {
    console.error("Usage: gittensory-miner init");
    return 1;
  }
  const result = initLaptopMode();
  console.log("Gittensory miner laptop mode is ready.");
  console.log(`Config dir: ${result.configDir}`);
  console.log(`State DB: ${result.stateDbPath}`);
  return 0;
}

function runDoctor(commandArgs) {
  if (commandArgs.length > 0) {
    console.error("Usage: gittensory-miner doctor");
    return 1;
  }
  console.log(formatLaptopDoctor(inspectLaptopMode()));
  return 0;
}
