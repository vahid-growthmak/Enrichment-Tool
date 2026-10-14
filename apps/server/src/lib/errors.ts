export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = "error",
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, "bad_request", details);
export const unauthorized = (msg = "Unauthorized") => new HttpError(401, msg, "unauthorized");
export const notFound = (msg = "Not found") => new HttpError(404, msg, "not_found");
export const conflict = (msg: string) => new HttpError(409, msg, "conflict");

/** Error raised by provider clients. `retryable` drives the retry policy. */
export class ProviderError extends Error {
  constructor(
    public readonly provider: "apollo" | "fullenrich",
    message: string,
    public readonly opts: { code?: string; status?: number; retryable?: boolean; retryAfterMs?: number; body?: unknown } = {},
  ) {
    super(message);
    this.name = "ProviderError";
  }
  get code() {
    return this.opts.code ?? "provider_error";
  }
  get retryable() {
    return this.opts.retryable ?? false;
  }
}
