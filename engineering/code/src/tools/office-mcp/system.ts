import { spawn } from "node:child_process";
import path from "node:path";
import { OfficeToolError } from "./errors.ts";

/**
 * Application names are passed to PowerShell's `Start-Process`. The name is never interpolated into
 * a shell line by this process — the child is spawned with an argument vector — but the argument
 * itself still lands inside a PowerShell command string, so anything that could end the quoted
 * literal or start a second statement is rejected outright. Path separators are rejected as well:
 * this tool launches an installed application ("outlook", "winword"), and a caller that wants to run
 * a file has to say so through a tool that is allowed to.
 */
const APPLICATION_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/;

export type AppOpenResult = {
  name: string;
  command: string;
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

function powerShellExecutable(): string {
  const systemRoot = process.env["SystemRoot"];
  if (systemRoot !== undefined && systemRoot.length > 0) {
    return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  }
  return "powershell.exe";
}

export async function appOpen(name: string, timeoutMs = 20_000): Promise<AppOpenResult> {
  if (process.platform !== "win32") {
    throw new OfficeToolError("PLATFORM_UNSUPPORTED",
      `app_open 只能在 Windows 上使用（当前平台 ${process.platform}）/ app_open is Windows-only, current platform is ${process.platform}`);
  }
  const trimmed = name.trim();
  if (!APPLICATION_NAME.test(trimmed)) {
    throw new OfficeToolError("INVALID_ARGUMENT",
      `name 只能是应用名（字母、数字、空格、. _ + -），不能包含路径分隔符或 shell 元字符 /` +
      ` name must be a bare application name without path separators or shell metacharacters: ${JSON.stringify(name)}`);
  }
  const executable = powerShellExecutable();
  const argv = ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${trimmed}'`];
  return new Promise<AppOpenResult>((resolve, reject) => {
    const child = spawn(executable, argv, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new OfficeToolError("REQUEST_FAILED", `启动 ${trimmed} 超时 / timed out after ${timeoutMs}ms launching ${trimmed}`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new OfficeToolError("REQUEST_FAILED", `无法启动 PowerShell / cannot start PowerShell: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result: AppOpenResult = {
        name: trimmed,
        command: `${executable} ${argv.map((piece) => (piece.includes(" ") ? `"${piece}"` : piece)).join(" ")}`,
        argv: [executable, ...argv],
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
      if (code !== 0) {
        reject(new OfficeToolError("REQUEST_FAILED",
          `Start-Process 退出码 ${code} / exited with ${code}: ${result.stderr || result.stdout || "no output"}`));
        return;
      }
      resolve(result);
    });
  });
}

export type WebFetchResult = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
  bytes: number;
  truncated: boolean;
};

export const DEFAULT_MAX_BYTES = 200_000;
export const DEFAULT_TIMEOUT_MS = 20_000;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ldquo: "“", rdquo: "”", mdash: "—", hellip: "…",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** HTML to the plain text a model can read: scripts and styles dropped, block edges become newlines. */
export function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|table|ul|ol|blockquote)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n").map((line) => line.trim()).join("\n")
    .trim();
}

function charsetOf(contentType: string, body: Uint8Array): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader !== undefined) return fromHeader.toLowerCase();
  const head = new TextDecoder("utf-8", { fatal: false }).decode(body.slice(0, 2048));
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  return (fromMeta ?? "utf-8").toLowerCase();
}

export async function webFetch(
  url: string, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<WebFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OfficeToolError("INVALID_ARGUMENT", `url 不是合法地址 / not a valid URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OfficeToolError("INVALID_ARGUMENT",
      `只支持 http/https / only http and https are supported, got ${parsed.protocol.replace(":", "")}`);
  }
  let response: Response;
  try {
    response = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new OfficeToolError("REQUEST_FAILED",
      `请求失败 / request failed: ${parsed.href} (${error instanceof Error ? error.message : String(error)})`);
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  const body = response.body;
  if (body !== null) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const remaining = maxBytes - received;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, Math.max(0, remaining)));
        received += Math.max(0, remaining);
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  }
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const contentType = response.headers.get("content-type") ?? "";
  const charset = charsetOf(contentType, buffer);
  let decoded: string;
  try {
    decoded = new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    decoded = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
  const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(decoded);
  const title = isHtml ? decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(decoded)?.[1]?.trim() ?? "") : "";
  const result: WebFetchResult = {
    url: parsed.href,
    finalUrl: response.url === "" ? parsed.href : response.url,
    status: response.status,
    contentType,
    text: isHtml ? htmlToText(decoded) : decoded,
    bytes: received,
    truncated,
  };
  if (title.length > 0) result.title = title;
  return result;
}
