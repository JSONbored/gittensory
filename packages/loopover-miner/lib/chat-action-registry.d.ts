import type { GovernorChokepointInput } from "@loopover/engine";

export type ChatActionParamsValidation = { ok: boolean; errors?: string[] };
export type ChatActionParamsValidator = (
  params: unknown,
) => ChatActionParamsValidation;

// The dispatch layer only reads the gate verdict's `stage`; the full GovernorDecision it echoes back is opaque
// here (`decision: unknown`) so a child issue's handler and a test fake can both satisfy the contract.
export type ChatActionGateResult = { decision: { stage: string } };
export type ChatActionGate = (
  input: GovernorChokepointInput,
) => ChatActionGateResult;

export type ChatActionHandlerResult =
  | { ok: false; denied: true; stage: string; decision: unknown }
  | { ok: true; stage: string; decision: unknown; result: unknown };

export type ChatActionHandler = (request: {
  action: string;
  params: unknown;
}) => Promise<ChatActionHandlerResult>;

export type ChatActionEntry = {
  paramsValidator: ChatActionParamsValidator;
  handler: ChatActionHandler;
};

export type ChatActionBuild = (request: {
  action: string;
  params: unknown;
}) => {
  chokepointInput: GovernorChokepointInput;
  perform: () => unknown | Promise<unknown>;
};

export function createChokepointRoutedHandler(
  build: ChatActionBuild,
  options?: { evaluateGate?: ChatActionGate },
): ChatActionHandler;

export function isChokepointRoutedHandler(handler: unknown): boolean;

export function registerChatAction(
  name: string,
  definition: {
    paramsValidator: ChatActionParamsValidator;
    handler: ChatActionHandler;
  },
): ChatActionEntry;

export function getChatAction(name: string): ChatActionEntry | null;

export function listChatActionNames(): string[];

export function clearChatActionRegistry(): void;
