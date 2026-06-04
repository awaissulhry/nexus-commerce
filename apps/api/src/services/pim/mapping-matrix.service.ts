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
import { previewPayload, type PreviewResult } from './payload-preview.js'
import { scanProductDivergence, type DivergenceEntry } from './reconcile-divergence.service.js'

export interface MatrixCoordinate {
  channel: string
  marketplace: string
  hasListing: boolean
  isPublished: boolean
}

export interface MatrixCell {
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
    divMaster.set(`${d.channel}:${d.marketplace}:${d.fieldKey}`, d.masterValue)
  }

  const rows = new Map<string, MatrixRow>()
  let missingRequired = 0

  args.coordinates.forEach((coord, i) => {
    const preview = args.previews[i]
    if (!preview) return
    const coordKey = `${coord.channel}:${coord.marketplace}`
    for (const f of preview.fields) {
      let row = rows.get(f.fieldKey)
      if (!row) {
        const src = (f.rule as { source?: unknown } | undefined)?.source
        row = {
          fieldKey: f.fieldKey,
          label: f.fieldKey,
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
  const locale = input.locale ?? 'en'

  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: { id: true, sku: true },
  })
  if (!product) throw new Error(`Product not found: ${input.productId}`)

  const listings = await prisma.channelListing.findMany({
    where: { productId: input.productId },
    select: { channel: true, marketplace: true, isPublished: true },
    orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
  })
  const coordinates: MatrixCoordinate[] = listings
    .filter((l) => l.channel && l.marketplace)
    .map((l) => ({
      channel: l.channel,
      marketplace: l.marketplace as string,
      hasListing: true,
      isPublished: !!l.isPublished,
    }))

  // Channel cells via the real preview path (parity); divergence + master
  // values via FM.12 (one pass over all coordinates).
  const [previews, divergence] = await Promise.all([
    mapBounded(coordinates, 4, (c) =>
      previewPayload({ productId: input.productId, channel: c.channel, marketplace: c.marketplace, locale }).catch(
        () => null,
      ),
    ),
    scanProductDivergence({ productId: input.productId, locale }).catch(
      () => ({ entries: [] as DivergenceEntry[] } as { entries: DivergenceEntry[] }),
    ),
  ])

  const { fields, divergent, missingRequired } = pivotMatrix({
    coordinates,
    previews,
    divergences: divergence.entries,
  })

  return {
    productId: input.productId,
    sku: product.sku,
    coordinates,
    fields,
    counts: { coordinates: coordinates.length, fields: fields.length, divergent, missingRequired },
  }
}
