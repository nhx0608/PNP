import type { EffectiveSettings } from "./settings.ts";

type JsonObject = Record<string, unknown>;

export interface ProvenanceEntry {
  path: string;
  layer: "common" | "core" | "environment" | "default";
  source: string;
  variable?: string;
  set?: boolean;
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

/**
 * Every leaf of an effective value, as path SEGMENTS rather than a dotted string. Segments matter:
 * an asset kind or a skill id may legally contain a dot, and splitting a joined path on "." would
 * hand the wrong key to the lookup below and silently label the value a schema default.
 */
function leaves(value: unknown, prefix: readonly string[]): string[][] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => leaves(entry, [...prefix, String(index)]));
  }
  const item = object(value);
  if (item === undefined) return [[...prefix]];
  const entries = Object.entries(item);
  if (entries.length === 0) return [[...prefix]];
  return entries.flatMap(([key, entry]) => leaves(entry, [...prefix, key]));
}

function hasPath(value: unknown, path: readonly string[]): boolean {
  let current: unknown = value;
  for (const segment of path) {
    const item = object(current);
    if (item === undefined || !Object.hasOwn(item, segment)) return false;
    current = item[segment];
  }
  return true;
}

function entry(path: readonly string[], core: boolean, source: string): ProvenanceEntry {
  return { path: path.join("."), layer: core ? "core" : "common", source };
}

function schemaDefault(path: readonly string[]): ProvenanceEntry {
  return { path: path.join("."), layer: "default", source: "schema default" };
}

/**
 * Explains the effective document without resolving environment variables. The parser remains the
 * authority for merge semantics; this helper only records which declared leaf won that merge.
 *
 * Three of the effective sections are shaped differently from the document that declares them:
 * `skills` and `packs` are arrays here and maps keyed by id there, and `assetRoots` is derived
 * rather than declared at all. Each is walked against the declaration it actually has, because a
 * lookup that cannot match would report every one of those values as a schema default - which is
 * precisely the opposite of what this module exists to say.
 */
