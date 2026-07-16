export type ChatActionRequest = {
  action?: string;
  params?: unknown;
  governorInput?: unknown;
};

/** A handler produced by {@link governorGatedHandler}; the only shape {@link ChatActionRegistry.register} accepts. */
export type GovernorGatedHandler = (request: ChatActionRequest) => Promise<Record<string, unknown>>;

export type ChatActionDefinition = {
  paramsValidator: (params: unknown) => boolean;
  handler: GovernorGatedHandler;
};

export type ChatActionEntry = {
  paramsValidator: (params: unknown) => boolean;
  handler: GovernorGatedHandler;
};

export type ChatActionRegistry = {
  register(name: string, definition: ChatActionDefinition): ChatActionEntry;
  get(name: string): ChatActionEntry | undefined;
  has(name: string): boolean;
  names(): string[];
  readonly size: number;
};

export function governorGatedHandler(
  run: (request: ChatActionRequest, gate: unknown) => unknown,
  options?: {
    evaluateGate?: (input: unknown, gateOptions?: unknown) => unknown;
    gateOptions?: unknown;
  },
): GovernorGatedHandler;

export function isGovernorGatedHandler(handler: unknown): boolean;

export function createChatActionRegistry(): ChatActionRegistry;

export const chatActionRegistry: ChatActionRegistry;

export function registerChatAction(name: string, definition: ChatActionDefinition): ChatActionEntry;
