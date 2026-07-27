/**
 * READ-ONLY drift report for Inventory-API-managed eBay families.
 *
 * Why this exists: a description-only push is impossible on Lane A (eBay
 * rejects Trading revises on Inventory-managed listings, and the Inventory API
 * has no PATCH), so the operator is told to use Full Publish instead. But
 * pushVariationGroup rebuilds the WHOLE inventory_item_group from Nexus data —
 * title, description, imageUrls, variantSKUs, variesBy, aspects — and PUTs it
 * as a full replace. If any of that has drifted from what eBay actually holds,
 * a description-only INTENT silently rewrites other fields too.
 *
 * This measures whether that risk is real, before anyone changes a write path:
 * it GETs each live inventory_item_group and diffs it against the values a
 * Full Publish would re-assert. Nothing here writes — to eBay or to the DB.
 *
 * Honest scope: only the fields derivable faithfully OUTSIDE pushVariationGroup
 * are diffed (title, variant membership). Images / aspects / variesBy are
 * reported as eBay holds them, flagged `comparable: false`, because
 * re-deriving them here would risk a diff that lies in either direction.
 */
import type { PrismaClient } from '@prisma/client'
import { resolvePerMarketContent, toListingLanguage } from './ebay-variation-push.service.js'

export interface DriftField {
  field: string
  live: unknown
  wouldPush?: unknown
  /** false = reported for context only; this run cannot faithfully re-derive it. */
  comparable: boolean
  drift: boolean
}

export interface FamilyDrift {
  parentSku: string
  itemId: string
  groupKey: string
  ok: boolean
  error?: string
  liveDescriptionChars?: number
  fields: DriftField[]
  drift: boolean
}

export interface DriftReport {
  marketplace: string
  checked: number
  withDrift: number
  families: FamilyDrift[]
  note: string
}

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/** PURE — the comparison itself, so the semantics are unit-testable. */
export function diffLiveGroup(
  live: Record<string, unknown>,
  expected: { title: string; variantSkus: string[] },
): { fields: DriftField[]; drift: boolean } {
  const liveSkus = [...((live.variantSKUs as string[] | undefined) ?? [])].sort()
  const wantSkus = [...expected.variantSkus].sort()
  const liveTitle = String(live.title ?? '')

  const fields: DriftField[] = [
    {
      field: 'title',
      live: liveTitle,
      wouldPush: expected.title,
      comparable: true,
      drift: liveTitle !== expected.title,
    },
    {
      field: 'variantSKUs',
      live: liveSkus,
      wouldPush: wantSkus,
      comparable: true,
      drift: JSON.stringify(liveSkus) !== JSON.stringify(wantSkus),
    },
    { field: 'imageUrls', live: ((live.imageUrls as string[] | undefined) ?? []).length, comparable: false, drift: false },
    { field: 'variesBy', live: live.variesBy ?? null, comparable: false, drift: false },
    { field: 'aspects', live: live.aspects ?? null, comparable: false, drift: false },
  ]
  return { fields, drift: fields.some((f) => f.comparable && f.drift) }
}

export async function collectInventoryDrift(
  prisma: PrismaClient,
  opts: { marketplace: string; oauthToken: string; apiBase?: string },
): Promise<DriftReport> {
  const marketplace = opts.marketplace.toUpperCase()
  const region = marketplace === 'UK' ? 'GB' : marketplace
  const apiBase = opts.apiBase ?? process.env.EBAY_API_BASE ?? 'https://api.ebay.com'
  // The Sell Inventory API requires BOTH Content-Language AND Accept-Language;
  // sending neither (or only one) returns 25709 "Invalid value for header
  // Accept-Language" — which reads like a bad group key but is not. Mirrors the
  // header set pushVariationGroup already uses (see its note at the headers
  // object), so this reader authenticates exactly like the writer.
  const lang = toListingLanguage(marketplace)
  const headers = {
    Authorization: `Bearer ${opts.oauthToken}`,
    'Content-Type': 'application/json',
    'Content-Language': lang,
    'Accept-Language': lang,
    Accept: 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': `EBAY_${marketplace === 'UK' ? 'GB' : marketplace}`,
  }

  const roots = await prisma.product.findMany({
    where: { parentId: null, deletedAt: null },
    select: { id: true, sku: true },
  })

  const families: FamilyDrift[] = []
  for (const root of roots) {
    const kids = await prisma.product.findMany({
      where: { parentId: root.id, deletedAt: null },
      select: { sku: true },
    })
    const famIds = [root.id]
    const kidRows = await prisma.product.findMany({ where: { parentId: root.id, deletedAt: null }, select: { id: true } })
    famIds.push(...kidRows.map((k) => k.id))

    const cls = await prisma.channelListing.findMany({
      where: { productId: { in: famIds }, channel: 'EBAY' },
      select: { productId: true, region: true, externalListingId: true, platformAttributes: true, title: true, description: true, flatFileSnapshot: true },
    })
    const inventoryManaged = cls.some(
      (c) => Object.keys(asObj(asObj(c.platformAttributes).__offerIds)).length > 0,
    )
    if (!inventoryManaged) continue

    const parentCl = cls.find((c) => c.productId === root.id && c.region === region)
    if (!parentCl?.externalListingId) continue

    const groupKey = root.sku
    const entry: FamilyDrift = {
      parentSku: root.sku,
      itemId: parentCl.externalListingId,
      groupKey,
      ok: false,
      fields: [],
      drift: false,
    }

    try {
      const res = await fetch(
        `${apiBase}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
        { headers },
      )
      if (!res.ok) {
        entry.error = `GET inventory_item_group ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`
        families.push(entry)
        continue
      }
      const live = (await res.json()) as Record<string, unknown>
      const content = resolvePerMarketContent(parentCl as never, {})
      const { fields, drift } = diffLiveGroup(live, {
        title: content.title ?? '',
        variantSkus: kids.map((k) => k.sku),
      })
      entry.ok = true
      entry.fields = fields
      entry.drift = drift
      entry.liveDescriptionChars = String(live.description ?? '').length
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err)
    }
    families.push(entry)
  }

  return {
    marketplace,
    checked: families.length,
    withDrift: families.filter((f) => f.drift).length,
    families,
    note:
      'Read-only. imageUrls/variesBy/aspects are reported as eBay holds them but NOT diffed — ' +
      're-deriving them outside pushVariationGroup could produce a diff that lies in either direction.',
  }
}
