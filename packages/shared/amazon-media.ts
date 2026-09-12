import { z } from 'zod'

export const amazonImageSlots = [
  { code: 'MAIN', attribute: 'main_product_image_locator', label: 'Main image' },
  ...Array.from({ length: 8 }, (_, i) => ({ code: `PT${String(i + 1).padStart(2, '0')}`, attribute: `other_product_image_locator_${i + 1}`, label: `Additional image ${i + 1}` })),
  { code: 'SWCH', attribute: 'swatch_product_image_locator', label: 'Variation swatch' },
] as const
/** Seller Central Image Manager only; never map these to invented API attributes. */
export const amazonSafetyImageSlots = Array.from({ length: 6 }, (_, i) => ({ code: `PS${String(i + 1).padStart(2, '0')}`, label: `Safety image ${i + 1}` }))
export const amazonManagedImageSlots = [...amazonImageSlots, ...amazonSafetyImageSlots]
export type AmazonImageSection = 'gallery' | 'safety'
export const amazonSlotsForSection = (section: AmazonImageSection) => section === 'safety' ? amazonSafetyImageSlots : amazonImageSlots

export const imageAssignmentSchema = z.object({ assetId: z.string().min(1), language: z.string().min(1) }).strict()
export const imageSlotsSchema = z.record(z.string(), imageAssignmentSchema.nullable())
export const amazonMediaDraftSchema = z.object({ common: imageSlotsSchema, items: z.record(z.string(), imageSlotsSchema) }).strict()
export type ImageAssignment = z.infer<typeof imageAssignmentSchema>
export type ImageSlots = z.infer<typeof imageSlotsSchema>
export type AmazonMediaDraft = z.infer<typeof amazonMediaDraftSchema>
export interface AmazonMediaAsset { id: string; url: string; label: string; width: number | null; height: number | null; origin: 'product' | 'saved-gallery' }
export interface AmazonMediaItem {
  id: string; productId: string; sku: string; asin: string | null; label: string; parent: boolean
  productType: string | null; theme: string | null; attributes: Record<string, string>
}
export interface AmazonMediaObservation {
  checkedAt: string; error: string | null; asin: string | null; productType: string | null
  theme: string | null; attributes: Record<string, string>; slots: Record<string, string>
  catalog: Array<{ slot: string; url: string; width: number; height: number }>
  catalogError: string | null; issues: Array<{ code: string; message: string; severity: string }>
  supported: string[]
}
export interface AmazonMediaWorkspace {
  productId: string; revision: string; draft: AmazonMediaDraft; assets: AmazonMediaAsset[]; items: AmazonMediaItem[]
  destination: { accountId: string; marketplace: string; listingId: string; aliasKey: string; label: string; listings: Array<{ id: string; label: string }> }
  languages: string[]; markets: Array<{ code: string; label: string }>; warnings: string[]; observations: Record<string, AmazonMediaObservation>; activeRunId: string | null
}
export interface AmazonMediaPatch { op: 'replace' | 'delete'; path: string; value: Array<Record<string, unknown>> }
export interface AmazonMediaPlanItem {
  listingId: string; sku: string; asin: string; productType: string
  desired: Record<string, string>; before: Record<string, string>; patches: AmazonMediaPatch[]
  changes: Array<{ slot: string; before: string | null; after: string | null }>
  issues: string[]
}
export interface AmazonMediaReceipt {
  listingId: string; status: 'NOT_SENT' | 'SENDING' | 'ACCEPTED' | 'REJECTED' | 'UNKNOWN' | 'UNCHANGED'
  submissionId?: string; message?: string
}
export interface AmazonMediaRun {
  id: string; status: string; createdAt: string; revision: string; items: AmazonMediaPlanItem[]; receipts: AmazonMediaReceipt[]
}

