export const TYPES_PATH: string;

export const SETTINGS_PREVIEW_PATH: string;

export function extractRepositorySettingsFieldNames(source: string): Set<string>;

export function extractRepoSettingsPreviewFieldNames(source: string): Set<string>;

export function diffFieldSets(typeFields: Set<string>, schemaFields: Set<string>): { missingFromSchema: string[]; extraInSchema: string[] };
