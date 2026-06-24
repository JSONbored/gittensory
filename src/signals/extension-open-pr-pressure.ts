import type { ContributorOpenPrPressureResponse } from "../services/open-pr-pressure-response";
import type { OpenPrPressureSimulation, OpenPrStrategyOption, OpenPrStrategyScenario } from "../services/open-pr-pressure-scenarios";
import { redactExtensionText } from "./extension-contributor-context";

// ─── Extension contributor open-PR pressure (#348 exposure) ───────────────────────────────────
// Public-safe overlay for the open-PR pressure simulator. Reuses the extension redaction helper so
// any free-form scenario text is scrubbed before it reaches a contributor browser session or MCP agent.

export type ExtensionOpenPrStrategyScenario = {
  option: OpenPrStrategyOption;
  label: string;
  rank: number;
  recommended: boolean;
  facts: string[];
  assumptions: string[];
  tradeoffs: string[];
  blockers: string[];
};

export type ExtensionOpenPrPressure = {
  login: string;
  repoFullName: string;
  generatedAt: string;
  contributorOpenPrCount: number;
  queuePressure: OpenPrPressureSimulation["queuePressure"];
  recommendedOption: OpenPrStrategyOption;
  summary: string;
  scenarios: ExtensionOpenPrStrategyScenario[];
};

function redactScenarioStrings(values: string[]): string[] {
  return values.map((value) => redactExtensionText(value));
}

function toExtensionScenario(scenario: OpenPrStrategyScenario): ExtensionOpenPrStrategyScenario {
  return {
    option: scenario.option,
    label: redactExtensionText(scenario.label),
    rank: scenario.rank,
    recommended: scenario.recommended,
    facts: redactScenarioStrings(scenario.facts),
    assumptions: redactScenarioStrings(scenario.assumptions),
    tradeoffs: redactScenarioStrings(scenario.tradeoffs),
    blockers: redactScenarioStrings(scenario.blockers),
  };
}

export function buildExtensionOpenPrPressure(response: ContributorOpenPrPressureResponse): ExtensionOpenPrPressure {
  const { simulation } = response;
  return {
    login: response.login,
    repoFullName: response.repoFullName,
    generatedAt: response.generatedAt,
    contributorOpenPrCount: response.contributorOpenPrCount,
    queuePressure: simulation.queuePressure,
    recommendedOption: simulation.recommendedOption,
    summary: redactExtensionText(simulation.summary),
    scenarios: simulation.scenarios.map(toExtensionScenario),
  };
}

export function extensionOpenPrPressureHeadline(pressure: ExtensionOpenPrPressure): string {
  const option = pressure.scenarios.find((entry) => entry.recommended)?.label ?? pressure.recommendedOption;
  return redactExtensionText(`${pressure.repoFullName}: ${option} (${pressure.queuePressure} queue pressure, ${pressure.contributorOpenPrCount} open PR(s)).`);
}
