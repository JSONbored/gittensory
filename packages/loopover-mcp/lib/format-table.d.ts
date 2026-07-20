export type FormatTableAlign = "left" | "right";
export type FormatTableHeader = string | {
    key: string;
    label?: string;
    align?: FormatTableAlign;
};
export type FormatTableRow = Record<string, unknown> | unknown[];
export type FormatTableInput = FormatTableRow[] | {
    headers?: FormatTableHeader[];
    rows?: FormatTableRow[];
};
export type FormatTableOptions = {
    align?: Record<string, FormatTableAlign | undefined>;
    gap?: number;
};
/**
 * Render tabular data as an aligned, monospace plain-text table (header row + one line per row).
 * Accepts an array of row objects, or `{ headers, rows }` with string/`{ key, label, align }`
 * headers and object/array rows. `opts.align` maps a column key/label to `"left"`|`"right"`;
 * `opts.gap` sets the space count between columns (default 2). Pure — no I/O, no dependencies.
 * Returns "" when there are no columns.
 */
export declare function formatTable(input: FormatTableInput, opts?: FormatTableOptions): string;
