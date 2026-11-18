/** Builds an HttpError subclass instance with a specific machine-readable code. */
export function coded(Cls, code, message = code) {
  const err = new Cls(message);
  err.code = code;
  return err;
}
