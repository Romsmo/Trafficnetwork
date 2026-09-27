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
