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

function leaves(value: unknown, prefix: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => leaves(entry, `${prefix}.${index}`));
  }
  const item = object(value);
  if (item === undefined) return [prefix];
  const entries = Object.entries(item);
  if (entries.length === 0) return [prefix];
  return entries.flatMap(([key, entry]) => leaves(entry, prefix.length === 0 ? key : `${prefix}.${key}`));
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

function entry(path: string, core: boolean, source: string): ProvenanceEntry {
  return { path, layer: core ? "core" : "common", source };
}

/**
 * Explains the effective document without resolving environment variables. The parser remains the
 * authority for merge semantics; this helper only records which declared leaf won that merge.
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
  for (const path of leaves(effective.model.default, "model.default")) {
    result.push(entry(path, modelDefaultCore,
      modelDefaultCore ? `cores.${engineId}.model.default` : "common.model.default"));
  }
  const commonModels = Array.isArray(commonModel?.models) ? commonModel.models : [];
  const coreModels = Array.isArray(coreModel?.models) ? coreModel.models : [];
  const keyOf = (value: unknown): string | undefined => {
    const selection = object(object(value)?.selection);
    return typeof selection?.providerID === "string" && typeof selection.modelID === "string"
      ? `${selection.providerID}\0${selection.modelID}`
      : undefined;
  };
  const commonModelKeys = new Set(commonModels.map(keyOf).filter((key) => key !== undefined));
  const coreModelKeys = new Set(coreModels.map(keyOf).filter((key) => key !== undefined));
  effective.model.models.forEach((model, index) => {
    const key = `${model.selection.providerID}\0${model.selection.modelID}`;
    const fromCore = coreModelKeys.has(key);
    const declared = fromCore || commonModelKeys.has(key);
    for (const path of leaves(model, `model.models.${index}`)) {
      result.push(declared
        ? entry(path, fromCore, fromCore ? `cores.${engineId}.model.models` : "common.model.models")
        : { path, layer: "default", source: "schema default" });
    }
  });

  const commonPermissions = object(common.permissions) ?? {};
  const corePermissions = object(core.permissions) ?? {};
  const defaultCore = Object.hasOwn(corePermissions, "default");
  result.push(entry("permissions.default", defaultCore,
    defaultCore ? `cores.${engineId}.permissions.default` : "common.permissions.default"));
  const commonOperations = object(commonPermissions.operations) ?? {};
  const coreOperations = object(corePermissions.operations) ?? {};
  for (const operation of Object.keys(effective.permissions.operations)) {
    const fromCore = Object.hasOwn(coreOperations, operation);
    result.push(entry(`permissions.operations.${operation}`, fromCore,
      fromCore ? `cores.${engineId}.permissions.operations.${operation}` : `common.permissions.operations.${operation}`));
  }

  const instructionsCore = Object.hasOwn(core, "instructions");
  effective.instructions.forEach((_file, index) => result.push(entry(`instructions.${index}`, instructionsCore,
    instructionsCore ? `cores.${engineId}.instructions.${index}` : `common.instructions.${index}`)));

  const commonServers = object(object(common.mcp)?.servers) ?? {};
  const coreServers = object(object(core.mcp)?.servers) ?? {};
  effective.mcp.servers.forEach((server, index) => {
    const commonServer = object(commonServers[server.id]) ?? {};
    const coreServer = object(coreServers[server.id]) ?? {};
    for (const path of leaves(server, `mcp.servers.${index}`)) {
      const relative = path.split(".").slice(3);
      const fromCore = hasPath(coreServer, relative);
      const fromCommon = hasPath(commonServer, relative);
      result.push(fromCore || fromCommon
        ? entry(path, fromCore, fromCore
          ? `cores.${engineId}.mcp.servers.${server.id}.${relative.join(".")}`
          : `common.mcp.servers.${server.id}.${relative.join(".")}`)
        : { path, layer: "default", source: "schema default" });
    }
  });

  for (const section of ["skills", "assets", "packs", "native", "assetRoots"] as const) {
    const value = effective[section];
    for (const path of leaves(value, section)) {
      const relative = path.split(".").slice(1);
      const fromCore = hasPath(core[section], relative);
      const fromCommon = hasPath(common[section], relative);
      result.push(fromCore || fromCommon
        ? entry(path, fromCore, fromCore
          ? `cores.${engineId}.${section}.${relative.join(".")}`
          : `common.${section}.${relative.join(".")}`)
        : { path, layer: "default", source: "schema default" });
    }
  }
  return result;
}

