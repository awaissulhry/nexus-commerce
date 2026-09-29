import { z } from 'zod'
import { AMAZON_ARCHIVE_MAX_FILES, AMAZON_ARCHIVE_MAX_SIZE, type AmazonArchiveKind } from '@nexus/shared/media-plan-archive'

/**
 * Images rebuild P4d — the Amazon ZIP window's words and the preview's shape. The server builds the list
 * (`GET /media/amazon-archive`); this file only checks the answer and says what it means, so the text is tested.
 * Seller Central's names are Amazon's own (checked 2026-09-28 in Amazon's seller-forum announcements; the help pages
 * need a login): "Catalog → Upload images" for the bulk upload, "Country-Specific Upload" in Image Manager for photos
 * one country shows. Since 2026-09-29 an Amazon market may have photos of its own ("Only DE" on the Media page): its
 * country ZIP holds every photo it shows, and it is the only way those photos reach Amazon.
 */

export const archivePreviewSchema = z.object({
  market: z.string(),
  kind: z.enum(['slots', 'safety', 'country']),
  language: z.string().nullable(),
  apiLanguage: z.string(),
  apiMarket: z.string(),
  /** The market has photos of its own (a row changed on "Only <market>"). Optional: an API before 2026-09-29. */
  ownPhotos: z.boolean().optional(),
  /** A country ZIP left empty because the market shows exactly what the API sends. */
  sameAsApi: z.boolean().optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  filename: z.string().min(1),
  issues: z.array(z.string()),
  warnings: z.array(z.string()),
  skipped: z.array(z.string()),
  files: z.array(z.object({ name: z.string(), asin: z.string(), slot: z.string(), skus: z.array(z.string()), assetId: z.string(), photo: z.string() })),
})
export type ArchivePreview = z.infer<typeof archivePreviewSchema>

/** The kinds as the Media page's switch names them: All Amazon markets (what the API sends), Only <market>. */
export function archiveKindLabel(kind: AmazonArchiveKind, market: string): string {
  return kind === 'slots' ? 'All Amazon markets' : kind === 'safety' ? 'Safety images' : `Only ${market}`
}

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
  const bulk = 'Upload it in Seller Central: Catalog → Upload images. Each file replaces the photo in the slot its name gives. This changes the global photos.'
  if (kind === 'safety') return {
    holds: `The safety images (PS01–PS06) on every ASIN of Amazon ${market}: one set for every Amazon market. Amazon’s API does not take them for every product type.`,
    upload: bulk,
  }
  if (kind === 'country') return {
    holds: `Every photo Amazon ${market} shows (MAIN, PT01–PT08, SWCH), as the Media page shows it on “Only ${market}”: the All Amazon markets photos, `
      + `the rows Amazon ${market} changed, and its ${languageName(language)} versions. It is the only way Amazon ${market}’s own photos reach Amazon.`,
    upload: `Upload it with the Country-Specific Upload in Image Manager: Catalog → Upload images, then choose ${countryName(market)} in the country list. `
      + `Amazon shows these photos on Amazon ${market} only, and you need an active listing there. Amazon does not promise to show them instead of the global photos. `
      + 'Do not use the normal upload for this ZIP: that changes the global photos.',
  }
  return {
    holds: `The All Amazon markets photos (MAIN, PT01–PT08, SWCH), named ASIN.SLOT.jpg: what Publish photos sends to every market of this account. `
      + `A photo in several languages is in its ${languageName(api.language)} version (the first market is Amazon ${api.market}). A market’s own photos and languages go in its “Only” ZIP.`,
    upload: bulk,
  }
}

/** The Download button while it works: making the ZIP on the server, then the file arriving ("120 of 504 MB"). */
export function busyLabel(progress: { received: number; total: number | null } | null): string {
  if (!progress) return 'Making the ZIP…'
  const mb = (bytes: number) => Math.floor(bytes / 1_000_000).toLocaleString('en-US')
  return progress.total ? `Downloading the ZIP… ${mb(progress.received)} of ${mb(progress.total)} MB` : `Downloading the ZIP… ${mb(progress.received)} MB`
}

/** "8 files · 3 ASINs · 2 SKUs left out" — or why there is nothing to download. */
export function archiveSummary(preview: ArchivePreview): string {
  const asins = new Set(preview.files.map(f => f.asin)).size
  const empty = preview.kind === 'country' && preview.sameAsApi
    ? `No photos for this ZIP: Amazon ${preview.market} shows the same photos as All Amazon markets, and Publish photos sends them`
    : 'No photos to put in this ZIP'
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
