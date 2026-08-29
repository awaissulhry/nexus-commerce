/**
 * MS.7 — putting a channel field back under the master's control.
 *
 * `docs/2026-08-29-master-sheet-design.md` §16. This closes the one genuinely missing route in the
 * master-sheet work: `PATCH /products/:id/channel-pricing` PINS a field when a price is written
 * (`followMasterPrice = false`) and explicitly ignores `price: null`, so nothing anywhere could set
 * a follow flag back to `true`. Inheritance was a one-way door — an operator could break it by
 * accident and had no way back — which is why MS.6 shipped read-only.
 *
 * What flipping a flag does, precisely, because the distinction matters:
 *   `follows: true`  — the MASTER becomes the source for that field again. The channel's own value
 *                      is left in place (see below); nothing is sent anywhere. The live listing only
 *                      changes on the next publish.
 *   `follows: false` — the channel keeps whatever it is carrying, and the master stops driving it.
 *
 * **The channel's value is never destroyed.** For price/quantity/title/description the pinned value
 * often lives in the DIRECT column (`price`, `title`), not in `*Override` — rows predating the Phase
 * 20 SSOT split store it there, and `attribute-resolver.ts` falls back to it. That column is also
 * what the channel is actually carrying right now. Clearing it to "tidy up" would erase the record of
 * a live listing's real price. So following the master again clears only the explicit `*Override`,
 * and the direct column stays as the truthful record of what is live.
 */

/** The six fields that carry a follow flag. JSONB attributes have none — see the design doc §5. */
export const FOLLOWABLE_FIELDS = ['title', 'description', 'price', 'quantity', 'images', 'bulletPoints'] as const
export type FollowableField = (typeof FOLLOWABLE_FIELDS)[number]

interface FieldColumns {
  flag: string
  /** The explicit override column, cleared when the master takes over again. Null = none exists. */
  override: string | null
}

const FIELD_COLUMNS: Record<FollowableField, FieldColumns> = {
  title: { flag: 'followMasterTitle', override: 'titleOverride' },
  description: { flag: 'followMasterDescription', override: 'descriptionOverride' },
  price: { flag: 'followMasterPrice', override: 'priceOverride' },
  quantity: { flag: 'followMasterQuantity', override: 'quantityOverride' },
  bulletPoints: { flag: 'followMasterBulletPoints', override: 'bulletPointsOverride' },
  // Images have a follow flag but no override column — the gallery is a relation, not a scalar.
  images: { flag: 'followMasterImages', override: null },
}

export const isFollowableField = (v: unknown): v is FollowableField =>
  typeof v === 'string' && (FOLLOWABLE_FIELDS as readonly string[]).includes(v)

/**
 * The Prisma `data` for one flag change. PURE — the shape is the whole contract, so it is asserted
 * directly rather than through a database.
 */
export function followUpdateData(field: FollowableField, follows: boolean): Record<string, unknown> {
  const cols = FIELD_COLUMNS[field]
  const data: Record<string, unknown> = { [cols.flag]: follows }
  // Handing the field back to the master clears the EXPLICIT override only. The direct column is
  // what the channel is carrying and is not ours to erase.
  if (follows && cols.override) data[cols.override] = null
  return data
}

/** Which fields a listing has pinned, for reporting back what actually changed. */
export function pinnedFields(listing: Record<string, unknown>): FollowableField[] {
  return FOLLOWABLE_FIELDS.filter((f) => listing[FIELD_COLUMNS[f].flag] === false)
}

export const followFlagColumn = (field: FollowableField): string => FIELD_COLUMNS[field].flag
export const overrideColumn = (field: FollowableField): string | null => FIELD_COLUMNS[field].override
