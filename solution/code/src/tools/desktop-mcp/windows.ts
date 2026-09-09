import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { DesktopMcpError } from "./errors.ts";

const POWERSHELL = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const HELPER_TIMEOUT_MS = 10_000;

export type DesktopApplication = { id: "notepad" | "outlook-classic" | "outlook-new"; name: string; available: boolean; executablePath?: string; diagnostic?: string };

async function canAccess(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
function requireWindows(): void { if (process.platform !== "win32") throw new DesktopMcpError("PLATFORM_UNSUPPORTED", `Windows desktop tools require win32; current platform is ${process.platform}.`); }
function stopOwnedHelper(child: ChildProcess): void { if (child.exitCode === null && !child.killed) child.kill(); }

async function runPowerShell(script: string, signal?: AbortSignal): Promise<string> {
  requireWindows();
  if (signal?.aborted) throw new DesktopMcpError("CANCELLED", "The request was cancelled before its PowerShell helper started.");
  const prefix = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ";
  const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", prefix + script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let interrupted: DesktopMcpError | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => { clearTimeout(timeout); clearTimeout(stopTimer); signal?.removeEventListener("abort", cancelled); };
    const finish = (callback: () => void): void => { if (!settled) { settled = true; cleanup(); callback(); } };
    const interrupt = (error: DesktopMcpError): void => {
      if (interrupted !== undefined || settled) return;
      interrupted = error;
      stopOwnedHelper(child);
      stopTimer = setTimeout(() => finish(() => reject(new DesktopMcpError("HELPER_STOP_UNVERIFIED", "Helper termination could not be verified; any submitted application activation remains uncertain."))), 2000);
    };
    const cancelled = (): void => interrupt(new DesktopMcpError("CANCELLED", "The request was cancelled. Any previously submitted application activation is not revoked."));
    const timeout = setTimeout(() => interrupt(new DesktopMcpError("DISCOVERY_TIMEOUT", `The PowerShell helper exceeded ${HELPER_TIMEOUT_MS} ms.`)), HELPER_TIMEOUT_MS);
    signal?.addEventListener("abort", cancelled, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; if (stdout.length > 64 * 1024) interrupt(new DesktopMcpError("DISCOVERY_FAILED", "Application discovery returned too much output.")); });
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 64 * 1024); });
    child.once("error", () => finish(() => reject(new DesktopMcpError("DISCOVERY_FAILED", "Windows could not start the PowerShell helper."))));
    child.once("close", (code: number | null) => {
      if (interrupted !== undefined) finish(() => reject(interrupted));
      else if (code === 0) finish(() => resolve(stdout.trim()));
      else finish(() => reject(new DesktopMcpError("DISCOVERY_FAILED", `PowerShell helper exited with code ${code ?? "unknown"}.${stderr.length > 0 ? " It reported an error." : ""}`)));
    });
    if (signal?.aborted) cancelled();
  });
}

async function classicOutlookPath(signal?: AbortSignal): Promise<string | undefined> {
  const output = await runPowerShell("$keys=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\OUTLOOK.EXE','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\OUTLOOK.EXE'); foreach($key in $keys){if(Test-Path $key){$value=(Get-ItemProperty -Path $key -ErrorAction Stop).'(default)'; if($value){[Console]::Out.Write($value); break}}}", signal);
  const candidate = output.replace(/^"|"$/g, "");
  if (candidate.length === 0 || path.win32.basename(candidate).toUpperCase() !== "OUTLOOK.EXE" || !await canAccess(candidate)) return undefined;
  return candidate;
}

async function newOutlookAvailable(signal?: AbortSignal): Promise<boolean> { return (await runPowerShell("$package=Get-AppxPackage -Name Microsoft.OutlookForWindows -ErrorAction SilentlyContinue; if($null -ne $package){[Console]::Out.Write('true')}", signal)) === "true"; }

