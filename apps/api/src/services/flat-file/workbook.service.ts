/**
 * FF1.10 — Catalog workbook orchestrator.
 *
 * Ties the three building blocks together:
 *   1. buildWorkbookModel  — discover markets + assemble sheet/field definitions
 *   2. fetchCatalog        — load live product + listing rows (skipped for blank templates)
 *   3. generateWorkbook    — render an XLSX Uint8Array from model + data
 *
 * Supports:
 *   - Full export   (all SKUs for the requested channels)
 *   - Subset export (filters.skuIn = grid selection)
 *   - Blank template (no data rows — headers + README only)
 */
import { buildWorkbookModel } from './registry/index.js'
import { fetchCatalog, type Channel, type CatalogFilters, type WorkbookData } from './fetch.js'
import { generateWorkbook } from './workbook-generator.js'

export interface BuildCatalogWorkbookOpts {
  /** Which channel sheets to include (AMAZON / EBAY / SHOPIFY). */
  channels: Channel[]
  /** Optional row filters. `channels` is injected automatically — do not pass it here. */
  filters?: Omit<CatalogFilters, 'channels'>
  /** Opaque snapshot identifier stamped into the _meta sheet. */
  snapshotId: string
  /** Export date in YYYY-MM-DD format — keeps the ZIP central-directory stable. */
  exportedAt: string
  /** When true, emit headers + README but skip the DB fetch (zero data rows). */
  blankTemplate?: boolean
}

/**
 * Build a complete catalog workbook (full / subset / blank template).
 *
 * NOTE: The name `buildCatalogWorkbook` is intentional.
 * `generateWorkbook` is the name of the low-level byte-renderer in
 * ./workbook-generator and must NOT be reused here.
 */
export async function buildCatalogWorkbook(
  prisma: any,
  opts: BuildCatalogWorkbookOpts,
): Promise<{ bytes: Uint8Array; marketList: Record<'AMAZON' | 'EBAY' | 'SHOPIFY', string[]> }> {
  // Step 1 — discover markets + assemble sheet/field model
  const model = await buildWorkbookModel(prisma, { channels: opts.channels })

  // Step 2 — fetch data (skipped for blank templates)
  const data: WorkbookData = opts.blankTemplate
    ? { products: [], listings: { AMAZON: [], EBAY: [], SHOPIFY: [] } }
    : await fetchCatalog(prisma, { ...(opts.filters ?? {}), channels: opts.channels })

  // Step 3 — render XLSX bytes
  const bytes = await generateWorkbook(model, data, {
    snapshotId: opts.snapshotId,
    exportedAt: opts.exportedAt,
  })

  return { bytes, marketList: model.markets }
}