/** Missing means inherit; null is an explicit empty slot and stops inheritance. */
export function effectiveImageSlots(draft: AmazonMediaDraft, id: string): ImageSlots {
  return { ...draft.common, ...draft.items[id] }
}
export function imageDraftFingerprint(draft: AmazonMediaDraft): string {
  const sort = (slots: ImageSlots) => Object.entries(slots).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([sort(draft.common), Object.entries(draft.items).filter(([, s]) => Object.keys(s).length).sort(([a], [b]) => a.localeCompare(b)).map(([id, slots]) => [id, sort(slots)])])
}
export function inspectAmazonImages(slots: ImageSlots, assets: AmazonMediaAsset[], languages: string[]): string[] {
  const problems: string[] = []
  if (!slots.MAIN) problems.push('A main image is required.')
  const seen = new Set<string>()
  for (const [code, assignment] of Object.entries(slots)) {
    if (!amazonImageSlots.some(s => s.code === code)) { problems.push(`Unsupported gallery slot: ${code}.`); continue }
    if (!assignment) continue
    const asset = assets.find(a => a.id === assignment.assetId)
    if (!asset) { problems.push(`${code}: source image is unavailable.`); continue }
    if (!publicImageUrl(asset.url)) problems.push(`${code}: use a publicly accessible HTTPS image URL.`)
    if (assignment.language !== 'zxx' && !languages.includes(assignment.language)) problems.push(`${code}: confirm the image language for this market.`)
    if (seen.has(asset.url) && code !== 'SWCH') problems.push(`${code}: this photo already appears in the gallery.`)
    if (code !== 'SWCH') seen.add(asset.url)
  }
  return problems
}
export function publicImageUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.port && u.hostname.includes('.')
      && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname)
      && !/\.(local|internal|localhost)$/i.test(u.hostname) && !u.hostname.includes(':')
  } catch { return false }
}
export function buildImagePatches(desired: Record<string, string>, current: Record<string, string>, supported: string[], marketplaceId: string): { patches: AmazonMediaPatch[]; changes: AmazonMediaPlanItem['changes'] } {
  const patches: AmazonMediaPatch[] = []; const changes: AmazonMediaPlanItem['changes'] = []
  for (const slot of amazonImageSlots) {
    if (!supported.includes(slot.code)) continue
    const before = current[slot.code] || null; const after = desired[slot.code] || null
    if (before === after) continue
    changes.push({ slot: slot.code, before, after })
    patches.push({ op: after ? 'replace' : 'delete', path: `/attributes/${slot.attribute}`,
      value: [after ? { marketplace_id: marketplaceId, media_location: after } : { marketplace_id: marketplaceId, media_location: before! }] })
  }
  return { patches, changes }
}
export function imageContributionMatches(desired: Record<string, string>, observed: AmazonMediaObservation): boolean {
  return !observed.error && amazonImageSlots.every(s => (desired[s.code] || null) === (observed.slots[s.code] || null))
}
/** URL identity only. A transformed external upload cannot prove storefront equivalence. */
export function amazonImageIdentity(value: string): string {
  try {
    const u = new URL(value)
    if (['m.media-amazon.com', 'images-na.ssl-images-amazon.com', 'images-eu.ssl-images-amazon.com'].includes(u.hostname)) {
      const match = /^\/images\/I\/([^.\/]+)\./.exec(u.pathname)
      if (match) return `amazon:${match[1]}`
    }
  } catch { /* retain exact identity */ }
  return value
}
export function imageCatalogMatches(desired: Record<string, string>, observed: AmazonMediaObservation): boolean {
  if (observed.error || observed.catalogError || !observed.catalog.length) return false
  return amazonImageSlots.filter(s => s.code !== 'SWCH').every(s => {
    const wanted = desired[s.code]; const actual = observed.catalog.find(i => i.slot === s.code)?.url
    return wanted && actual ? amazonImageIdentity(wanted) === amazonImageIdentity(actual) : !wanted && !actual
  })
}
export function groupAmazonItems(items: AmazonMediaItem[], axis: string) {
  const groups = new Map<string, AmazonMediaItem[]>()
  for (const item of items) {
    const label = item.parent ? 'Parent listing' : axis ? item.attributes[axis] || 'Value unavailable' : 'All SKUs'
    groups.set(label, [...(groups.get(label) ?? []), item])
  }
  return [...groups].map(([label, members]) => ({ label, items: members }))
}

export type AmazonBulkMode = 'fill' | 'replace' | 'inherit' | 'clear'
export interface AmazonBulkChange { listingId: string; slot: string; before: ImageAssignment | null; after: ImageAssignment | null; inherited: boolean }
/** A single pure plan drives the preview and the applied draft. Unselected slots are retained. */
export function planAmazonBulkImages(draft: AmazonMediaDraft, source: ImageSlots, listingIds: string[], codes: string[], mode: AmazonBulkMode, language?: string) {
  const next: AmazonMediaDraft = { ...draft, items: { ...draft.items } }
  const changes: AmazonBulkChange[] = []
  for (const id of new Set(listingIds)) {
    const overrides = { ...draft.items[id] }
    const effective = effectiveImageSlots(draft, id)
    for (const code of new Set(codes)) {
      if (!amazonManagedImageSlots.some(s => s.code === code)) continue
      if ((mode === 'fill' || mode === 'replace') && !source[code]) continue
      // Explicit clears express intent; filling unassigned slots must retain them.
      if (mode === 'fill' && (effective[code] || effective[code] === null)) continue
      const before = effective[code] ?? null
      const assignment = source[code]
      const after = mode === 'inherit' ? draft.common[code] ?? null : mode === 'clear' ? null
        : assignment ? { ...assignment, ...(language ? { language } : {}) } : null
      if (mode === 'inherit') {
        if (!(code in overrides)) continue
        delete overrides[code]
      } else {
        const existing = overrides[code]
        if (existing === null && after === null || existing && after && existing.assetId === after.assetId && existing.language === after.language) continue
        overrides[code] = after
      }
      changes.push({ listingId: id, slot: code, before, after, inherited: mode === 'inherit' })
    }
    next.items[id] = overrides
  }
  return { draft: next, changes }
}

