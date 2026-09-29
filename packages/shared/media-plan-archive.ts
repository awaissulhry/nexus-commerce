import { AMAZON_SLOTS, MEDIA_LIMITS, type AmazonMediaLayout, type MediaAsset } from './media-plan-channels.js'

/**
 * Images rebuild P4d — the ZIP files Seller Central takes (PLAN.md §7.1), from the photo plan's Amazon layout. Amazon
 * reads the file name: `ASIN.SLOT.jpg`. Three kinds:
 *  - `slots`   every photo the API would send to every market (MAIN, PT01–PT08, SWCH: "All Amazon markets") — for the
 *              bulk upload;
 *  - `safety`  the safety images (PS01–PS06) — Amazon's API cannot always take them;
 *  - `country` every photo one market shows (MAIN, PT01–PT08, SWCH), exactly as the Media page shows it for that market:
 *              the All-markets photos, the rows the market changed, its language versions (2026-09-29, the Owner's
 *              option 3) — for Image Manager's Country-Specific Upload, which shows them to that market's buyers only.
 *              When the market shows exactly what the API sends, no country ZIP is needed: it stays empty (`sameAsApi`).
 * Pure: the preview and the download build the same list, and a fingerprint of it binds the download to the preview.
 * The checks are the Media page's own words, limited to what this ZIP holds on this market: `issues` stop the
 * download (the same errors stop Publish), `warnings` are shown.
 */

export type AmazonArchiveKind = 'slots' | 'safety' | 'country'
export const AMAZON_ARCHIVE_KINDS: readonly AmazonArchiveKind[] = ['slots', 'safety', 'country']
export const AMAZON_ARCHIVE_MAX_FILES = 1000
/** Nexus's own size limit (Amazon takes up to 5 GB per upload). A photo counts once per file it fills. The Owner chose
 *  1 GB on 2026-09-28: 100 MB stopped GALE-JACKET's 182-file ZIP; the API has 8 GB and a ZIP is held for seconds. */
export const AMAZON_ARCHIVE_MAX_BYTES = 1024 ** 3
export const AMAZON_ARCHIVE_MAX_SIZE = '1 GB'
const ASIN = /^[A-Z0-9]{10}$/
const SLOTS = [...AMAZON_SLOTS, 'SWCH'] as const

export interface AmazonArchiveFile { name: string; assetId: string; asin: string; slot: string; skus: string[] }
export interface AmazonArchivePlan { files: AmazonArchiveFile[]; issues: string[]; warnings: string[]; skipped: string[]; sameAsApi: boolean }

