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
    ].join("\n"),
  );
}

export function runCli(cliArgs, input) {
  const command = cliArgs[0] ?? "";
  console.error(`Unknown command: ${command}. Run ${input.packageName} --help.`);
  return 1;
}