export interface AmazonSafetyFile { asin: string; slot: string; url: string; language: string; listingIds: string[] }
export function planAmazonSafetyExport(workspace: AmazonMediaWorkspace, listingIds: string[]) {
  const files: AmazonSafetyFile[] = []; const issues: string[] = []
  const signatures = new Map<string, string>()
  if (!listingIds.length || listingIds.length > 200) issues.push('Choose between 1 and 200 SKUs for this export.')
  for (const id of new Set(listingIds)) {
    const item = workspace.items.find(i => i.id === id)
    if (!item) { issues.push('A selected SKU does not belong to this listing destination.'); continue }
    if (!item.asin || !/^[A-Z0-9]{10}$/.test(item.asin)) { issues.push(`${item.sku || item.label}: a valid Amazon ASIN is required.`); continue }
    const slots = effectiveImageSlots(workspace.draft, id)
    const signature = JSON.stringify(amazonSafetyImageSlots.map(s => {
      const assignment = slots[s.code]
      return assignment ? [workspace.assets.find(a => a.id === assignment.assetId)?.url, assignment.language] : null
    }))
    if (signatures.has(item.asin) && signatures.get(item.asin) !== signature) issues.push(`${item.asin}: selected SKUs have conflicting safety images. Choose a single gallery for this ASIN.`)
    signatures.set(item.asin, signature)
    let assigned = 0
    for (const slot of amazonSafetyImageSlots) {
      const assignment = slots[slot.code]
      if (!assignment) continue
      assigned++
      const asset = workspace.assets.find(a => a.id === assignment.assetId)
      if (!asset || !publicImageUrl(asset.url)) { issues.push(`${item.sku} · ${slot.code}: a public HTTPS source image is required.`); continue }
      if (assignment.language !== 'zxx' && !workspace.languages.includes(assignment.language)) { issues.push(`${item.sku} · ${slot.code}: confirm the image language for this market.`); continue }
      const existing = files.find(f => f.asin === item.asin && f.slot === slot.code)
      if (existing) existing.listingIds.push(id)
      else files.push({ asin: item.asin, slot: slot.code, url: asset.url, language: assignment.language, listingIds: [id] })
    }
    if (!assigned) issues.push(`${item.sku || item.label}: no safety images are assigned.`)
  }
  return { files, issues: [...new Set(issues)] }
}

const assetSchema = z.object({ id: z.string(), url: z.string(), label: z.string(), width: z.number().nullable(), height: z.number().nullable(), origin: z.enum(['product', 'saved-gallery']) })
const observationSchema = z.object({ checkedAt: z.string(), error: z.string().nullable(), asin: z.string().nullable(), productType: z.string().nullable(), theme: z.string().nullable(),
  attributes: z.record(z.string(), z.string()), slots: z.record(z.string(), z.string()), catalog: z.array(z.object({ slot: z.string(), url: z.string(), width: z.number(), height: z.number() })),
  catalogError: z.string().nullable(), issues: z.array(z.object({ code: z.string(), message: z.string(), severity: z.string() })), supported: z.array(z.string()) })
export const amazonMediaWorkspaceSchema = z.object({ productId: z.string(), revision: z.string(), draft: amazonMediaDraftSchema, assets: z.array(assetSchema),
  items: z.array(z.object({ id: z.string(), productId: z.string(), sku: z.string(), asin: z.string().nullable(), label: z.string(), parent: z.boolean(), productType: z.string().nullable(), theme: z.string().nullable(), attributes: z.record(z.string(), z.string()) })),
  destination: z.object({ accountId: z.string(), marketplace: z.string(), listingId: z.string(), aliasKey: z.string(), label: z.string(), listings: z.array(z.object({ id: z.string(), label: z.string() })) }),
  languages: z.array(z.string()), markets: z.array(z.object({ code: z.string(), label: z.string() })), warnings: z.array(z.string()), observations: z.record(z.string(), observationSchema), activeRunId: z.string().nullable() })
export const amazonMediaRunSchema = z.object({ id: z.string(), status: z.enum(['REVIEW_QUEUED', 'REVIEWING', 'REVIEW', 'REVIEW_FAILED', 'QUEUED', 'READY', 'SUBMITTING', 'COMPLETE', 'UNKNOWN']), createdAt: z.string(), revision: z.string(),
  items: z.array(z.object({ listingId: z.string(), sku: z.string(), asin: z.string(), productType: z.string(), desired: z.record(z.string(), z.string()), before: z.record(z.string(), z.string()),
    patches: z.array(z.object({ op: z.enum(['replace', 'delete']), path: z.string(), value: z.array(z.record(z.string(), z.unknown())) })), changes: z.array(z.object({ slot: z.string(), before: z.string().nullable(), after: z.string().nullable() })), issues: z.array(z.string()) })),
  receipts: z.array(z.object({ listingId: z.string(), status: z.enum(['NOT_SENT', 'SENDING', 'ACCEPTED', 'REJECTED', 'UNKNOWN', 'UNCHANGED']), submissionId: z.string().optional(), message: z.string().optional() })) })