export function effectiveProvenance(
  document: unknown, engineId: string, effective: EffectiveSettings,
): ProvenanceEntry[] {
  const root = object(document) ?? {};
  const common = object(root.common) ?? {};
  const core = object(object(root.cores)?.[engineId]) ?? {};
  const result: ProvenanceEntry[] = [];

  const coreModel = object(core.model);
  const commonModel = object(common.model);
  const modelDefaultCore = coreModel !== undefined && Object.hasOwn(coreModel, "default");
  for (const path of leaves(effective.model.default, ["model", "default"])) {
    result.push(entry(path, modelDefaultCore,
      modelDefaultCore ? `cores.${engineId}.model.default` : "common.model.default"));
  }
  const commonModels = Array.isArray(commonModel?.models) ? commonModel.models : [];
  const coreModels = Array.isArray(coreModel?.models) ? coreModel.models : [];
  const keyOf = (value: unknown): string | undefined => {
    const selection = object(object(value)?.selection);
    return typeof selection?.providerID === "string" && typeof selection.modelID === "string"
      ? JSON.stringify([selection.providerID, selection.modelID])
      : undefined;
  };
  const commonModelKeys = new Set(commonModels.map(keyOf).filter((key) => key !== undefined));
  const coreModelKeys = new Set(coreModels.map(keyOf).filter((key) => key !== undefined));
  effective.model.models.forEach((model, index) => {
    const key = JSON.stringify([model.selection.providerID, model.selection.modelID]);
    const fromCore = coreModelKeys.has(key);
    const declared = fromCore || commonModelKeys.has(key);
    for (const path of leaves(model, ["model", "models", String(index)])) {
      result.push(declared
        ? entry(path, fromCore, fromCore ? `cores.${engineId}.model.models` : "common.model.models")
        : schemaDefault(path));
    }
  });

  const commonPermissions = object(common.permissions) ?? {};
  const corePermissions = object(core.permissions) ?? {};
  const defaultCore = Object.hasOwn(corePermissions, "default");
  result.push(entry(["permissions", "default"], defaultCore,
    defaultCore ? `cores.${engineId}.permissions.default` : "common.permissions.default"));
  const commonOperations = object(commonPermissions.operations) ?? {};
  const coreOperations = object(corePermissions.operations) ?? {};
  for (const operation of Object.keys(effective.permissions.operations)) {
    const fromCore = Object.hasOwn(coreOperations, operation);
    const declared = fromCore || Object.hasOwn(commonOperations, operation);
    result.push(declared
      ? entry(["permissions", "operations", operation], fromCore,
        `${fromCore ? `cores.${engineId}` : "common"}.permissions.operations.${operation}`)
      : schemaDefault(["permissions", "operations", operation]));
  }

  const instructionsCore = Object.hasOwn(core, "instructions");
  effective.instructions.forEach((_file, index) => result.push(entry(["instructions", String(index)], instructionsCore,
    instructionsCore ? `cores.${engineId}.instructions.${index}` : `common.instructions.${index}`)));

  /**
   * The shared shape behind mcp servers, skills and packs: the effective value is an array, the
   * document declares a map keyed by id, and a field is attributed to whichever layer declared it.
   */
  const byId = <T>(
    section: string,
    entries: readonly T[],
    identify: (item: T) => string,
    commonMap: JsonObject,
    coreMap: JsonObject,
  ): void => {
    entries.forEach((item, index) => {
      const id = identify(item);
      const declaredCommon = object(commonMap[id]) ?? {};
      const declaredCore = object(coreMap[id]) ?? {};
      for (const path of leaves(item, [section, String(index)])) {
        const relative = path.slice(2);
        // `id` and `kind` are lifted from the declaring map's key rather than written as fields, so
        // they belong to whichever layer declared the entry at all, not to a schema default.
        const identity = relative.length === 1 && (relative[0] === "id" || relative[0] === "kind");
        const fromCore = identity ? Object.hasOwn(coreMap, id) : hasPath(declaredCore, relative);
        const fromCommon = identity ? Object.hasOwn(commonMap, id) : hasPath(declaredCommon, relative);
        result.push(fromCore || fromCommon
          ? entry(path, fromCore,
            `${fromCore ? `cores.${engineId}` : "common"}.${section}.${[id, ...relative].join(".")}`)
          : schemaDefault(path));
      }
    });
  };

  byId("mcp.servers", effective.mcp.servers, (server) => server.id,
    object(object(common.mcp)?.servers) ?? {}, object(object(core.mcp)?.servers) ?? {});
  byId("skills", effective.skills, (skill) => skill.id,
    object(common.skills) ?? {}, object(core.skills) ?? {});
  byId("packs", effective.packs, (pack) => pack.id,
    object(common.packs) ?? {}, object(core.packs) ?? {});

  // assets and native keep the document's own shape, so a direct lookup is the right one.
  for (const section of ["assets", "native"] as const) {
    for (const path of leaves(effective[section], [section])) {
      const relative = path.slice(1);
      const fromCore = hasPath(core[section], relative);
      const fromCommon = hasPath(common[section], relative);
      result.push(fromCore || fromCommon
        ? entry(path, fromCore,
          `${fromCore ? `cores.${engineId}` : "common"}.${section}.${relative.join(".")}`)
        : schemaDefault(path));
    }
  }

  // Approved roots are never declared in the settings document: two are fixed by the package
  // layout and the rest come from PNP_PACK_ROOTS. Saying "schema default" for the variable-derived
  // ones would hide the only thing an operator can actually change about them.
  effective.assetRoots.forEach((approved, index) => {
    for (const path of leaves(approved, ["assetRoots", String(index)])) {
      result.push(approved.name.startsWith("extra:")
        ? { path: path.join("."), layer: "environment", source: "PNP_PACK_ROOTS", variable: "PNP_PACK_ROOTS", set: true }
        : { path: path.join("."), layer: "default", source: "approved root" });
    }
  });
  return result;
}
