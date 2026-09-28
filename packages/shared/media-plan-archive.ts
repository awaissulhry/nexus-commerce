import { AMAZON_SLOTS, MEDIA_LIMITS, type AmazonMediaLayout, type MediaAsset } from './media-plan-channels.js'

/**
 * Images rebuild P4d — the ZIP files Seller Central takes (PLAN.md §7.1), from the photo plan's Amazon layout. Amazon
 * reads the file name: `ASIN.SLOT.jpg`. Three kinds:
 *  - `slots`   every photo the API would send (MAIN, PT01–PT08, SWCH) — for Image Manager's bulk upload;
 *  - `safety`  the safety images (PS01–PS06) — Amazon's API cannot always take them;
 *  - `country` only the photos that have a version in this market's language (a size chart in German for DE) — for
 *              Image Manager's Country-Specific Upload, which shows them to that market's buyers only.
 * Pure: the preview and the download build the same list, and a fingerprint of it binds the download to the preview.
 * The checks are the Media page's own words, limited to what this ZIP holds on this market: `issues` stop the
 * download (the same errors stop Publish), `warnings` are shown.
 */

export type AmazonArchiveKind = 'slots' | 'safety' | 'country'
export const AMAZON_ARCHIVE_KINDS: readonly AmazonArchiveKind[] = ['slots', 'safety', 'country']
export const AMAZON_ARCHIVE_MAX_FILES = 1000
const ASIN = /^[A-Z0-9]{10}$/
const SLOTS = [...AMAZON_SLOTS, 'SWCH'] as const

export interface AmazonArchiveFile { name: string; assetId: string; asin: string; slot: string; skus: string[] }
export interface AmazonArchivePlan { files: AmazonArchiveFile[]; issues: string[]; warnings: string[]; skipped: string[] }

export function planAmazonArchive(input: {
  kind: AmazonArchiveKind
  /** The market code, for the sentences (`DE`). */
  market: string
  layout: Pick<AmazonMediaLayout, 'parent' | 'items' | 'safety' | 'checks'>
  assets: ReadonlyMap<string, MediaAsset>
  /** A product's listing on this market and account: its ASIN (null = none yet), or null when it is not listed there. */
  listingOf(productId: string): { asin: string | null } | null
  /** The market's language — `country` only. */
  language?: string
}): AmazonArchivePlan {
  const rows = [...(input.layout.parent ? [input.layout.parent] : []), ...input.layout.items]
  const byName = new Map<string, AmazonArchiveFile>()
  const issues: string[] = [], warnings: string[] = [], skipped: string[] = []
  const label = (id: string) => input.assets.get(id)?.label ?? 'a photo'
  const versionIn = (id: string, language: string) => {
    const placed = input.assets.get(id)
    if (!placed?.versionGroupId) return null
    const hit = [...input.assets.values()].find(a => a.versionGroupId === placed.versionGroupId && a.languageTag === language)
    return hit && hit.id !== id ? hit.id : null
  }
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
    if (input.kind === 'slots') {
      if (!row.slots.MAIN) issues.push(`${row.sku} has no MAIN photo.`)
      if (row.cut.length) warnings.push(`${row.sku}: Amazon shows 9 photos — ${row.cut.length} do not fit: ${row.cut.map(label).join(', ')}.`)
    }
    for (const slot of SLOTS) {
      const id = row.slots[slot]
      if (!id) continue
      if (input.kind === 'slots') add(asin, slot, id, row.sku)
      else if (input.language) { const version = versionIn(id, input.language); if (version) add(asin, slot, version, row.sku) }
    }
  }
  const files = [...byName.values()]
  // Photo sizes, per photo in this ZIP (a country version is a file of its own, never checked elsewhere).
  if (input.kind !== 'safety') for (const id of new Set(files.map(f => f.assetId))) {
    const asset = input.assets.get(id)
    if (!asset || asset.width == null || asset.height == null) continue
    const edge = Math.max(asset.width, asset.height)
    if (edge < MEDIA_LIMITS.AMAZON.minLongEdge) issues.push(`${label(id)} is ${edge} px — Amazon needs ${MEDIA_LIMITS.AMAZON.minLongEdge} px.`)
    else if (edge < MEDIA_LIMITS.AMAZON.zoomLongEdge) warnings.push(`${label(id)} is ${edge} px — buyers cannot zoom below ${MEDIA_LIMITS.AMAZON.zoomLongEdge} px.`)
  }
  // The plan's set checks (a deleted photo, a photo shown in another language) for the sets this kind reads.
  if (input.kind !== 'country') for (const check of input.layout.checks) {
    if (check.code !== 'missing-photo' && check.code !== 'language-fallback') continue
    if ((check.set === 'safety') !== (input.kind === 'safety')) continue
    // The page shows this one on its set ("this set"); here it needs the place.
    if (check.code === 'missing-photo') issues.push(`A photo in ${input.kind === 'safety' ? 'Safety' : 'the plan'} was deleted from the library. Remove it on the Media page, or add it again.`)
    else (check.severity === 'error' ? issues : warnings).push(check.message)
  }
  if (files.length > AMAZON_ARCHIVE_MAX_FILES)
    issues.push(`This ZIP would hold ${files.length.toLocaleString('en-US')} files; Nexus makes at most ${AMAZON_ARCHIVE_MAX_FILES.toLocaleString('en-US')} in one ZIP.`)
  return { files, issues: [...new Set(issues)], warnings: [...new Set(warnings)], skipped }
}
