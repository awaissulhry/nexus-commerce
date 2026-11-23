/**
 * What a person can READ of an answer, a row or an event, as one text — for a wall test that looks for a figure anywhere in it:
 *
 *   expect(readableText(rows)).not.toMatch(/399|420/)
 *
 * Every key and every value stays, in JSON's own order; only the generated ids (UUIDs) and the times (ISO instants) are taken out.
 * A UUID is random hex and a time carries its own digits, so "399" may stand in one by chance: a "no amount" check over
 * `JSON.stringify(rows)` then fails for a user id that ends "…88e2939977b7" (cw-fx9, the end check's flake). An id or a time is never
 * where a person reads an amount, so the check keeps its strength: an amount in any word, label, parameter or number still fails it.
 * A plain day ("2026-12-04") is readable text and stays.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g

export function readableText(value: unknown): string {
  return (JSON.stringify(value) ?? '').replace(UUID, '<id>').replace(INSTANT, '<time>')
}
