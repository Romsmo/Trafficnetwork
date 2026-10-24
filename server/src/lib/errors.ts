export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, "BAD_REQUEST", message, details);
}

export function unauthorized(message = "Unauthorized"): ApiError {
  return new ApiError(401, "UNAUTHORIZED", message);
}

export function forbidden(message = "Forbidden"): ApiError {
  return new ApiError(403, "FORBIDDEN", message);
}

export function notFound(message = "Not found"): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

export function conflict(code: string, message: string, details?: unknown): ApiError {
  return new ApiError(409, code, message, details);
}

/** Well-formed request the server understood but will not act on (semantic validation) — `code` is machine-readable for clients. */
export function unprocessable(code: string, message: string, details?: unknown): ApiError {
  return new ApiError(422, code, message, details);
}

export function tooManyRequests(message = "Too many requests"): ApiError {
  return new ApiError(429, "TOO_MANY_REQUESTS", message);
}

/**
 * Join codes (docs/join-code.md). The app key behind a join code answers with these instead of the generic credential errors, so
 * an app can tell its user what happened. They are only ever sent after the code's secret was proven (token) or the token was
 * valid (register) - never to a stranger probing client ids.
 */
export const joinCodeRevoked = () => new ApiError(401, "join_code_revoked", "This join code has been revoked. Ask the operator for a current one.");
export const joinCodeExpired = () => new ApiError(401, "join_code_expired", "This join code has expired. Ask the operator for a current one.");
export const joinCodeExhausted = () => new ApiError(403, "join_code_exhausted", "This join code has reached the number of registrations it allows.");
export const joinCodeRateLimited = () => new ApiError(429, "join_code_rate_limited", "Too many registrations with this join code today. Try again later.");
