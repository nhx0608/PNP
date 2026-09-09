import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat,
} from "node:fs/promises";
import path from "node:path";
import { PnpError } from "../core/errors.ts";
import {
  CODE_ROOT, resolvePnpSettingsDocument, validatePnpSettingsDocument,
} from "./settings.ts";
import type { EffectiveSettings, SettingsProblem } from "./settings.ts";
import { effectiveProvenance } from "./provenance.ts";
import type { ProvenanceEntry } from "./provenance.ts";
import { inspectConfiguredCapabilities } from "./capability-readiness.ts";
import type { ConfiguredCapabilityReport } from "./capability-readiness.ts";
import { changedSections, combinedEffect, configEffects, sectionEffect } from "./effects.ts";
import type { SectionEffect } from "./effects.ts";

type JsonObject = Record<string, unknown>;
const MAX_INSTRUCTION_BYTES = 1024 * 1024;
const RUNTIME_VARIABLES = [
  "PNP_QUESTION_POLICY", "PNP_MODEL_STRICT", "PNP_ALLOW_HTTP_ENDPOINTS",
  "PNP_INTERACTION_TIMEOUT_MS", "PNP_CONFIGURED_POLICY_OVERRIDES", "PNP_PACK_ROOTS",
] as const;

/** CONFIG_CONFLICT plus the digest the caller has to re-base on before retrying. */
export class ConfigConflictError extends PnpError {
  readonly current: string;
  constructor(message: string, current: string) {
    super("CONFIG_CONFLICT", message, 409);
    this.name = "ConfigConflictError";
    this.current = current;
  }
}

/** SETTINGS_INVALID carrying the per-section problems a validating route replies with. */
export class SettingsInvalidError extends PnpError {
  readonly problems: readonly SettingsProblem[];
  constructor(problems: readonly SettingsProblem[]) {
    super("SETTINGS_INVALID", "Candidate settings are invalid.", 400);
    this.name = "SettingsInvalidError";
    this.problems = problems;
  }
}

export interface ConfigServiceOptions {
  engineId: string;
  settingsPath: string;
  engineIds?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  runningSha256?: string;
  loadedAt?: string;
  readonly?: boolean;
  historyDirectory?: string;
}

export interface EnvironmentEntry {
  variable: string;
  set: boolean;
  kind: "model" | "mcp" | "runtime" | "asset";
  paths: readonly string[];
}

