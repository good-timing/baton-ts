/** True only for `{...}` literals and `Object.create(null)` — the TS
 * analogue of Python's `isinstance(value, dict)`. A class instance, `Date` or
 * `Map` is not one, as it is not a dict in Python. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** Any object but an array, class instances included. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
