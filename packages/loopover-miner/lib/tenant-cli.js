/** `tenant` CLI command group (#7275): create / list / destroy hosted tenant instances against the #7173 ORB+AMS
 * hosting control-plane's provisioning API (#7180). Thin composition layer -- argv parsing plus a call into
 * tenant-client.js, which owns the env-gated, Bearer-authed, FAIL-LOUD HTTP surface. Every failure the client
 * throws (disabled/unconfigured plane, unreachable host, non-2xx, malformed body) is reported here as a non-zero
 * exit with the client's own message; there is deliberately no silent-degrade path, because provisioning a tenant
 * is a deliberate admin action whose failure an operator must see. Lifecycle `state` values are printed verbatim
 * from the API -- this layer invents no state vocabulary of its own. */
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { createTenant, destroyTenant, listTenants } from "./tenant-client.js";
const TENANT_USAGE = "Usage: loopover-miner tenant <create|list|destroy> [<name>] [--product <product>] [--json]";
/** Parse `create <name> [--product <p>] [--json]`. Returns `{ name, product, json }` or `{ error }`. */
export function parseTenantCreateArgs(args) {
    let name = null;
    let product = null;
    let json = false;
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            json = true;
            continue;
        }
        if (token === "--product") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: TENANT_USAGE };
            product = value;
            index += 1;
            continue;
        }
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
        if (name !== null)
            return { error: TENANT_USAGE };
        name = token;
    }
    if (name === null)
        return { error: TENANT_USAGE };
    return { name, json, ...(product !== null ? { product } : {}) };
}
/** Parse `<name> [--json]` for the single-positional commands (destroy). Returns `{ name, json }` or `{ error }`. */
export function parseTenantNameArgs(args) {
    let name = null;
    let json = false;
    for (const token of args) {
        if (token === "--json") {
            json = true;
            continue;
        }
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
        if (name !== null)
            return { error: TENANT_USAGE };
        name = token;
    }
    if (name === null)
        return { error: TENANT_USAGE };
    return { name, json };
}
/** Parse `list [--json]` (no positional). Returns `{ json }` or `{ error }`. */
export function parseTenantListArgs(args) {
    let json = false;
    for (const token of args) {
        if (token === "--json") {
            json = true;
            continue;
        }
        return { error: `Unknown option: ${token}` };
    }
    return { json };
}
function renderTenantRecord(record) {
    const name = typeof record.name === "string" ? record.name : "(unknown)";
    const product = typeof record.product === "string" ? record.product : "(unknown)";
    const state = typeof record.state === "string" ? record.state : "(unknown)";
    return `${name}  product=${product}  state=${state}`;
}
export async function runTenantCreate(args, options = {}) {
    const parsed = parseTenantCreateArgs(args);
    if ("error" in parsed)
        return reportCliFailure(argsWantJson(args), parsed.error);
    const create = options.createTenant ?? createTenant;
    try {
        const record = await create(parsed.name, {
            env: options.env,
            fetchImpl: options.fetchImpl,
            ...(parsed.product !== undefined ? { product: parsed.product } : {}),
        });
        if (parsed.json) {
            console.log(JSON.stringify(record, null, 2));
        }
        else {
            console.log(`created ${renderTenantRecord(record)}`);
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export async function runTenantList(args, options = {}) {
    const parsed = parseTenantListArgs(args);
    if ("error" in parsed)
        return reportCliFailure(argsWantJson(args), parsed.error);
    const list = options.listTenants ?? listTenants;
    try {
        const records = await list({ env: options.env, fetchImpl: options.fetchImpl });
        if (parsed.json) {
            console.log(JSON.stringify(records, null, 2));
        }
        else if (records.length === 0) {
            console.log("no tenants");
        }
        else {
            console.log(records.map(renderTenantRecord).join("\n"));
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export async function runTenantDestroy(args, options = {}) {
    const parsed = parseTenantNameArgs(args);
    if ("error" in parsed)
        return reportCliFailure(argsWantJson(args), parsed.error);
    const destroy = options.destroyTenant ?? destroyTenant;
    try {
        const record = await destroy(parsed.name, { env: options.env, fetchImpl: options.fetchImpl });
        if (parsed.json) {
            console.log(JSON.stringify(record, null, 2));
        }
        else {
            console.log(`destroyed ${renderTenantRecord(record)}`);
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export async function runTenantCli(subcommand, args, options = {}) {
    if (subcommand === "create")
        return runTenantCreate(args, options);
    if (subcommand === "list")
        return runTenantList(args, options);
    if (subcommand === "destroy")
        return runTenantDestroy(args, options);
    return reportCliFailure(argsWantJson(args), TENANT_USAGE);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVuYW50LWNsaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRlbmFudC1jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozt3RUFNd0U7QUFDeEUsT0FBTyxFQUFFLFlBQVksRUFBRSxnQkFBZ0IsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQ2xGLE9BQU8sRUFBRSxZQUFZLEVBQUUsYUFBYSxFQUFFLFdBQVcsRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBRzlFLE1BQU0sWUFBWSxHQUFHLDRGQUE0RixDQUFDO0FBbUJsSCx3R0FBd0c7QUFDeEcsTUFBTSxVQUFVLHFCQUFxQixDQUFDLElBQWM7SUFDbEQsSUFBSSxJQUFJLEdBQWtCLElBQUksQ0FBQztJQUMvQixJQUFJLE9BQU8sR0FBa0IsSUFBSSxDQUFDO0lBQ2xDLElBQUksSUFBSSxHQUFHLEtBQUssQ0FBQztJQUNqQixLQUFLLElBQUksS0FBSyxHQUFHLENBQUMsRUFBRSxLQUFLLEdBQUcsSUFBSSxDQUFDLE1BQU0sRUFBRSxLQUFLLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDcEQsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBRSxDQUFDO1FBQzNCLElBQUksS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3ZCLElBQUksR0FBRyxJQUFJLENBQUM7WUFDWixTQUFTO1FBQ1gsQ0FBQztRQUNELElBQUksS0FBSyxLQUFLLFdBQVcsRUFBRSxDQUFDO1lBQzFCLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUM7WUFDOUIsSUFBSSxDQUFDLEtBQUssSUFBSSxLQUFLLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQztnQkFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLFlBQVksRUFBRSxDQUFDO1lBQ3BFLE9BQU8sR0FBRyxLQUFLLENBQUM7WUFDaEIsS0FBSyxJQUFJLENBQUMsQ0FBQztZQUNYLFNBQVM7UUFDWCxD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