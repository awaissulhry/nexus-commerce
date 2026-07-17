/**
 * FS4 — mention-handle derivation, pure (S-10). `User.handle` is the indexed
 * @mention key: `first.last` derived from the display name, EXACTLY the rule
 * the FS3 client already inserts (src/lib/virtual/mention.ts `handleFor` —
 * trim · lowercase · whitespace→dots), so an autocompleted mention is
 * guaranteed to hit the indexed lookup. Collisions suffix -2, -3… in
 * first-come order (the migration backfill mirrors this with a window
 * function). Assignment lives in team-service (create / invite-accept /
 * rename); this module stays pure so derivation is unit-testable.
 */

/** "Ada  Lovelace " → "ada.lovelace"; an empty/whitespace name derives nothing. */
export function deriveHandle(displayName: string): string | null {
  const handle = displayName.trim().toLowerCase().replace(/\s+/g, ".");
  return handle || null;
}

/** First free candidate: base, base-2, base-3… against the taken set. */
export function uniqueHandle(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
