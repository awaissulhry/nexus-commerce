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
  /** Rows whose edited quantity was NOT taken (the shared pool + fan-out own
   *  quantities on shared listings) — surfaced so a "revert" is never silent. */
  qtyPoolGoverned: number
}

/**
 * Import files carry booleans as text ('TRUE', 'VERO', '1', 'Sì'…), and rows
 * saved straight after an import can reach the API before the client grid ever
 * re-materializes them as booleans. Every strict `=== true` check downstream
 * (shared family keys for the create planner, fan-out gating, Trading-API push
 * routing) silently fails on the string form — normalize in place at the
 * request door. Blank strings stay blank (they mean "no value", not false).
 */
export function normalizeEbaySharedFlags(rows: Array<Record<string, unknown>>): void {
  for (const r of rows) {
    for (const k of ['shared_sku_listing', 'best_offer_enabled']) {
      const v = r[k]
      if (typeof v === 'string' && v.trim() !== '') {
        r[k] = /^(true|vero|wahr|vrai|verdadero|yes|y|x|si|sì|1)$/i.test(v.trim())
      } else if (typeof v === 'number') {
        r[k] = v === 1
      }
    }
  }
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
  const result: SharedMembershipUpsertResult = { families: 0, created: 0, updated: 0, skipped: [], qtyPoolGoverned: 0 }

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

  // Pre-read ALL memberships of the target listings: powers honest
  // created/updated counts AND the stale-grid guard below.
  const targetItemIds = [...new Set(targets.map((t) => t.itemId))]
  const existing = (await db.sharedListingMembership.findMany({
    where: { marketplace: market, itemId: { in: targetItemIds } },
    select: { itemId: true, sku: true },
  })) as Array<{ itemId: string; sku: string }>
  const existingKeys = new Set(existing.map((e) => `${e.itemId}::${e.sku}`))
  const skusByItem = new Map<string, Set<string>>()
  for (const e of existing) {
    if (!skusByItem.has(e.itemId)) skusByItem.set(e.itemId, new Set())
    skusByItem.get(e.itemId)!.add(e.sku)
  }

  for (const t of targets) {
    // Stale-grid guard (GALE regression, 2026-07-17): a listing that has been
    // RECONCILED carries its live eBay SKUs as memberships. A save from a
    // stale browser grid (or a re-imported file) whose SKU does not exist on
    // that listing must NOT resurrect a ghost membership — those are exactly
    // the rows that can never sync ("Il numero SKU non corrisponde") and they
    // re-trip the publish circuit. Synthesized rows (_shared) always carry
    // live SKUs, so they pass by construction.
    const knownSkus = skusByItem.get(t.itemId)
    if (t.row._shared !== true && knownSkus && knownSkus.size > 0 && !knownSkus.has(t.sku)) {
      result.skipped.push({
        sku: t.sku,
        reason: `listing ${t.itemId} uses different live SKUs — reload the grid (stale rows) or run Reconcile`,
      })
      continue
    }
    const priceRaw = str(t.row[`${prefix}_price`]) || str(t.row.price)
    const priceNum = priceRaw === '' ? null : Number(priceRaw.replace(',', '.'))
    // Round-trip integrity (2026-07-17): persist the FULL row as saved (minus
    // _internal keys) — the Lane-B twin of ChannelListing.flatFileSnapshot.
    // Row synthesis overlays it verbatim, so save→reload reproduces exactly
    // what the operator left on this row. Live fields (item id, fan-out qty)
    // still override on read — see synthesizeSharedRow.
    const flatFileSnapshot = Object.fromEntries(
      Object.entries(t.row).filter(([k]) => !k.startsWith('_')),
    ) as Prisma.InputJsonObject
    // Quantities on shared listings follow the POOL via the fan-out — an
    // edited qty cell is deliberately not taken, and we COUNT it so the save
    // banner can say so (a silent revert is what we're eliminating).
    const qtyRaw = str(t.row[`${prefix}_qty`])
    if (qtyRaw !== '') result.qtyPoolGoverned++
    const data = {
      parentSku: t.parentSku || t.sku,
      productId: productIdBySku.get(t.sku) ?? null,
      variationSpecifics: specificsFromRow(t.row),
      ...(priceNum != null && Number.isFinite(priceNum) ? { price: new Prisma.Decimal(priceNum) } : {}),
      status: 'ACTIVE',
      flatFileSnapshot,
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
