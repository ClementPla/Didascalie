/**
 * Structural equality of JSON-like values (primitives, arrays, plain objects),
 * as comparing their `JSON.stringify` would decide, without building the
 * strings. A key holding `undefined` counts as absent.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    // NaN, like JSON (which writes null for it).
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], other[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined);
  const ak = keys(ao);
  if (ak.length !== keys(bo).length) return false;
  return ak.every((k) => jsonEqual(ao[k], bo[k]));
}
