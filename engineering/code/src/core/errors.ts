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
