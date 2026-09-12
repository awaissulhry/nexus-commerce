/**
 * Per-product mapping matrix — the read model behind the editor's Mapping
 * tab. For one product it answers: for every mapped field × every
 * (channel, marketplace) the product is listed on, what does it resolve to,
 * where does that value come from, and does it diverge from master?
 *
 * Reuse, don't reimplement: channel cells come from `previewPayload` (the
 * exact code path preview/sync use → "what you see is what ships"), and
 * divergence + master values come from FM.12 `scanProductDivergence`. This
 * service only loads the coordinates and pivots field-rows × coordinate-
 * columns. Read-only.
 */

import prisma from '../../db.js'
import { previewFromResolution, type PreviewResult } from './payload-preview.js'
import { type DivergenceEntry } from './reconcile-divergence.service.js'
import { resolveBatch } from './mapping/resolve-batch.service.js'
import { valuesEqual } from './resolver-shadow.js'

export interface MatrixCoordinate {
  listingId?: string
  channelConnectionId?: string | null
  aliasKey?: string
  listingVersion?: number
  categoryId?: string | null
  accountName?: string | null
  channel: string
  marketplace: string
  hasListing: boolean
  isPublished: boolean
}

export interface MatrixCell {
  errors?: string[]
  masterValue?: unknown
  value: unknown
  /** legacy source (source|fallback|default|missing) */
  source: string
  /** raw resolver provenance (locked|override|linked|fallback|default|catalogRule|missing) — bridged to a UI badge client-side */
  provenance?: string
  needsTranslation?: boolean
  missingRequired: boolean
  appliedTransforms: string[]
  /** per-coordinate override that differs from master+mapping */
  diverges: boolean
}

export interface MatrixRow {
  fieldKey: string
  label: string
  required: boolean
  /** the master attribute this field's rule reads from (for adopt-master) */
  sourceAttr?: string
  /** the master-resolved (catalog-mapping, no per-coordinate override) value */
  master: unknown
  cells: Record<string, MatrixCell> // key = `${channel}:${marketplace}`
}

export interface MappingMatrix {
  productId: string
  sku: string
  coordinates: MatrixCoordinate[]
  fields: MatrixRow[]
  counts: { coordinates: number; fields: number; divergent: number; missingRequired: number }
}

/** Run an async fn over items with a bounded concurrency (chunks). */
async function mapBounded<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    const chunk = await Promise.all(items.slice(i, i + limit).map(fn))
    out.push(...chunk)
  }
  return out
}

/**
 * Pure pivot: fold per-coordinate previews + the divergence entries into
 * field-rows × coordinate-cells. `previews[i]` aligns with `coordinates[i]`
 * (null when that coordinate's preview failed). Exposed for unit tests.
 */
export function pivotMatrix(args: {
  coordinates: MatrixCoordinate[]
  previews: (PreviewResult | null)[]
  divergences: DivergenceEntry[]
}): { fields: MatrixRow[]; divergent: number; missingRequired: number } {
  // `${channel}:${marketplace}:${fieldKey}` → master value (divergent only)
  const divMaster = new Map<string, unknown>()
  for (const d of args.divergences) {
    divMaster.set(`${d.listingId ?? `${d.channel}:${d.marketplace}`}:${d.fieldKey}`, d.masterValue)
  }

  const rows = new Map<string, MatrixRow>()
  let missingRequired = 0

  args.coordinates.forEach((coord, i) => {
    const preview = args.previews[i]
    if (!preview) return
    const coordKey = coord.listingId ?? `${coord.channel}:${coord.marketplace}`
    for (const f of preview.fields) {
      let row = rows.get(f.fieldKey)
      if (!row) {
        const src = (f.rule as { source?: unknown } | undefined)?.source
        row = {
          fieldKey: f.fieldKey,
          label: f.label ?? f.fieldKey,
          required: f.required,
          sourceAttr: typeof src === 'string' ? src : undefined,
          master: undefined,
          cells: {},
        }
        rows.set(f.fieldKey, row)
      }
      row.required = row.required || f.required

      const divKey = `${coordKey}:${f.fieldKey}`
      const diverges = divMaster.has(divKey)
      const missing = preview.missingRequired.includes(f.fieldKey)
      if (missing) missingRequired++

      row.cells[coordKey] = {
        errors: f.errors ?? [],
        ...(diverges ? { masterValue: divMaster.get(divKey) } : {}),
        value: f.value,
        source: f.source,
        provenance: f.provenance,
        needsTranslation: f.needsTranslation,
        missingRequired: missing,
        appliedTransforms: f.appliedTransforms,
        diverges,
      }

      // Row master: prefer a real master value (from a divergence entry);
      // otherwise the first cell's value (the canonical master+rule output,
      // since a non-diverging cell follows master).
      if (diverges) row.master = divMaster.get(divKey)
      else if (row.master === undefined) row.master = f.value
    }
  })

  return { fields: [...rows.values()], divergent: args.divergences.length, missingRequired }
}

/** Build the full mapping matrix for a product. 404 (throws) if missing. */
export async function buildMappingMatrix(input: {
  productId: string
  locale?: string
}): Promise<MappingMatrix> {
  const locale = input.locale

  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: { id: true, sku: true },
  })
  if (!product) throw new Error(`Product not found: ${input.productId}`)

  const listings = await prisma.channelListing.findMany({
    where: { productId: input.productId },
    select: { id: true, channel: true, marketplace: true, isPublished: true, channelConnectionId: true, aliasKey: true, version: true, channelConnection: { select: { displayName: true } } },
    orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
  })
  const coordinates: MatrixCoordinate[] = listings
    .filter((l) => l.channel && l.marketplace)
    .map((l) => ({
      listingId: l.id, accountName: l.channelConnection?.displayName ?? null, channelConnectionId: l.channelConnectionId, aliasKey: l.aliasKey, listingVersion: l.version,
      channel: l.channel,
      marketplace: l.marketplace as string,
      hasListing: true,
      isPublished: !!l.isPublished,
    }))

  // Resolve a coordinate once; only listings with mapped overrides need a
  // second baseline. Do not repeat every read in a separate divergence scan.
  const inspected = await mapBounded(coordinates, 4, async c => {
    const args = { productIds: [input.productId], channel: c.channel, marketplace: c.marketplace,
      channelConnectionId: c.channelConnectionId, aliasKey: c.aliasKey, locale }
    const current = await resolveBatch(args)
    const overrides = Object.values(current.products[0]?.cells ?? {}).filter(cell => cell.provenance === 'override' && cell.rule)
    const inherited = overrides.length ? await resolveBatch({ ...args, inheritMappedFields: true, includeCatalogue: false }) : current
    const divergences: DivergenceEntry[] = []
    for (const cell of overrides) {
      const master = inherited.products[0]?.cells[cell.fieldKey]
      if (master && !valuesEqual(cell.value, master.value)) divergences.push({ ...c, fieldKey: cell.fieldKey, overrideValue: cell.value, masterValue: master.value })
    }
    return { preview: previewFromResolution(current, input.productId), divergences }
  })
  const previews = inspected.map(r => r.preview)

  const { fields, divergent, missingRequired } = pivotMatrix({
    coordinates,
    previews,
    divergences: inspected.flatMap(r => r.divergences),
  })
  coordinates.forEach((coordinate, index) => { coordinate.categoryId = previews[index]?.categoryId ?? null })

  return {
    productId: input.productId,
    sku: product.sku,
    coordinates,
    fields,
    counts: { coordinates: coordinates.length, fields: fields.length, divergent, missingRequired },
  }
}
