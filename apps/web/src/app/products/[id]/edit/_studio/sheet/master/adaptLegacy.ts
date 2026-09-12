/**
 * PES.2 — the bridge from the read that exists TODAY to the contract the sheet is written against.
 *
 * `GET /api/products/:id/studio/sheet` (PES.5 §3.2) is approved and being built. `GET
 * /api/products/sheet?market=IT&parentIds=<id>` exists now, is family-scoped already, and returns
 * the same rows through the same services. This converts the second into the first so the sheet is
 * verifiable against the real XAVIA catalogue before the studio route answers.
 *
 * 🔴 **It marks its output `source: 'legacy'`, and the sheet says so on screen.** The adapted
 * provenance is INFERRED from the resolver's `source` string, where the studio contract has the
 * server state the `layer` outright. Those are not the same claim, and presenting an inference as
 * a server verdict is the exact dishonesty the provenance glyphs exist to avoid. When the studio
 * route lands, this file is deleted — not kept as a fallback, because a silent fallback would let
 * a 404 downgrade every cell's provenance with nothing on screen to say it happened.
 *
 * Pure, and tested: it is the only thing that knows the two shapes differ.
 */
import type { CellLayer, SheetColumn, StudioCellValue, StudioRow, StudioSheet } from './types'

/** The catalogue-wide read's row shape (`services/pim/sheet-rows.service.ts`). */
interface LegacyRow {
  id: string
  sku: string
  name: string | null
  parentId: string | null
  isParent: boolean
  status: string
  productType: string | null
  version: number
  basePrice: number | null
  childCount: number
  values: Record<string, { value: unknown; source: string; inheritedFrom: string | null; inherited: boolean }>
  listings: Record<string, unknown>
  readiness: Record<string, { state: string; issues: Array<{ key: string; label: string; message: string; severity: string }>; ref?: string }>
  completeness: StudioRow['completeness']
}

export interface LegacySheetPage {
  market: string
  locale: string
  coordinates: Array<{ channel: string; marketplace: string; label: string; inMarket: boolean }>
  columns: SheetColumn[]
  rows: LegacyRow[]
  total: number
  droppedKeys: string[]
  schemaMissing: string[]
  schemaAge: Array<{ productType: string; fetchedAt: string }>
  availableMarkets: string[]
}

/**
 * Map the resolver's `ValueSource` onto the studio contract's `layer`.
 *
 * The resolver's vocabulary (`attribute-resolver.ts`) is
 * `master | masterLocale | masterColumn | variant | variantLocale | channelOverride |
 * channelExplicit | default`. Three of those are the master storing a field differently —
 * collapsing them to `master` is the correct reading, not a loss.
 */
export function layerFromSource(source: string | undefined): CellLayer {
  switch ((source ?? '').toLowerCase()) {
    case 'master':
    case 'masterlocale':
    case 'mastercolumn':
      return 'master'
    case 'variant':
    case 'variantlocale':
      return 'variant'
    case 'channeloverride':
    case 'channelexplicit':
      return 'channel'
    case 'default':
      return 'default'
    default:
      // An unrecognised source is NOT quietly called `master`: that would draw a cell as the
      // master's own value on no evidence. `default` renders unmarked and claims nothing.
      return 'default'
  }
}

/**
 * Whether this row stores the value itself.
 *
 * On the master scope a cell is "pinned" when a CHILD holds its own value for a global attribute —
 * the layout's `✎ pinned per-variant`. A parent row is never pinned against itself, and an
 * inherited cell is by definition not pinned.
 */
export function pinnedFromLegacy(cell: { source: string; inherited: boolean }, row: { isParent: boolean }): boolean {
  if (cell.inherited) return false
  if (row.isParent) return false
  const layer = layerFromSource(cell.source)
  return layer === 'variant' || layer === 'channel'
}

export function adaptLegacySheet(page: LegacySheetPage, familyId: string): StudioSheet {
  const columnByKey = new Map(page.columns.map((c) => [c.key, c]))
  const family = page.rows.find((r) => r.id === familyId) ?? page.rows.find((r) => !r.parentId) ?? page.rows[0] ?? null

  const rows: StudioRow[] = page.rows.map((r) => {
    const values: Record<string, StudioCellValue> = {}
    for (const [key, cell] of Object.entries(r.values ?? {})) {
      const col = columnByKey.get(key)
      values[key] = {
        value: cell.value,
        source: cell.source,
        inheritedFrom: cell.inheritedFrom,
        inherited: cell.inherited,
        layer: layerFromSource(cell.source),
        pinned: pinnedFromLegacy(cell, r),
        // The legacy read carries no follow flag per cell, and inventing `true` would draw a
        // control claiming a flag nobody read. Absent means "this read cannot say".
        follows: null,
        editable: col?.editable ?? true,
        writeField: col?.writeField ?? key,
        writeTarget: 'master',
      }
    }
    return {
      id: r.id,
      sku: r.sku,
      name: r.name,
      parentId: r.parentId,
      isParent: r.isParent,
      status: r.status,
      productType: r.productType,
      version: r.version,
      basePrice: r.basePrice,
      childCount: r.childCount,
      rowKind: r.isParent ? 'parent' : 'variant',
      aliasId: null,
      values,
      // The catalogue read answers a verdict PER coordinate; the studio route answers one for the
      // scope. Kept in the legacy-only field rather than collapsed — there is no honest single
      // value to pick from "Amazon: errors, eBay: live", and inventing one would put a verdict on
      // screen that no server ever gave.
      readinessByCoordinate: (r.readiness ?? {}) as NonNullable<StudioRow['readinessByCoordinate']>,
      listing: null,
      completeness: r.completeness,
    }
  })

  return {
    scope: { kind: 'master', label: `Master · ${page.market}`, locale: page.locale, marketplace: page.market },
    family: {
      id: family?.id ?? familyId,
      sku: family?.sku ?? '',
      name: family?.name ?? null,
      productType: family?.productType ?? null,
      // The catalogue read does not return `variationAxes` on the row, so the adapter cannot know
      // them. Empty, honestly — the caller passes what it knows from elsewhere.
      variationAxes: [],
    },
    columns: page.columns,
    coordinates: page.coordinates,
    rows,
    meta: {
      schemaMissing: page.schemaMissing ?? [],
      schemaAge: page.schemaAge ?? [],
      droppedKeys: page.droppedKeys ?? [],
      source: 'legacy',
    },
  }
}
