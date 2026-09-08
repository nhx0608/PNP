import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { OfficeToolError } from "./errors.ts";

/**
 * Evaluation tasks hand the model absolute Windows paths that often contain Chinese characters
 * (`D:\评测\库存\西安分公司.docx`). The server never resolves a relative path against its own
 * working directory: the gateway starts it from a directory that has nothing to do with the task,
 * so a relative path would silently write the artefact somewhere the grader never looks. A path is
 * accepted when it is absolute for the running platform, or when it is a Windows drive/UNC path —
 * the second case keeps the error message useful when a Windows path reaches a POSIX host.
 */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\[^\\]/;

export function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || WINDOWS_DRIVE.test(value) || WINDOWS_UNC.test(value);
}

export function requireAbsolutePath(field: string, value: string): string {
  if (value.trim().length === 0) throw new OfficeToolError("INVALID_ARGUMENT", `${field} 不能为空 / must not be empty`);
  if (!isAbsolutePath(value)) {
    throw new OfficeToolError("PATH_NOT_ABSOLUTE",
      `${field} 必须是绝对路径 / must be an absolute path, got ${JSON.stringify(value)}`);
  }
  return path.normalize(value);
}

export async function requireExistingFile(field: string, value: string): Promise<string> {
  const absolute = requireAbsolutePath(field, value);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new OfficeToolError("PATH_NOT_FOUND", `${field} 指向的文件不存在 / file does not exist: ${absolute}`);
  }
  if (!info.isFile()) throw new OfficeToolError("NOT_A_FILE", `${field} 不是文件 / is not a file: ${absolute}`);
  return absolute;
}

export async function requireExistingDirectory(field: string, value: string): Promise<string> {
  const absolute = requireAbsolutePath(field, value);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new OfficeToolError("PATH_NOT_FOUND", `${field} 指向的目录不存在 / directory does not exist: ${absolute}`);
  }
  if (!info.isDirectory()) throw new OfficeToolError("NOT_A_FILE", `${field} 不是目录 / is not a directory: ${absolute}`);
  return absolute;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepares an output path: absolute, parent directories created, and never clobbering an existing
 * file unless the caller said so. Refusing by default is what keeps a second run of the same tool
 * from destroying the source document the first run read.
 */
export async function prepareOutputPath(field: string, value: string, overwrite: boolean): Promise<string> {
  const absolute = requireAbsolutePath(field, value);
  if (!overwrite && await exists(absolute)) {
    throw new OfficeToolError("OUTPUT_EXISTS",
      `${field} 已存在，未设置 overwrite 时不覆盖 / already exists; pass overwrite:true to replace it: ${absolute}`);
  }
  await mkdir(path.dirname(absolute), { recursive: true });
  return absolute;
}

export function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => path.normalize(value).replace(/[\\/]+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
