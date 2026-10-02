/**
 * MCP full control I4 — the identity guards product writes run (section 04 §1.5 G4, G5).
 *
 *   G4  A product SKU (on create or rename) may not be the SKU an extra listing already uses as its own
 *       (ProductListingAlias.sku): an import or a channel would name both by it. The listing-SKU column comes with the
 *       eBay import by SKU; until it exists there is nothing to compare and the guard finds nothing. The eBay branch
 *       refuses the other direction (a listing SKU equal to a product SKU).
 *   G5  A barcode (GTIN, EAN, UPC) saved on a product is checked with validateGtin, and another product of this business
 *       carrying the same code (leading zeros ignored) is named. Both are WARNINGS on a save — the value is stored and
 *       flagged, as the product sheet stores every value (P1) — and set-gtin refuses an invalid code before it asks.
 *
 * Inside the bound business only: the same SKU or barcode in another business is legal.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { validateGtin } from '../listing-preflight.service.js'
import { availableRequirements, barcodeSql } from './identity-audit.service.js'

export interface ListingSkuUse {
  /** The SKU asked about, as it was given. */
  sku: string
  listingSku: string
  label: string
  productSku: string
}

/** G4 — which of these SKUs an extra listing of this business already uses (case and surrounding spaces ignored). */
export async function skusUsedByListings(skus: readonly string[]): Promise<ListingSkuUse[]> {
  const wanted = [...new Set(skus.map((sku) => sku.trim().toLowerCase()).filter(Boolean))]
  if (wanted.length === 0) return []
  if (!(await availableRequirements()).has('listing-alias-sku')) return []
  const rows = await prisma.$queryRaw<Array<{ key: string; listing_sku: string; label: string; product_sku: string }>>`
    SELECT lower(btrim(a.sku)) AS key, a.sku AS listing_sku, a.label, p.sku AS product_sku
    FROM "ProductListingAlias" a JOIN "Product" p ON p.id = a."productId"
    WHERE a."workspaceId" = ${workspaceIdForQuery()} AND lower(btrim(a.sku)) = ANY(${wanted}::text[])`
  return skus.flatMap((sku) => rows
    .filter((row) => row.key === sku.trim().toLowerCase())
    .map((row) => ({ sku, listingSku: row.listing_sku, label: row.label, productSku: row.product_sku })))
}

/** G4 — the sentence a refused SKU gets. */
export function listingSkuRefusal(use: ListingSkuUse): string {
  return `SKU "${use.sku}" is already the SKU of an extra listing ("${use.label}" of ${use.productSku}). `
    + 'One SKU for two things is confused by imports and channels — choose another SKU.'
}

export const BARCODE_FIELDS: ReadonlySet<string> = new Set(['gtin', 'ean', 'upc'])

/** G5 — why a barcode is not valid (validateGtin's reason), or null when it is. */
export function barcodeProblem(value: string): string | null {
  const verdict = validateGtin(value)
  return verdict.valid ? null : `Not a valid barcode: ${verdict.reason}. It is saved, but a channel refuses it or matches another item.`
}

export interface BarcodeDuplicate {
  id: string
  field: string
  code: string
  otherSku: string
}

/** G5 — barcodes being saved that another live product of this business already carries (leading zeros ignored). */
export async function barcodeDuplicates(entries: ReadonlyArray<{ id: string; field: string; code: string }>): Promise<BarcodeDuplicate[]> {
  const usable = entries.filter((e) => e.code.replace(/[^0-9]/g, '').replace(/^0+/, '') !== '')
  if (usable.length === 0) return []
  const rows = await prisma.$queryRaw<Array<{ id: string; field: string; code: string; other_sku: string }>>`
    SELECT x.id, x.field, x.code, min(p.sku) AS other_sku
    FROM unnest(${usable.map((e) => e.id)}::text[], ${usable.map((e) => e.field)}::text[], ${usable.map((e) => e.code)}::text[]) AS x(id, field, code)
    JOIN "Product" p ON p."workspaceId" = ${workspaceIdForQuery()} AND p."deletedAt" IS NULL AND p.id <> x.id
      AND ${barcodeSql(Prisma.sql`x.code`)} IN (${barcodeSql(Prisma.sql`p.gtin`)}, ${barcodeSql(Prisma.sql`p.ean`)}, ${barcodeSql(Prisma.sql`p.upc`)})
    GROUP BY x.id, x.field, x.code`
  return rows.map((row) => ({ id: row.id, field: row.field, code: row.code, otherSku: row.other_sku }))
}

export function barcodeDuplicateWarning(duplicate: BarcodeDuplicate): string {
  return `${duplicate.otherSku} already carries this barcode. A channel matches both products to one catalogue item.`
}
