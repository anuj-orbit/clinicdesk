const SNAKE = /^[a-z][a-z0-9_]*$/;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.name = "HttpError";
  }
}

/**
 * Subclasses accept either (code, message?) or (message).
 * A single snake_case argument is treated as the code, e.g.
 * new ConflictError("email_taken") → 409 {code:"email_taken"}.
 * A single free-text argument keeps the default code for the class.
 */
function codeAndMessage(defaultCode, a, b) {
  if (b !== undefined) return [a ?? defaultCode, b];
  if (a === undefined || a === null) return [defaultCode, defaultCode];
  if (SNAKE.test(String(a))) return [String(a), String(a).replace(/_/g, " ")];
  return [defaultCode, String(a)];
}

export class ValidationError extends HttpError {
  constructor(codeOrMessage, message) {
    super(400, ...codeAndMessage("validation", codeOrMessage, message));
    this.name = "ValidationError";
  }
}

export class AuthError extends HttpError {
  constructor(codeOrMessage, message) {
    super(401, ...codeAndMessage("unauthenticated", codeOrMessage, message));
    this.name = "AuthError";
  }
}

export class ForbiddenError extends HttpError {
  constructor(codeOrMessage, message) {
    super(403, ...codeAndMessage("forbidden", codeOrMessage, message));
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends HttpError {
  constructor(codeOrMessage, message) {
    super(404, ...codeAndMessage("not_found", codeOrMessage, message));
    this.name = "NotFoundError";
  }
}

export class ConflictError extends HttpError {
  constructor(codeOrMessage, message) {
    super(409, ...codeAndMessage("conflict", codeOrMessage, message));
    this.name = "ConflictError";
  }
}

/** Wraps an async handler so Express 4 forwards rejected promises. */
export function wrap(fn) {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(next);
  };
}

/** Maps HttpError → {error:{code,message}}; everything else → 500 internal (no stack leak). */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let httpErr = err instanceof HttpError ? err : null;
  if (!httpErr && err && err.type === "entity.parse.failed") {
    httpErr = new HttpError(400, "validation", "Malformed JSON body");
  } else if (!httpErr && err && err.type === "entity.too.large") {
    httpErr = new HttpError(413, "payload_too_large", "Request body too large");
  }

  if (httpErr) {
    return res.status(httpErr.status).json({ error: { code: httpErr.code, message: httpErr.message } });
  }

  console.error("500 internal error", { method: req.method, url: req.originalUrl, error: err && err.stack ? err.stack : String(err) });
  res.status(500).json({ error: { code: "internal", message: "Internal server error" } });
}