interface SettingsSnapshot {
  bytes: Buffer;
  document: unknown;
  sha256: string;
  modifiedAt: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: SettingsProblem[];
  effective: Record<string, EffectiveSettings>;
  provenance: Record<string, ProvenanceEntry[]>;
  /** Per engine: what this candidate configures that the engine cannot currently carry. */
  capabilities: Record<string, ConfiguredCapabilityReport>;
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseDocument(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new PnpError("SETTINGS_INVALID", "PNP settings could not be loaded.", 400); }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function environmentKind(pathName: string): EnvironmentEntry["kind"] {
  if (pathName.includes(".model.")) return "model";
  if (pathName.includes(".mcp.")) return "mcp";
  if (pathName.includes(".assets.") || pathName.includes(".skills.") || pathName.includes(".packs.")) return "asset";
  return "runtime";
}

function collectEnvironmentNames(document: unknown, environment: NodeJS.ProcessEnv): EnvironmentEntry[] {
  const found = new Map<string, { kind: EnvironmentEntry["kind"]; paths: string[] }>();
  const add = (variable: string, at: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) return;
    const prior = found.get(variable);
    if (prior === undefined) found.set(variable, { kind: environmentKind(at), paths: [at] });
    else if (!prior.paths.includes(at)) prior.paths.push(at);
  };
  const visit = (value: unknown, at: string) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${at}.${index}`));
      return;
    }
    const item = object(value);
    if (item === undefined) return;
    for (const [key, child] of Object.entries(item)) {
      const childPath = at.length === 0 ? key : `${at}.${key}`;
      if (key.endsWith("Environment") && typeof child === "string") add(child, childPath);
      else if ((key === "headerEnvironment" || key === "env") && object(child) !== undefined) {
        for (const [name, variable] of Object.entries(object(child)!)) {
          if (typeof variable === "string") add(variable, `${childPath}.${name}`);
        }
      }
      visit(child, childPath);
    }
  };
  visit(document, "");
  for (const variable of RUNTIME_VARIABLES) {
    if (!found.has(variable)) found.set(variable, { kind: "runtime", paths: [`runtime.${variable}`] });
  }
  return [...found.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([variable, info]) => ({
    variable,
    set: typeof environment[variable] === "string" && environment[variable]!.trim() !== "",
    kind: info.kind,
    paths: info.paths,
  }));
}

/**
 * settings.json is a file of NAMES: a credential reaches the gateway through an environment
 * variable that model, mcp and asset entries reference by variable name, never as a value. This
 * check enforces that shape on everything that crosses HTTP, in either direction, so a document
 * that has been hand-edited into carrying a secret is refused instead of being served or stored.
 *
 * It deliberately scans by field name and by URL shape rather than by field location, because the
 * open domains (`native`, `assets.<kind>.<id>.parameters`) have no schema to check against - a
 * blanket ban on those two would close the extension point this configuration model exists for.
 */
function assertHttpSafeDocument(document: unknown): void {
  const fail = (at: string) => {
    throw new PnpError("CONFIG_HTTP_UNSAFE_FIELD", `Configuration field ${at} cannot cross the HTTP boundary.`, 400);
  };
  // Segment-wise, so "apiKey" and "auth_token" are caught while "reserveTokens" - a count, in an
  // engine's own options - is not mistaken for one. Only a string can be a credential, so the rule
  // asks about the value's type too rather than about the key alone.
  const SENSITIVE = new Set([
    "password", "passwd", "secret", "secrets", "token", "tokens",
    "cookie", "cookies", "authorization", "credential", "credentials", "apikey",
  ]);
  const namesACredential = (key: string, value: unknown): boolean => {
    const words = key.split(/[^A-Za-z0-9]+/)
      .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
      .map((part) => part.toLowerCase())
      .filter((part) => part !== "");
    const sensitive = words.some((word) => SENSITIVE.has(word))
      || (words.includes("api") && words.includes("key"));
    if (!sensitive) return false;
    return typeof value === "string"
      || (Array.isArray(value) && value.some((entry) => typeof entry === "string"));
  };
  const visit = (value: unknown, at: string, inVariableMap: boolean) => {
    if (Array.isArray(value)) {
      // "--token=abc" hides a credential inside one argv element; "--token" followed by a
      // separate value element is caught by the element that carries it.
      if (at.endsWith(".args")) {
        for (const entry of value) {
          if (typeof entry !== "string" || !entry.includes("=")) continue;
          const flag = entry.slice(0, entry.indexOf("="));
          if (/^--?[A-Za-z0-9._-]*$/.test(flag) && namesACredential(flag, entry.slice(flag.length + 1))) fail(at);
        }
      }
      value.forEach((entry, index) => visit(entry, `${at}.${index}`, inVariableMap));
      return;
    }
    const item = object(value);
    if (item === undefined) return;
    for (const [key, child] of Object.entries(item)) {
      const childPath = at.length === 0 ? key : `${at}.${key}`;
      // env / headerEnvironment / *Environment hold variable NAMES, so a key called
      // "Authorization" there names the header, not its value.
      const variableMap = key === "env" || key === "headerEnvironment";
      if (!inVariableMap && !key.endsWith("Environment") && namesACredential(key, child)) fail(childPath);
      if ((key === "endpoint" || key === "url") && typeof child === "string") {
        let url: URL;
        try { url = new URL(child); }
        catch { fail(childPath); return; }
        if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") fail(childPath);
      }
      visit(child, childPath, variableMap);
    }
  };
  visit(document, "settings", false);
}

function safeProblems(problems: readonly SettingsProblem[], environment: NodeJS.ProcessEnv): SettingsProblem[] {
  const secrets = Object.values(environment).filter((value): value is string => typeof value === "string" && value.length >= 8);
  return problems.map((problem) => {
    let message = problem.message;
    for (const secret of secrets) message = message.split(secret).join("[redacted]");
    return { ...problem, message };
  });
}

/**
 * Editing a listed instruction file is the one change that reaches a session without a restart,
 * because every turn re-reads the file. Sessions that are already open are fenced, not patched.
 */
function instructionEffect(): { effect: SectionEffect["effect"]; residents: SectionEffect["residents"]; note: string } {
  const statement = sectionEffect("instruction-file")!;
  return { effect: statement.effect, residents: statement.residents, note: statement.note };
}

export class ConfigService {
  readonly engineId: string;
  readonly settingsPath: string;
  readonly readonly: boolean;
  readonly loadedAt: string;
  private readonly engineIds: readonly string[];
  private readonly environment: NodeJS.ProcessEnv;
  private readonly settingsDirectory: string;
  private readonly historyDirectory: string;
  private runningSha256: string | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: ConfigServiceOptions) {
    this.engineId = options.engineId;
    this.settingsPath = path.resolve(options.settingsPath);
    this.settingsDirectory = path.dirname(this.settingsPath);
    this.engineIds = [...new Set(options.engineIds ?? [options.engineId])];
    this.environment = options.environment ?? process.env;
    this.runningSha256 = options.runningSha256;
    this.loadedAt = options.loadedAt ?? new Date().toISOString();
    this.readonly = options.readonly ?? this.environment.PNP_CONFIG_READONLY === "1";
    this.historyDirectory = options.historyDirectory ?? path.join(CODE_ROOT, "runtime", "config-history");
  }

  private async snapshot(): Promise<SettingsSnapshot> {
    let bytes: Buffer;
    let info;
    try {
      [bytes, info] = await Promise.all([readFile(this.settingsPath), stat(this.settingsPath)]);
    } catch {
      throw new PnpError("SETTINGS_INVALID", "PNP settings could not be loaded.", 400);
    }
    const document = parseDocument(bytes);
    const sha256 = digest(bytes);
    this.runningSha256 ??= sha256;
    return { bytes, document, sha256, modifiedAt: info.mtime.toISOString() };
  }

  private assertEngine(engineId: string): void {
    if (!this.engineIds.includes(engineId)) {
      throw new PnpError("CONFIG_UNKNOWN_ENGINE", "The requested engine is not registered.", 404);
    }
  }

  async read(engineId = this.engineId) {
    this.assertEngine(engineId);
    const snapshot = await this.snapshot();
    assertHttpSafeDocument(snapshot.document);
    const effective = await resolvePnpSettingsDocument(snapshot.document, {
      engineId, settingsDirectory: this.settingsDirectory, environment: this.environment,
    });
    const provenance = effectiveProvenance(snapshot.document, engineId, effective);
    const environment = collectEnvironmentNames(snapshot.document, this.environment);
    provenance.push(...environment.flatMap((item) => item.paths.map((at) => ({
      path: at, layer: "environment" as const, source: item.variable,
      variable: item.variable, set: item.set,
    }))));
    return {
      file: {
        path: this.settingsPath, sha256: snapshot.sha256, modifiedAt: snapshot.modifiedAt,
        readonly: this.readonly,
      },
      running: {
        engine: this.engineId, sha256: this.runningSha256!, loadedAt: this.loadedAt,
        inSync: snapshot.sha256 === this.runningSha256,
      },
      effective,
      provenance,
      // Configured, parsed, and honestly not in force: the page shows these next to the fields
      // that produced them instead of letting an operator believe a domain took effect.
      capabilities: inspectConfiguredCapabilities(effective, engineId),
      effect: "restart" as const,
      effects: configEffects(),
      warnings: [] as SettingsProblem[],
    };
  }

  async raw(): Promise<{ settings: unknown; sha256: string; modifiedAt: string }> {
    const snapshot = await this.snapshot();
    assertHttpSafeDocument(snapshot.document);
    return { settings: snapshot.document, sha256: snapshot.sha256, modifiedAt: snapshot.modifiedAt };
  }

  async validate(settings: unknown, engines?: readonly string[]): Promise<ValidationResult> {
    assertHttpSafeDocument(settings);
    const selected = engines === undefined ? [this.engineId] : [...new Set(engines)];
    if (selected.length === 0) throw new PnpError("VALIDATION_ERROR", "engines must not be empty.", 400);
    selected.forEach((engineId) => this.assertEngine(engineId));
    const effective: Record<string, EffectiveSettings> = {};
    const provenance: Record<string, ProvenanceEntry[]> = {};
    const capabilities: Record<string, ConfiguredCapabilityReport> = {};
    const problems: SettingsProblem[] = [];
    for (const engineId of selected) {
      const result = await validatePnpSettingsDocument(settings, {
        engineId, settingsDirectory: this.settingsDirectory, environment: this.environment,
      });
      problems.push(...result.problems.map((problem) => ({
        ...problem,
        path: selected.length === 1 ? problem.path : `engines.${engineId}.${problem.path}`,
      })));
      if (result.effective !== undefined) {
        effective[engineId] = result.effective;
        provenance[engineId] = effectiveProvenance(settings, engineId, result.effective);
        capabilities[engineId] = inspectConfiguredCapabilities(result.effective, engineId);
      }
    }
    const safe = safeProblems(problems, this.environment);
    return {
      ok: !safe.some((problem) => problem.severity === "error"),
      problems: safe, effective, provenance, capabilities,
    };
  }

  async environmentStatus(): Promise<{ variables: EnvironmentEntry[]; howToSet: string }> {
    const snapshot = await this.snapshot();
    assertHttpSafeDocument(snapshot.document);
    return {
      variables: collectEnvironmentNames(snapshot.document, this.environment),
      howToSet: "Set values with .\\pnp.cmd config or runtime\\local.env, then restart the gateway.",
    };
  }

  private async serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); }
    finally { release(); }
  }

  private assertWritable(): void {
    if (this.readonly) throw new PnpError("CONFIG_READONLY", "Configuration writes are disabled.", 403);
  }

  async write(settings: unknown, baseSha256: string, label?: string) {
    this.assertWritable();
    if (!/^[a-f0-9]{64}$/.test(baseSha256)) {
      throw new PnpError("VALIDATION_ERROR", "baseSha256 must be a SHA-256 digest.", 400);
    }
    if (label !== undefined && !/^[A-Za-z0-9._-]{1,48}$/.test(label)) {
      throw new PnpError("VALIDATION_ERROR", "label may contain only letters, numbers, dot, underscore, and dash.", 400);
    }
    const validation = await this.validate(settings, this.engineIds);
    if (!validation.ok) throw new SettingsInvalidError(validation.problems);
    return this.serializeWrite(async () => {
      const before = await this.snapshot();
      if (before.sha256 !== baseSha256) {
        throw new ConfigConflictError("The settings file changed; reload it and re-apply the edit.", before.sha256);
      }
      const serialized = `${JSON.stringify(settings, null, 2)}\n`;
      const sha256 = digest(serialized);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const suffix = label === undefined ? "" : `-${label}`;
      const backup = path.join(this.historyDirectory, `settings-${stamp}${suffix}.json`);
      const temporary = path.join(this.settingsDirectory, `.settings.json.tmp-${process.pid}-${digest(`${stamp}-${Math.random()}`).slice(0, 12)}`);
      try {
        await mkdir(this.historyDirectory, { recursive: true });
        await copyFile(this.settingsPath, backup, constants.COPYFILE_EXCL);
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(serialized, "utf8");
          await handle.sync();
        } finally { await handle.close(); }
        const unchanged = await this.snapshot();
        if (unchanged.sha256 !== baseSha256) {
          throw new ConfigConflictError("The settings file changed; reload it and re-apply the edit.", unchanged.sha256);
        }
        await rename(temporary, this.settingsPath);
      } catch (error) {
        try { await rm(temporary, { force: true }); } catch { /* The known temp is best-effort cleanup. */ }
        if (error instanceof PnpError) throw error;
        throw new PnpError("CONFIG_WRITE_FAILED", "The settings file could not be replaced; its backup is intact.", 500);
      }
      const changed = changedSections(before.document, settings);
      return {
        sha256, backup, effect: combinedEffect(changed), changed,
        running: { sha256: this.runningSha256!, inSync: sha256 === this.runningSha256 },
      };
    });
  }

  private instructionRoot(): string {
    return path.join(this.settingsDirectory, "instructions");
  }

  private async assertNotLocalEnvironmentAlias(target: string): Promise<void> {
    const targetInfo = await stat(target);
    const candidates = [
      path.join(this.settingsDirectory, "local.env"),
      path.join(CODE_ROOT, "runtime", "local.env"),
    ];
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (info.dev === targetInfo.dev && info.ino === targetInfo.ino) {
          throw new PnpError("CONFIG_PATH_FORBIDDEN", "Environment files cannot be accessed through the configuration API.", 403);
        }
      } catch (error) {
        if (error instanceof PnpError) throw error;
      }
    }
  }

  private async existingInstruction(relative: string): Promise<string> {
    if (relative.includes("\0") || path.isAbsolute(relative) || path.extname(relative).toLowerCase() !== ".md") {
      throw new PnpError("CONFIG_PATH_FORBIDDEN", "Only relative Markdown instruction paths are allowed.", 403);
    }
    let root: string;
    let target: string;
    try {
      root = await realpath(this.instructionRoot());
      const lexical = path.resolve(root, relative);
      if (!isInside(root, lexical)) throw new PnpError("CONFIG_PATH_FORBIDDEN", "Instruction path leaves its approved root.", 403);
      const linkInfo = await lstat(lexical);
      if (linkInfo.isSymbolicLink()) throw new PnpError("CONFIG_PATH_FORBIDDEN", "Instruction links are not allowed.", 403);
      target = await realpath(lexical);
    } catch (error) {
      if (error instanceof PnpError) throw error;
      throw new PnpError("NOT_FOUND", "Instruction file not found.", 404);
    }
    if (!isInside(root, target)) throw new PnpError("CONFIG_PATH_FORBIDDEN", "Instruction path leaves its approved root.", 403);
    const info = await stat(target);
    if (!info.isFile()) throw new PnpError("CONFIG_PATH_FORBIDDEN", "Instruction path must name a regular file.", 403);
    if (info.size > MAX_INSTRUCTION_BYTES) throw new PnpError("CONFIG_FILE_TOO_LARGE", "Instruction file exceeds 1 MiB.", 413);
    await this.assertNotLocalEnvironmentAlias(target);
    return target;
  }

  /**
   * The instruction files a page can open, with the digest each edit has to quote back. Only
   * regular Markdown files directly under the approved root are listed: a link or a nested
   * directory is not something this API is willing to write through, so it is not offered.
   */
  async listInstructions(): Promise<{ kind: "instruction"; root: string; files: { path: string; bytes: number; sha256: string }[] }> {
    const root = this.instructionRoot();
    let entries: string[];
    try { entries = await readdir(root); }
    catch { return { kind: "instruction", root, files: [] }; }
    const files: { path: string; bytes: number; sha256: string }[] = [];
    for (const name of [...entries].sort()) {
      if (path.extname(name).toLowerCase() !== ".md") continue;
      let target: string;
      try { target = await this.existingInstruction(name); }
      catch { continue; }
      const bytes = await readFile(target);
      files.push({ path: name, bytes: bytes.byteLength, sha256: digest(bytes) });
    }
    return { kind: "instruction", root, files };
  }

  async readInstruction(relative: string) {
    const target = await this.existingInstruction(relative);
    const bytes = await readFile(target);
    return {
      path: relative.replace(/\\/g, "/"), text: bytes.toString("utf8"), sha256: digest(bytes),
      ...instructionEffect(),
    };
  }

  async writeInstruction(relative: string, text: string, ifMatch: string) {
    this.assertWritable();
    if (typeof text !== "string") throw new PnpError("VALIDATION_ERROR", "text must be a string.", 400);
    if (Buffer.byteLength(text) > MAX_INSTRUCTION_BYTES) {
      throw new PnpError("CONFIG_FILE_TOO_LARGE", "Instruction text exceeds 1 MiB.", 413);
    }
    if (ifMatch !== "*" && !/^[a-f0-9]{64}$/.test(ifMatch)) {
      throw new PnpError("VALIDATION_ERROR", "ifMatch must be * or a SHA-256 digest.", 400);
    }
    return this.serializeWrite(async () => {
      const target = await this.existingInstruction(relative);
      const before = await readFile(target);
      const current = digest(before);
      if (ifMatch !== "*" && current !== ifMatch) {
        throw new ConfigConflictError("The instruction file changed; reload it and re-apply the edit.", current);
      }
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${digest(`${Date.now()}-${Math.random()}`).slice(0, 12)}`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(text, "utf8");
          await handle.sync();
        } finally { await handle.close(); }
        const unchanged = digest(await readFile(target));
        if (unchanged !== current) {
          throw new ConfigConflictError("The instruction file changed; reload it and re-apply the edit.", unchanged);
        }
        await rename(temporary, target);
      } catch (error) {
        try { await rm(temporary, { force: true }); } catch { /* The known temp is best-effort cleanup. */ }
        if (error instanceof PnpError) throw error;
        throw new PnpError("CONFIG_WRITE_FAILED", "The instruction file could not be replaced.", 500);
      }
      return { path: relative.replace(/\\/g, "/"), sha256: digest(text), ...instructionEffect() };
    });
  }
}

