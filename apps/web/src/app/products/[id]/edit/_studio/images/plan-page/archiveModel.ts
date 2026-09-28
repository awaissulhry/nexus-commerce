import { z } from 'zod'
import { AMAZON_ARCHIVE_MAX_FILES, AMAZON_ARCHIVE_MAX_SIZE, type AmazonArchiveKind } from '@nexus/shared/media-plan-archive'

/**
 * Images rebuild P4d — the Amazon ZIP window's words and the preview's shape. The server builds the list
 * (`GET /media/amazon-archive`); this file only checks the answer and says what it means, so the text is tested.
 * Seller Central's names are Amazon's own (checked 2026-09-28 in Amazon's seller-forum announcements; the help pages
 * need a login): "Catalog → Upload images" for the bulk upload, "Country-Specific Upload" in Image Manager for photos
 * one country shows.
 */

export const archivePreviewSchema = z.object({
  market: z.string(),
  kind: z.enum(['slots', 'safety', 'country']),
  language: z.string().nullable(),
  apiLanguage: z.string(),
  apiMarket: z.string(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  filename: z.string().min(1),
  issues: z.array(z.string()),
  warnings: z.array(z.string()),
  skipped: z.array(z.string()),
  files: z.array(z.object({ name: z.string(), asin: z.string(), slot: z.string(), skus: z.array(z.string()), assetId: z.string(), photo: z.string() })),
})
export type ArchivePreview = z.infer<typeof archivePreviewSchema>

export const ARCHIVE_KIND_LABEL: Record<AmazonArchiveKind, string> = { slots: 'All photos', safety: 'Safety images', country: 'Country photos' }

/** Nexus's own limits (Amazon takes up to 5 GB per upload); the server enforces them (`jpeg-archive.ts`). */
export const ARCHIVE_LIMITS = `Nexus makes a ZIP of at most ${AMAZON_ARCHIVE_MAX_FILES.toLocaleString('en-US')} files and ${AMAZON_ARCHIVE_MAX_SIZE}. Making it can take up to 90 seconds.`

/** "German" for `de`; the code itself when the browser does not know it. */
export function languageName(code: string | null): string {
  if (!code) return 'its language'
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code.toUpperCase() } catch { return code.toUpperCase() }
}

/** "Germany" for `DE` (Amazon's country list); UK is GB for the browser. */
export function countryName(market: string): string {
  const code = market.toUpperCase() === 'UK' ? 'GB' : market.toUpperCase()
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? market } catch { return market }
}

/**
 * What the chosen kind holds, and where in Seller Central it goes (PLAN.md §7.1). `apiLanguage` is the version the API
 * sends to every market of the account: the language of its first market (`apiMarket`, the one with the most listings).
 */
export function archiveKindHint(kind: AmazonArchiveKind, market: string, language: string | null, api: { language: string | null; market: string }): { holds: string; upload: string } {
  const bulk = 'Upload it in Seller Central: Catalog → Upload images. Each file replaces the photo in the slot its name gives.'
  if (kind === 'safety') return {
    holds: `The safety images (PS01–PS06) on every ASIN of Amazon ${market}. Amazon’s API does not take them for every product type.`,
    upload: bulk,
  }
  if (kind === 'country') return {
    holds: language && language === api.language
      ? `The API already sends the ${languageName(language)} versions to every market of this account, so Amazon ${market} needs no country photos.`
      : `Only the ${languageName(language)} versions of photos in several languages, such as a size chart. The API sends the ${languageName(api.language)} versions; the other photos do not change.`,
    upload: `Upload it with the Country-Specific Upload in Image Manager: Catalog → Upload images, then choose ${countryName(market)} in the country list. `
      + `Amazon shows these photos on Amazon ${market} only, and you need an active listing there. Amazon does not promise to show them instead of the global photos. `
      + 'Do not use the normal upload for this ZIP: that changes the global photos.',
  }
  return {
    holds: `Every photo the plan gives Amazon (MAIN, PT01–PT08, SWCH), named ASIN.SLOT.jpg. A photo in several languages is in its ${languageName(api.language)} version: `
      + `the API sends that version to every market of this account (its first market is Amazon ${api.market}). Other languages go in Country photos.`,
    upload: bulk,
  }
}

/** "8 files · 3 ASINs · 2 SKUs left out" — or why there is nothing to download. */
export function archiveSummary(preview: ArchivePreview): string {
  const asins = new Set(preview.files.map(f => f.asin)).size
  const empty = preview.kind !== 'country' ? 'No photos to put in this ZIP'
    : preview.language === preview.apiLanguage ? `No photos for this ZIP: the API already sends the ${languageName(preview.language)} versions to Amazon ${preview.market}`
      : `No photos for this ZIP: no photo on these ASINs has a version in ${languageName(preview.language)}`
  const parts = preview.files.length ? [`${preview.files.length} file${preview.files.length === 1 ? '' : 's'}`, `${asins} ASIN${asins === 1 ? '' : 's'}`] : [empty]
  if (preview.skipped.length) parts.push(`${preview.skipped.length} SKU${preview.skipped.length === 1 ? '' : 's'} left out`)
  return parts.join(' · ')
}

/** The files by ASIN, in the preview's order, for the list in the window. */
export function filesByAsin(files: ArchivePreview['files']): Array<{ asin: string; skus: string[]; files: ArchivePreview['files'] }> {
  const groups = new Map<string, { asin: string; skus: string[]; files: ArchivePreview['files'] }>()
  for (const file of files) {
    const group = groups.get(file.asin) ?? { asin: file.asin, skus: [], files: [] }
    group.files.push(file)
    for (const sku of file.skus) if (!group.skus.includes(sku)) group.skus.push(sku)
    groups.set(file.asin, group)
  }
  return [...groups.values()]
}
