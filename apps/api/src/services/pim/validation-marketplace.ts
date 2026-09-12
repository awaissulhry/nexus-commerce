/**
 * PES.5 / #569 — which marketplace's registry a write validates against.
 *
 * `marketplaceContexts` serves TWO purposes that had been collapsed into one
 * list, and the collapse made master attribute writes impossible:
 *
 *   1. **fan-out targets** for a CHANNEL write — needs `channel` AND
 *      `marketplace`, and the route filters accordingly;
 *   2. **the marketplace naming the registry** to validate an `attr_*` field
 *      against — needs only the marketplace.
 *
 * A master scope has no channel, so the correct context it sends
 * (`{ marketplace: "DE", locale: "de" }`) was dropped by the channel filter,
 * `primaryContext` became null, and `getFieldDefinition` fell back to the static
 * list where **60 of 60 master `attr_*` columns refuse**. That is the Owner's
 * "unable to write a lot of attributes such as color".
 *
 * So this reads the marketplace BEFORE any channel filter. Pure and exported so
 * a writability gate can run the SAME function the route runs — a gate that
 * reimplements this would drift from it, and the drift shows up as a cell the UI
 * says is writable and the API refuses.
 */
export function validationMarketplace(
  rawContexts: ReadonlyArray<{ channel?: unknown; marketplace?: unknown } | null | undefined> | null | undefined,
): string | null {
  if (!Array.isArray(rawContexts)) return null
  for (const c of rawContexts) {
    const mk = c?.marketplace
    if (typeof mk === 'string' && mk.trim()) return mk.trim().toUpperCase()
  }
  return null
}
