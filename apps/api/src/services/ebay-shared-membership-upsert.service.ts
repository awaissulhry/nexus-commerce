/**
 * E2 — membership UPSERT for ALREADY-LIVE shared listings (import/save path).
 *
 * The shared-SKU model's output side is fully shipped: pushing a family whose
 * parent carries `shared_sku_listing` creates the eBay listing AND its
 * SharedListingMembership rows (the fan-out's source of truth). But
 * memberships were PUSH-ONLY — a file describing listings that already exist
 * on eBay (different parent SKUs + item IDs sharing the same child SKUs)
 * could be imported into the grid yet never became synced memberships.
 *
 * This service is the inverse of createSharedListing for ingest: rows that
 * carry a live ItemID under a shared parent upsert their membership by the
 * natural key (marketplace, itemId, sku) — NO eBay calls, no ChannelListing
 * writes, never the stock pool. Linking productId (resolved by SKU when the
 * row has none) is what makes the Phase-3 quantity fan-out pick the listing
 * up immediately.
 */

import prisma from '../db.js'
import { Prisma } from '@prisma/client'

export interface SharedMembershipUpsertResult {
  families: number
  created: number
  updated: number
  skipped: Array<{ sku: string; reason: string }>
}

type Row = Record<string, unknown>

const str = (v: unknown): string => (v == null ? '' : String(v)).trim()

/** aspect_* columns → variation specifics, preferring the cased key over the
 *  lowercase twin buildFlatRow also writes. */
function specificsFromRow(row: Row): Record<string, string> {
  const out = new Map<string, { name: string; value: string }>()
  for (const [key, val] of Object.entries(row)) {
    if (!key.startsWith('aspect_') || typeof val !== 'string' || !val.trim()) continue
    const display = key.slice('aspect_'.length).replace(/_/g, ' ')
    const lk = display.toLowerCase()
    const existing = out.get(lk)
    if (!existing || (existing.name === existing.name.toLowerCase() && display !== lk)) {
      out.set(lk, { name: display, value: val.trim() })
    }
  }
  return Object.fromEntries([...out.values()].map((e) => [e.name, e.value]))
}

export async function upsertSharedMembershipsFromRows(
  rows: Row[],
  marketplace: string,
  db: {
    sharedListingMembership: { findMany: Function; upsert: Function }
    product: { findMany: Function }
  } = prisma as never,
): Promise<SharedMembershipUpsertResult> {
  const market = marketplace.toUpperCase()
  const prefix = marketplace.toLowerCase()
  const result: SharedMembershipUpsertResult = { families: 0, created: 0, updated: 0, skipped: [] }

  // Shared families = parent rows flagged shared_sku_listing; children match
  // by parent_sku. Synthesized read-back rows (_shared) also qualify — an
  // operator edit on one should persist to its membership.
  const parents = new Map<string, Row>() // parent sku → row
  for (const r of rows) {
    const isParent = r._isParent === true || str(r.parentage) === 'parent'
    if (isParent && str(r.sku)) parents.set(str(r.sku), r)
  }

  interface Target { sku: string; itemId: string; parentSku: string; row: Row }
  const targets: Target[] = []
  for (const r of rows) {
    const sku = str(r.sku)
    if (!sku) continue
    const isParent = r._isParent === true || str(r.parentage) === 'parent'
    if (isParent) continue
    const parentSku = str(r.parent_sku)
    const parent = parentSku ? parents.get(parentSku) : undefined
    const familyShared = parent ? Boolean(parent.shared_sku_listing) : r._shared === true
    if (!familyShared) continue
    const itemId = str(r[`${prefix}_item_id`]) || str(r.ebay_item_id)
    if (!itemId) {
      result.skipped.push({ sku, reason: `no live ItemID on ${market} — publish creates the membership` })
      continue
    }
    targets.push({ sku, itemId, parentSku, row: r })
  }
  if (targets.length === 0) return result
  result.families = new Set(targets.map((t) => t.parentSku || t.itemId)).size

  // Resolve productId per SKU: the row's own _productId wins; DB lookup fills
  // the rest so the membership links the shared stock pool.
  const productIdBySku = new Map<string, string | null>()
  for (const t of targets) {
    const own = str(t.row._productId)
    if (own) productIdBySku.set(t.sku, own)
  }
  const unresolved = [...new Set(targets.map((t) => t.sku))].filter((s) => !productIdBySku.has(s))
  if (unresolved.length > 0) {
    const found = (await db.product.findMany({
      where: { sku: { in: unresolved }, deletedAt: null },
      select: { id: true, sku: true },
    })) as Array<{ id: string; sku: string }>
    for (const f of found) productIdBySku.set(f.sku, f.id)
  }

  // Pre-read existing keys so created/updated counts are honest.
  const existing = (await db.sharedListingMembership.findMany({
    where: { marketplace: market, OR: targets.map((t) => ({ itemId: t.itemId, sku: t.sku })) },
    select: { itemId: true, sku: true },
  })) as Array<{ itemId: string; sku: string }>
  const existingKeys = new Set(existing.map((e) => `${e.itemId}::${e.sku}`))

  for (const t of targets) {
    const priceRaw = str(t.row[`${prefix}_price`]) || str(t.row.price)
    const priceNum = priceRaw === '' ? null : Number(priceRaw.replace(',', '.'))
    const data = {
      parentSku: t.parentSku || t.sku,
      productId: productIdBySku.get(t.sku) ?? null,
      variationSpecifics: specificsFromRow(t.row),
      ...(priceNum != null && Number.isFinite(priceNum) ? { price: new Prisma.Decimal(priceNum) } : {}),
      status: 'ACTIVE',
    }
    await db.sharedListingMembership.upsert({
      where: { marketplace_itemId_sku: { marketplace: market, itemId: t.itemId, sku: t.sku } },
      update: data,
      create: { marketplace: market, itemId: t.itemId, sku: t.sku, ...data },
    })
    if (existingKeys.has(`${t.itemId}::${t.sku}`)) result.updated++
    else result.created++
  }
  return result
}
