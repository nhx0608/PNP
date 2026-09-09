export class DesktopMcpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function errorMessage(error: unknown): { code: string; message: string } {
  if (error instanceof DesktopMcpError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "UNEXPECTED", message: error.message };
  return { code: "UNEXPECTED", message: String(error) };
}
