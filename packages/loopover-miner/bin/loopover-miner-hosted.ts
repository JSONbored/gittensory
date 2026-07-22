#!/usr/bin/env node
// Thin dispatcher for the hosted-container entry point (#7182) -- all real logic lives in
// lib/hosted-entry.ts (importable/testable in-process); this file only wires argv/exit code, mirroring
// bin/loopover-miner.ts's own top-level shape.
import { runHostedEntry } from "../lib/hosted-entry.js";

process.exitCode = await runHostedEntry(process.argv.slice(2));
