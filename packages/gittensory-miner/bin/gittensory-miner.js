#!/usr/bin/env node
import { printHelp, printVersion, runCli } from "../lib/cli.js";

const cliArgs = process.argv.slice(2);
const packageName = "@jsonbored/gittensory-miner";
const packageVersion = "0.1.0";

if (cliArgs.length === 0 || cliArgs.includes("--help") || cliArgs.includes("-h") || cliArgs[0] === "help") {
  printHelp({ packageName });
  process.exit(0);
}

if (cliArgs.includes("--version") || cliArgs.includes("-v") || cliArgs[0] === "version") {
  printVersion({ packageName, packageVersion });
  process.exit(0);
}

const exitCode = runCli(cliArgs, { packageName });
process.exit(exitCode);
