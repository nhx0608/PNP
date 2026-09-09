import { PnpError } from "../core/errors.ts";
import type { AssetEntry, EffectiveSettings } from "./settings.ts";

export interface ConfiguredCapabilityNotice {
  kind: string;
  id: string;
  reason: "not-targeted" | "projection-unavailable" | "pack-loader-unavailable";
}
export interface ConfiguredCapabilityReport {
  engineId: string;
  /** Settings syntax acceptance is independent of whether this delivery can apply it. */
  applicable: boolean;
  skipped: ConfiguredCapabilityNotice[];
  required: ConfiguredCapabilityNotice[];
  nativeOptionsPending: boolean;
}

/**
 * P2 installs the settings envelope, not the P1/P3/P4/P5/P6 public contract and native
 * projectors. The current IntegrationContext cannot carry an arbitrary asset kind or a
 * directory bundle. Merely accepting the JSON must therefore never pretend it was applied.
 *
 * Existing `instructions` and MCP bindings keep their proven path. New settings domains are
 * reported conservatively until their actual projector is connected. No engine-name branch
 * or domain allow-list is introduced here or in the settings parser.
 */
export function inspectConfiguredCapabilities(
  settings: Pick<EffectiveSettings, "skills" | "assets" | "packs" | "native">,
  engineId: string,
): ConfiguredCapabilityReport {
  const report: ConfiguredCapabilityReport = {
    engineId, applicable: true, skipped: [], required: [],
    nativeOptionsPending: Object.keys(settings.native).length > 0,
  };
  const inspect = (asset: AssetEntry): void => {
    if (!asset.enabled) return;
    if (asset.engines !== undefined && !asset.engines.includes(engineId)) {
      report.skipped.push({ kind: asset.kind, id: asset.id, reason: "not-targeted" });
      return;
    }
    const notice: ConfiguredCapabilityNotice = {
      kind: asset.kind, id: asset.id, reason: "projection-unavailable",
    };
    (asset.required ? report.required : report.skipped).push(notice);
  };
  for (const skill of settings.skills) inspect(skill);
  for (const assets of Object.values(settings.assets)) for (const asset of Object.values(assets)) inspect(asset);
  for (const pack of settings.packs) {
    if (!pack.enabled) continue;
    const notice: ConfiguredCapabilityNotice = { kind: "pack", id: pack.id, reason: "pack-loader-unavailable" };
    (pack.required ? report.required : report.skipped).push(notice);
  }
  report.applicable = report.required.length === 0 && !report.nativeOptionsPending;
  return report;
}

/** Invoked by loadIntegration, before main can probe or open any engine channel. */
export function assertConfiguredCapabilitiesApplicable(report: ConfiguredCapabilityReport): void {
  const assets = report.required.filter((entry) => entry.reason === "projection-unavailable");
  if (assets.length > 0) {
    const domains = new Map<string, string[]>();
    for (const asset of assets) {
      const ids = domains.get(asset.kind) ?? [];
      ids.push(asset.id);
      domains.set(asset.kind, ids);
    }
    const details = [...domains].map(([kind, ids]) => `${JSON.stringify(kind)} (${ids.map((id) => JSON.stringify(id)).join(", ")})`);
    throw new PnpError("ENGINE_ASSET_KIND_UNSUPPORTED",
      `Engine ${JSON.stringify(report.engineId)} has no connected settings projector for required domain(s): ${details.join("; ")}.`, 502);
  }
  const packs = report.required.filter((entry) => entry.reason === "pack-loader-unavailable");
  if (packs.length > 0) {
    throw new PnpError("PACK_LOADER_UNAVAILABLE",
      `Required pack(s) ${packs.map((entry) => JSON.stringify(entry.id)).join(", ")} need the manifest loader and engine projectors.`, 502);
  }
  if (report.nativeOptionsPending) {
    throw new PnpError("NATIVE_OPTIONS_UNSUPPORTED",
      `Engine ${JSON.stringify(report.engineId)} has no connected native-options validator/projector in this configuration path.`, 400);
  }
}
