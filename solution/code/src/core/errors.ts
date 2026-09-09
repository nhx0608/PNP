export class PnpError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = "PnpError";
    this.code = code;
    this.status = status;
  }
}
export function asPnpError(error: unknown): PnpError {
  return error instanceof PnpError
    ? error
    : new PnpError("INTERNAL_ERROR", "The operation failed; inspect sanitized diagnostics.");
}

/**
 * One redacted line about a throwable that was not a PnpError, for the gateway's own stderr: the
 * HTTP reply stays the generic INTERNAL_ERROR, but an operator (or a CI log) can see what class of
 * failure it was. Every non-trivial value of the process environment is masked in the message, so a
 * credential that leaked into an error text never reaches the log.
 */
export function describeInternalFailure(error: unknown, environment: NodeJS.ProcessEnv = process.env): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  let message = raw.slice(0, 400);
  for (const value of Object.values(environment)) {
    if (typeof value === "string" && value.length >= 12 && message.includes(value)) message = message.split(value).join("[redacted]");
  }
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  return JSON.stringify({ event: "internal-error", ...(code === undefined ? {} : { code }), message });
}
