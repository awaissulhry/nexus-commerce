/**
 * FF1.7 — Row fingerprinting for deterministic change detection.
 *
 * Produces a 16-hex-char sha256 digest of `sku|scope|json(fields)`.
 * The JSON serializer receives a sorted key array as the replacer so
 * the output is stable regardless of the insertion order of `fields`.
 */
import { createHash } from 'node:crypto'

/**
 * Compute a short, stable fingerprint for a single workbook row.
 *
 * @param sku    - The SKU that identifies the row.
 * @param scope  - Channel scope string, e.g. 'MASTER', 'AMAZON', 'EBAY'.
 * @param fields - Field values for the row (key order does NOT matter).
 * @returns 16 lowercase hex characters (first 64 bits of SHA-256).
 */
export function rowFingerprint(
  sku: string,
  scope: string,
  fields: Record<string, unknown>,
): string {
  // Pass sorted key array as JSON.stringify replacer — this guarantees the
  // same JSON string regardless of JS object property insertion order.
  const sortedKeys = Object.keys(fields).sort()
  return createHash('sha256')
    .update(`${sku}|${scope}|${JSON.stringify(fields, sortedKeys)}`)
    .digest('hex')
    .slice(0, 16)
}
