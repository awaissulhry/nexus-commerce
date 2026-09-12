/**
 * PES.7 — the DAM library's id prefixes.
 *
 * 🔴 `GET /assets/library` returns a MERGED view of two tables and prefixes the ids to say which
 * it came from: `da_<id>` for a `DigitalAsset`, `pi_<id>` for a `ProductImage` belonging to some
 * other product (assets.routes.ts:574,605). `POST /images/import-from-dam` takes a RAW
 * `DigitalAsset.id` and does a plain `findUnique` on it — no prefix handling.
 *
 * Measured on prod 2026-09-01: posting the id the library hands out returns
 * **404 ASSET_NOT_FOUND**; the same id with `da_` stripped returns **201 Created**. The shipped
 * picker in `tabs/images/DamPickerModal.tsx` posts `asset.id` unmodified, so importing from the DAM
 * fails every time. Reported to the hub; this module is why the rebuild does not repeat it.
 */

export type AssetSource = 'digital_asset' | 'product_image'

/** Which table a library id came from, or null when it carries no known prefix. */
export function assetSource(libraryId: string): AssetSource | null {
  if (libraryId.startsWith('da_')) return 'digital_asset'
  if (libraryId.startsWith('pi_')) return 'product_image'
  return null
}

/**
 * The raw `DigitalAsset.id` to send to `import-from-dam`, or null when this row is not a
 * DigitalAsset and therefore cannot be imported through that route.
 *
 * Returning null rather than a best guess is deliberate: a `pi_` row is another product's image and
 * there is no endpoint that imports one, so the caller must say so rather than send an id that will
 * 404.
 */
export function importableAssetId(libraryId: string): string | null {
  return libraryId.startsWith('da_') ? libraryId.slice(3) : null
}