export function planAmazonArchive(input: {
  kind: AmazonArchiveKind
  /** The market code, for the sentences (`DE`). */
  market: string
  /** The layout this ZIP holds: what the API sends (`slots`, `safety`), or what the market shows (`country`). */
  layout: Pick<AmazonMediaLayout, 'parent' | 'items' | 'safety' | 'checks'>
  assets: ReadonlyMap<string, MediaAsset>
  /** A product's listing on this market and account: its ASIN (null = none yet), or null when it is not listed there. */
  listingOf(productId: string): { asin: string | null } | null
  /** `country` only: what the API sends to every market. A country ZIP that holds just that is not made. */
  api?: Pick<AmazonMediaLayout, 'parent' | 'items'>
}): AmazonArchivePlan {
  const rows = [...(input.layout.parent ? [input.layout.parent] : []), ...input.layout.items]
  const byName = new Map<string, AmazonArchiveFile>()
  const issues: string[] = [], warnings: string[] = [], skipped: string[] = []
  const label = (id: string) => input.assets.get(id)?.label ?? 'a photo'
  const add = (asin: string, slot: string, assetId: string, sku: string) => {
    const name = `${asin}.${slot}.jpg`
    const seen = byName.get(name)
    if (!seen) { byName.set(name, { name, assetId, asin, slot, skus: [sku] }); return }
    if (seen.assetId === assetId) { if (!seen.skus.includes(sku)) seen.skus.push(sku); return }
    issues.push(`${asin} ${slot}: ${seen.skus[0]} and ${sku} share this ASIN but get different photos. Give them the same photos first.`)
  }
  if (input.kind === 'safety' && input.layout.safety.length > MEDIA_LIMITS.AMAZON.safety)
    issues.push(`Safety has ${input.layout.safety.length} photos; Amazon allows ${MEDIA_LIMITS.AMAZON.safety} (PS01–PS06).`)
  for (const row of rows) {
    const listing = input.listingOf(row.productId)
    const asin = listing?.asin?.trim().toUpperCase() ?? ''
    if (!listing) { skipped.push(`${row.sku}: not listed on Amazon ${input.market} — left out.`); continue }
    if (!asin) { skipped.push(`${row.sku}: its Amazon ${input.market} listing has no ASIN yet — left out.`); continue }
    if (!ASIN.test(asin)) { skipped.push(`${row.sku}: its Amazon ${input.market} listing holds "${listing.asin}", which is not an ASIN — left out.`); continue }
    if (input.kind === 'safety') { input.layout.safety.slice(0, MEDIA_LIMITS.AMAZON.safety).forEach((id, i) => add(asin, `PS0${i + 1}`, id, row.sku)); continue }
    if (!row.slots.MAIN) issues.push(`${row.sku} has no MAIN photo.`)
    if (row.cut.length) warnings.push(`${row.sku}: Amazon shows 9 photos — ${row.cut.length} do not fit: ${row.cut.map(label).join(', ')}.`)
    for (const slot of SLOTS) {
      const id = row.slots[slot]
      if (id) add(asin, slot, id, row.sku)
    }
  }
  let files = [...byName.values()]
  // A market that shows exactly what the API sends needs no country photos: an upload would only pin today's photos there.
  const sameAsApi = input.kind === 'country' && !!input.api && !issues.length && sameFiles(files, planAmazonArchive({ ...input, kind: 'slots', layout: { ...input.api, safety: [], checks: [] } }).files, input.assets)
  if (sameAsApi) files = []
  // Photo sizes, per photo in this ZIP (a country version is a file of its own, never checked elsewhere).
  if (input.kind !== 'safety') for (const id of new Set(files.map(f => f.assetId))) {
    const asset = input.assets.get(id)
    if (!asset || asset.width == null || asset.height == null) continue
    const edge = Math.max(asset.width, asset.height)
    if (edge < MEDIA_LIMITS.AMAZON.minLongEdge) issues.push(`${label(id)} is ${edge} px — Amazon needs ${MEDIA_LIMITS.AMAZON.minLongEdge} px.`)
    else if (edge < MEDIA_LIMITS.AMAZON.zoomLongEdge) warnings.push(`${label(id)} is ${edge} px — buyers cannot zoom below ${MEDIA_LIMITS.AMAZON.zoomLongEdge} px.`)
  }
  // The plan's set checks (a deleted photo, a photo shown in another language) for the sets this kind reads.
  if (!sameAsApi) for (const check of input.layout.checks) {
    if (check.code !== 'missing-photo' && check.code !== 'language-fallback') continue
    if ((check.set === 'safety') !== (input.kind === 'safety')) continue
    // The page shows this one on its set ("this set"); here it needs the place.
    if (check.code === 'missing-photo') issues.push(`A photo in ${input.kind === 'safety' ? 'Safety' : 'the plan'} was deleted from the library. Remove it on the Media page, or add it again.`)
    else (check.severity === 'error' ? issues : warnings).push(check.message)
  }
  if (files.length > AMAZON_ARCHIVE_MAX_FILES)
    issues.push(`This ZIP would hold ${files.length.toLocaleString('en-US')} files; Nexus makes at most ${AMAZON_ARCHIVE_MAX_FILES.toLocaleString('en-US')} in one ZIP.`)
  return { files, issues: [...new Set(issues)], warnings: sameAsApi ? [] : [...new Set(warnings)], skipped, sameAsApi }
}

/** The same file names holding the same pictures (a copy of a photo on another SKU is the same picture). */
function sameFiles(a: readonly AmazonArchiveFile[], b: readonly AmazonArchiveFile[], assets: ReadonlyMap<string, MediaAsset>) {
  const url = (id: string) => assets.get(id)?.url ?? id
  const list = (files: readonly AmazonArchiveFile[]) => files.map(f => `${f.name}=${url(f.assetId)}`).sort().join('\n')
  return list(a) === list(b)
}
