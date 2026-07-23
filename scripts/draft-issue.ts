#!/usr/bin/env node
// Issue-drafting CLI (#8103, epic #8082) — the FIRST thin consumer of the pure issue-drafting core
// (src/services/issue-drafting.ts): reads the loose prompt, walks the checkout to build the searchable
// corpus, calls the core, and writes the drafted body to a local file for the maintainer to read, edit,
// and only then publish by hand. All grounding/drafting logic lives in the core (unit-tested there); this
// file is the thin IO wrapper — mirrors scripts/export-d1-data.ts's identical role next to
// export-d1-core.ts. NEVER publishes anything, NEVER touches labels/milestones — see the core's own
// boundary comment.
//
//   tsx scripts/draft-issue.ts --prompt "<loose intent>" --output <draft.md> [--root .]
//   tsx scripts/draft-issue.ts --prompt-file <intent.txt> --output <draft.md> [--root .]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { draftIssueBody, type CorpusFile } from "../src/services/issue-drafting.js";

type Args = {
  prompt: string | undefined;
  promptFile: string | undefined;
  output: string | undefined;
  root: string;
};

// The corpus mirrors where real precedent lives (the gate's own wantedPaths, minus content-free dirs).
const CORPUS_DIRS = ["src", "packages", "scripts", "test", "migrations", ".github/workflows"];
const CORPUS_EXTENSIONS = [".ts", ".tsx", ".sql", ".yml", ".yaml", ".jsonc", ".md"];
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "coverage", ".turbo"]);
const MAX_FILE_BYTES = 512 * 1024;

function parseArgs(argv: string[]): Args {
  const args: Args = { prompt: undefined, promptFile: undefined, output: undefined, root: "." };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--prompt") args.prompt = argv[++i];
    else if (flag === "--prompt-file") args.promptFile = argv[++i];
    else if (flag === "--output") args.output = argv[++i];
    else if (flag === "--root") args.root = argv[++i]!;
  }
  return args;
}

function collectCorpus(root: string): CorpusFile[] {
  const corpus: CorpusFile[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // a listed corpus dir may not exist in a partial checkout -- skip, never crash the draft
    }
    for (const entry of entries.sort()) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      const fullPath = join(dir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) walk(fullPath);
      else if (CORPUS_EXTENSIONS.some((extension) => entry.endsWith(extension)) && stats.size <= MAX_FILE_BYTES) {
        corpus.push({ path: relative(root, fullPath), content: readFileSync(fullPath, "utf8") });
      }
    }
  };
  for (const dir of CORPUS_DIRS) walk(join(root, dir));
  return corpus;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompt = args.prompt ?? (args.promptFile ? readFileSync(args.promptFile, "utf8") : undefined);
  if (!prompt || !args.output) {
    console.error("Usage: tsx scripts/draft-issue.ts (--prompt <text> | --prompt-file <file>) --output <draft.md> [--root .]");
    process.exit(2);
  }

  const corpus = collectCorpus(args.root);
  const result = draftIssueBody(prompt, corpus);
  writeFileSync(args.output, result.body);
  console.error(
    `drafted from ${corpus.length} corpus file(s): ${result.groundedTerms.length} term(s) grounded, ` +
      `${result.ungroundedTerms.length} UNGROUNDED marker(s) to resolve by hand → ${args.output}`,
  );
  console.error("review + edit before publishing — this tool never publishes, and labels/milestone stay your call.");
}

main();
