/**
 * #758 — the ONE map from a prefixed channel write-field to the ChannelListing
 * COLUMN it lands in, and the gate that says which channel fields a writer
 * accepts at all.
 *
 * It was a `const` inside the bulk PATCH handler in `products.routes.ts`, so the
 * formula writer could not consult it and merged every channel key straight into
 * `overrideData` under its RAW name. The consequence was silent: a formula on
 * `amazon_title` wrote `overrideData.amazon_title`, a key nothing reads, while
 * the sheet reads the `title` COLUMN — the write "succeeded" and changed
 * nothing. Same wrong-store shape as #700's equality pass.
 *
 * A LEAF, importing nothing, so both the bulk writer and the formula writer can
 * read it without a cycle.
 *
 * ⚠ NOT the same map as `CHANNEL_WRITABLE` in `studio-sheet.service.ts`, and the
 * two are complementary rather than duplicates: that one is keyed by the SHEET
 * COLUMN key (`item_name` → `title`), this one by the WIRE field the write
 * endpoints receive (`amazon_title` → `title`). Both name the same listing
 * columns.
 */
export const CHANNEL_FIELD_MAP: Record<string, string> = {
  amazon_title: 'title',
  amazon_description: 'description',
  ebay_title: 'title',
  ebay_description: 'description',
  ebay_price: 'price',
  ebay_quantity: 'quantity',
  // VT.1 (2026-09-13, D-VT3) REMOVED `amazon_variationTheme` and `ebay_variationTheme`. CC.1 added them when the
  // variation theme was a sheet cell; it is now one engine-owned column with one writer
  // (`PATCH /studio/projection`), which validates the mapping against the included variants, refuses a SET change
  // on a live coordinate and reports collisions. This map has none of that, so keeping the entries would leave a
  // second path to the same store with none of the checks. The refusal is deliberate and loud: `isChannelWritable`
  // now returns false for both names, and the bulk PATCH answers "Field not editable" instead of writing.
  //
  // Measured before removing: **0 rows** of the 21 `ChannelListing.variationTheme` values on the local database
  // were written by this route in the audit trail, and the two raw sheet columns that used it are retired in
  // `channel-specs/{amazon,ebay}.ts` in the same change, so nothing on screen offers the field any more.
  // AM.1 — the master `bulletPoints` list on an Amazon scope writes the listing's OWN bullet array
  // (`bulletPointsOverride`, 512 of 725 listings already carry one). The write also sets
  // `followMasterBulletPoints = false`, because an override the listing still "follows master" past
  // is one the resolver and the feed ignore — see `FOLLOW_FLAG_FOR_COLUMN`.
  amazon_bulletPoints: 'bulletPointsOverride',
}

/**
 * Listing columns that are SSOT overrides: writing one breaks the follow relationship, or the value
 * written is never read (`attribute-resolver.ts` SSOT_FIELDS: follow=true ⇒ the override is skipped).
 * A set or pin disables the flag; a reset restores it and removes the saved override.
 */
export const FOLLOW_FLAG_FOR_COLUMN: Record<string, string> = {
  title: 'followMasterTitle',
  description: 'followMasterDescription',
  bulletPointsOverride: 'followMasterBulletPoints',
  price: 'followMasterPrice',
  quantity: 'followMasterQuantity',
}

/** TRUE when a field is a prefixed channel field this write layer maps to a column. */
export const isMappedChannelField = (f: string): boolean =>
  Object.prototype.hasOwnProperty.call(CHANNEL_FIELD_MAP, f)

/** `attr_*` fields merge into the `overrideData` bag under the stripped name. */
export const isChannelAttrField = (f: string): boolean => f.startsWith('attr_')

/**
 * The channel write gate: what the ordinary channel writer accepts. A mapped
 * field lands in its listing COLUMN; an `attr_*` field lands in the override
 * bag. Anything else is refused rather than written somewhere nothing reads.
 */
export const isChannelWritable = (f: string): boolean =>
  isMappedChannelField(f) || isChannelAttrField(f)

/** All historical names of a column-backed field, removed together when its override changes. */
export function channelOverrideKeys(field: string): string[] {
  const column = CHANNEL_FIELD_MAP[field]
  if (!column) return [field.replace(/^attr_/, '')]
  return [...new Set([column, field,
    ...(column === 'title' ? ['name', 'item_name'] : []),
    ...(column === 'bulletPointsOverride' ? ['bulletPoints', 'bullet_point'] : []),
  ])]
}
