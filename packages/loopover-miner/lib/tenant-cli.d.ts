import { createTenant, destroyTenant, listTenants } from "./tenant-client.js";
export type ParsedTenantCreateArgs = {
    name: string;
    json: boolean;
    product?: string;
} | {
    error: string;
};
export type ParsedTenantNameArgs = {
    name: string;
    json: boolean;
} | {
    error: string;
};
export type ParsedTenantListArgs = {
    json: boolean;
} | {
    error: string;
};
export type RunTenantOptions = {
    /** Read for the control-plane opt-in gate -- defaults to `process.env` inside the client. */
    env?: Record<string, string | undefined>;
    /** Injected fetch, forwarded to the client; defaults to the real global fetch. */
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    /** Injectable client functions so tests drive the CLI without a real control plane. */
    createTenant?: typeof createTenant;
    listTenants?: typeof listTenants;
    destroyTenant?: typeof destroyTenant;
};
/** Parse `create <name> [--product <p>] [--json]`. Returns `{ name, product, json }` or `{ error }`. */
export declare function parseTenantCreateArgs(args: string[]): ParsedTenantCreateArgs;
/** Parse `<name> [--json]` for the single-positional commands (destroy). Returns `{ name, json }` or `{ error }`. */
export declare function parseTenantNameArgs(args: string[]): ParsedTenantNameArgs;
/** Parse `list [--json]` (no positional). Returns `{ json }` or `{ error }`. */
export declare function parseTenantListArgs(args: string[]): ParsedTenantListArgs;
export declare function runTenantCreate(args: string[], options?: RunTenantOptions): Promise<number>;
export declare function runTenantList(args: string[], options?: RunTenantOptions): Promise<number>;
export declare function runTenantDestroy(args: string[], options?: RunTenantOptions): Promise<number>;
export declare function runTenantCli(subcommand: string | undefined, args: string[], options?: RunTenantOptions): Promise<number>;
