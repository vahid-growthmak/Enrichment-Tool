export class HttpError extends Error {
    statusCode;
    code;
    details;
    constructor(statusCode, message, code = "error", details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        this.name = "HttpError";
    }
}
export const badRequest = (msg, details) => new HttpError(400, msg, "bad_request", details);
export const unauthorized = (msg = "Unauthorized") => new HttpError(401, msg, "unauthorized");
export const notFound = (msg = "Not found") => new HttpError(404, msg, "not_found");
export const conflict = (msg) => new HttpError(409, msg, "conflict");
/** Error raised by provider clients. `retryable` drives the retry policy. */
export class ProviderError extends Error {
    provider;
    opts;
    constructor(provider, message, opts = {}) {
        super(message);
        this.provider = provider;
        this.opts = opts;
        this.name = "ProviderError";
    }
    get code() {
        return this.opts.code ?? "provider_error";
    }
    get retryable() {
        return this.opts.retryable ?? false;
    }
}
//# sourceMappingURL=errors.js.map