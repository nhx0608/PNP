/**
 * A tool failure the caller can act on: the model sees `<CODE>: <message>` and the code names the
 * one thing to change (an absolute path, an existing output file, a unique match). Anything else
 * that escapes a handler is reported with its own message and the code `UNEXPECTED`, never as a
 * silent empty result — a tool that answers "nothing" where it meant "I could not read the file"
 * is the failure mode that makes an agent invent content.
 */
export type OfficeErrorCode =
  | "PATH_NOT_ABSOLUTE"
  | "PATH_NOT_FOUND"
  | "NOT_A_FILE"
  | "OUTPUT_EXISTS"
  | "OUTPUT_IS_INPUT"
  | "INVALID_ARGUMENT"
  | "NO_MATCH"
  | "AMBIGUOUS_MATCH"
  | "INDEX_OUT_OF_RANGE"
  | "UNSUPPORTED_FORMAT"
  | "PROTECTED_LOCATION"
  | "PLATFORM_UNSUPPORTED"
  | "REQUEST_FAILED"
  | "UNEXPECTED";

export class OfficeToolError extends Error {
  readonly code: OfficeErrorCode;
  constructor(code: OfficeErrorCode, message: string) {
    super(message);
    this.name = "OfficeToolError";
    this.code = code;
  }
}

export function describeError(error: unknown): { code: OfficeErrorCode; message: string } {
  if (error instanceof OfficeToolError) return { code: error.code, message: error.message };
  if (error instanceof Error) {
    // Node's own filesystem errors carry the actionable part in `code`; keep it visible instead of
    // flattening every failure into "UNEXPECTED".
    const nodeCode: unknown = (error as { code?: unknown }).code;
    return {
      code: "UNEXPECTED",
      message: typeof nodeCode === "string" ? `${nodeCode}: ${error.message}` : error.message,
    };
  }
  return { code: "UNEXPECTED", message: String(error) };
}