export async function discoverApplications(signal?: AbortSignal): Promise<DesktopApplication[]> {
  requireWindows();
  const notepadPath = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\notepad.exe`;
  const [notepad, classicPath, newOutlook] = await Promise.all([canAccess(notepadPath), classicOutlookPath(signal), newOutlookAvailable(signal)]);
  return [
    { id: "notepad", name: "Notepad", available: notepad, ...(notepad ? { executablePath: notepadPath } : { diagnostic: "Notepad executable was not found in the Windows system directory." }) },
    { id: "outlook-classic", name: "Outlook (classic)", available: classicPath !== undefined, ...(classicPath === undefined ? { diagnostic: "Classic Outlook is not registered in Windows App Paths. Install Microsoft Outlook desktop or use Outlook on the web." } : { executablePath: classicPath }) },
    { id: "outlook-new", name: "Outlook (new)", available: newOutlook, ...(newOutlook ? {} : { diagnostic: "New Outlook for Windows package is not installed. Install it from Microsoft Store or use Outlook on the web." }) },
  ];
}

export type DesktopOperations = { discover: (signal?: AbortSignal) => Promise<DesktopApplication[]>; activate: (appId: DesktopApplication["id"], signal?: AbortSignal) => Promise<void> };
async function targetFor(appId: string, operations: DesktopOperations, signal?: AbortSignal): Promise<DesktopApplication["id"]> {
  const app = (await operations.discover(signal)).find((candidate) => candidate.id === appId);
  if (app === undefined) throw new DesktopMcpError("INVALID_ARGUMENT", "appId must be one of: notepad, outlook-classic, outlook-new.");
  if (!app.available) throw new DesktopMcpError("APP_UNAVAILABLE", `${app.name} is unavailable. ${app.diagnostic ?? ""}`.trim());
  return app.id;
}

export type LaunchResult = { appId: DesktopApplication["id"]; outcome: "activation_requested"; verification: string };
const ACTIVATION_SCRIPTS: Record<DesktopApplication["id"], string> = {
  notepad: "$shell=New-Object -ComObject Shell.Application; $shell.ShellExecute((Join-Path $env:SystemRoot 'System32\\notepad.exe'))",
  "outlook-classic": "$keys=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\OUTLOOK.EXE','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\OUTLOOK.EXE'); $target=$null; foreach($key in $keys){if(Test-Path $key){$target=(Get-ItemProperty -Path $key).'(default)'; if($target){break}}}; if(!$target){throw 'Outlook registration is no longer available'}; $target=$target.Trim('\"'); if(!(Test-Path -LiteralPath $target -PathType Leaf)){throw 'Outlook executable is no longer available'}; $shell=New-Object -ComObject Shell.Application; $shell.ShellExecute($target)",
  "outlook-new": "$shell=New-Object -ComObject Shell.Application; $shell.ShellExecute((Join-Path $env:SystemRoot 'explorer.exe'),'shell:AppsFolder\\Microsoft.OutlookForWindows_8wekyb3d8bbwe!Microsoft.Outlook')",
};
async function requestShellActivation(appId: DesktopApplication["id"], signal?: AbortSignal): Promise<void> { await runPowerShell(ACTIVATION_SCRIPTS[appId], signal); }
const defaultOperations: DesktopOperations = { discover: discoverApplications, activate: requestShellActivation };
export async function openApplication(appId: string, signal?: AbortSignal, operations: DesktopOperations = defaultOperations): Promise<LaunchResult> {
  if (signal?.aborted) throw new DesktopMcpError("CANCELLED", "Cancelled before application discovery.");
  const target = await targetFor(appId, operations, signal);
  if (signal?.aborted) throw new DesktopMcpError("CANCELLED", "Cancelled before application activation.");
  await operations.activate(target, signal);
  return { appId: target, outcome: "activation_requested", verification: "Windows Shell accepted the activation request. UI readiness, sign-in state, and the launched app's process lifetime are not verified." };
}
