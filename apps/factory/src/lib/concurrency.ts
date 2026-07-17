/**
 * FS4 — optimistic concurrency, the EPO.1 precedent (D-6: `expectedUpdatedAt`
 * on order transitions) promoted to ONE shared helper. A route that edits a
 * row humans stare at accepts the caller's read stamp and refuses the write
 * with 409 when the row moved underneath them — same wording as the order
 * transition writer ("… changed elsewhere — refresh and retry") so every 409
 * reads identically across the app. The check is a pre-write read (human-
 * latency edits under SQLite's single writer — the race window is milliseconds
 * and the loser of THAT race still sees a correct final state, not a lost
 * update from a minutes-old form). Pure parts exported for unit tests; the
 * module deliberately does NOT import the db client.
 */

export const staleMessage = (entity: string): string =>
  `The ${entity} changed elsewhere — refresh and retry`;

/**
 * Null-aware stamp equality on millisecond epochs. `expected` comes back from
 * the client as the ISO string it was originally sent (JSON Date round-trip is
 * lossless at ms precision); an unparseable stamp NEVER matches (fail closed).
 */
export function stampMatches(
  current: Date | string | number | null,
  expected: Date | string | number | null,
): boolean {
  const ms = (v: Date | string | number | null): number | null => {
    if (v == null) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : Number.NaN; // NaN !== anything → stale
  };
  return ms(current) === ms(expected);
}

export type StaleCheck =
  | { ok: true }
  | { ok: false; status: 409; error: string };

type UpdatedAtDelegate = {
  findUnique(args: {
    where: { id: string };
    select: { updatedAt: true };
  }): Promise<{ updatedAt: Date } | null>;
};

/**
 * The shared guard: `assertNotStale(prisma.quote, id, body.expectedUpdatedAt,
 * "quote")`. An absent stamp (undefined/null) opts out — callers that never
 * learned the row's stamp (scripts, older UIs) keep working; a missing row
 * passes so the route's own 404 speaks with its usual message.
 */
export async function assertNotStale(
  delegate: UpdatedAtDelegate,
  id: string,
  expectedUpdatedAt: string | Date | null | undefined,
  entity = "record",
): Promise<StaleCheck> {
  if (expectedUpdatedAt == null) return { ok: true };
  const row = await delegate.findUnique({ where: { id }, select: { updatedAt: true } });
  if (!row) return { ok: true };
  return stampMatches(row.updatedAt, expectedUpdatedAt)
    ? { ok: true }
    : { ok: false, status: 409, error: staleMessage(entity) };
}
