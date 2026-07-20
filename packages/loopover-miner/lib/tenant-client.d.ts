/** Admin client for the hosted control-plane's tenant-provisioning API (#7275, part of the #7173 ORB+AMS hosting
 * control-plane; talks to #7180's provisioning API). Opt-in and completely inert unless
 * LOOPOVER_MINER_CONTROL_PLANE is set AND a URL is configured -- mirroring discovery-index-client.js's env-gated,
 * never-auto-enabled posture. But UNLIKE that client's deliberately fail-OPEN opportunistic supplement, every
 * call here FAILS LOUD: create/list/destroy are deliberate admin actions, so a disabled/unconfigured/unreachable/
 * non-2xx/malformed-response condition throws a clear Error (surfaced by tenant-cli.js as a non-zero exit and
 * message) rather than silently degrading. Bearer-authed with an ADMIN credential, distinct from any tenant's own
 * per-instance secrets. Lifecycle states (`provisioning`/`active`/`suspended`/`torn down`) are passed through
 * exactly as the API reports them -- no AMS-specific state vocabulary is invented here. A single bounded request
 * per call (no retry): a create is not idempotent, so it must not be silently re-sent. */
export declare const CONTROL_PLANE_FLAG = "LOOPOVER_MINER_CONTROL_PLANE";
export declare const CONTROL_PLANE_URL_FLAG = "LOOPOVER_MINER_CONTROL_PLANE_URL";
export declare const CONTROL_PLANE_ADMIN_TOKEN_FLAG = "LOOPOVER_MINER_CONTROL_PLANE_ADMIN_TOKEN";
export type TenantClientOptions = {
    env?: Record<string, string | undefined>;
    /** Always called as `fetchImpl(url, init)` with a plain string URL -- narrower than `typeof fetch` on
     *  purpose, since that's the only shape this module ever actually calls it with. */
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    requestTimeoutMs?: number;
};
export type CreateTenantOptions = TenantClientOptions & {
    product?: string;
};
/** A tenant record as reported by the control plane. Lifecycle `state` is passed through verbatim (the API owns
 *  the vocabulary, e.g. `provisioning` / `active` / `suspended` / `torn down`); other fields vary by product. */
export type TenantRecord = Record<string, unknown>;
/** Master opt-in (default off): no control-plane traffic is possible until this is truthy. */
export declare function isControlPlaneEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * Create a hosted tenant instance. Returns the created tenant record exactly as the control plane reports it
 * (including its lifecycle `state`). `options.product` defaults to `"ams"`.
 *
 * @param {string} name
 * @param {{ product?: string, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, requestTimeoutMs?: number }} [options]
 */
export declare function createTenant(name: string, options?: CreateTenantOptions): Promise<TenantRecord>;
/**
 * List all hosted tenant instances the admin credential can see. Returns the `tenants` array as reported.
 *
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, requestTimeoutMs?: number }} [options]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export declare function listTenants(options?: TenantClientOptions): Promise<TenantRecord[]>;
/**
 * Tear down a hosted tenant instance by name. Returns the control plane's final record for it (typically the
 * transitional `torn down` lifecycle state).
 *
 * @param {string} name
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, requestTimeoutMs?: number }} [options]
 */
export declare function destroyTenant(name: string, options?: TenantClientOptions): Promise<TenantRecord>;
