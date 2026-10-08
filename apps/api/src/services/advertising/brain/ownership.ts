/**
 * ONE BRAIN AB-1 — which product's brain owns a campaign (design 2026-10-08-ads-one-brain/DESIGN.md §1, "Campaign
 * ownership"). A campaign belongs to the products its ads advertise (AdProductAd), each rolled up to its product family:
 *
 *   product  every ad ties to ONE family → that product's brain owns the campaign's levers
 *   shared   the ads tie to several families, or to one family plus an ad Nexus cannot tie to any product (fail closed:
 *            that ad may be another product's) → no product's brain owns it; the brain may lower it, never raise it,
 *            and proposes a split (D2 = A)
 *   none     no ad ties to a product (no ad, or only ads Nexus cannot tie) → today's engines run it, as now
 *
 * An ad ties to a product by its productId (a live product), else its SKU (Product.sku: the advertised seller SKU names
 * one product row), else its ASIN (Product.amazonAsin, any case). An ASIN that live products of two families carry ties
 * the ad to both (the campaign is then shared, and the ASIN is named in `ambiguous`). Archived ads and the ads of
 * archived ad groups do not count: they serve nothing.
 *
 * The family: a variation rolls up to its parent (Product.parentId ?? Product.id — one level deep, as everywhere in
 * Nexus; the product studio refuses a deeper tree). A product with no parent whose ASIN a variation carries (the same
 * Amazon product under a second SKU, e.g. FBA beside FBM — RD.10h in ads-dayparting-refresh.service.ts) belongs to that
 * variation's family.
 *
 * Batched: a fixed number of queries whatever the number of campaigns (no N+1). Reads only.
 */
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'

export type CampaignOwner =
  | { kind: 'product'; productId: string }
  | { kind: 'shared'; productIds: string[] }
  | { kind: 'none' }

export interface CampaignOwnership {
  campaignId: string
  name: string
  /** Short market code ('IT'), null when the campaign's marketplace is unknown. */
  market: string | null
  adProduct: string | null
  status: string
  /** The product families its ads advertise (family root ids), sorted. */
  productIds: string[]
  /** Ads Nexus cannot tie to a live product, named by their ASIN (else SKU, else product id): with a family, they make it shared. */
  unresolved: string[]
  /** ASINs (or SKUs) that tie to more than one family. */
  ambiguous: string[]
  owner: CampaignOwner
}

/** One advertised product of a campaign, as the resolver reads it. */
export interface AdRef { campaignId: string; productId: string | null; asin: string | null; sku: string | null }
/** One live product row the ads may name. */
export interface ProductRow { id: string; parentId: string | null; amazonAsin: string | null; sku: string }

const asinOf = (s: string): string => s.trim().toUpperCase()
const asinForms = (asins: Iterable<string>) => [...new Set([...asins].flatMap((a) => [a.toUpperCase(), a.toLowerCase()]))]

/** The product rows the ads name, with every family a variation's ASIN puts a parentless row in. */
export interface Catalog {
  byId: Map<string, ProductRow>
  bySku: Map<string, ProductRow>
  byAsin: Map<string, ProductRow[]>
  /** ASIN → the parents of the live variations that carry it. */
  familiesOfAsin: Map<string, Set<string>>
}

export function buildCatalog(rows: readonly ProductRow[], variations: ReadonlyArray<{ parentId: string; amazonAsin: string | null }> = []): Catalog {
  const byId = new Map<string, ProductRow>()
  const bySku = new Map<string, ProductRow>()
  const byAsin = new Map<string, ProductRow[]>()
  const familiesOfAsin = new Map<string, Set<string>>()
  const addFamily = (asin: string | null, parentId: string | null) => {
    if (!asin?.trim() || !parentId) return
    familiesOfAsin.set(asinOf(asin), (familiesOfAsin.get(asinOf(asin)) ?? new Set()).add(parentId))
  }
  for (const r of rows) {
    byId.set(r.id, r)
    bySku.set(r.sku, r)
    if (r.amazonAsin?.trim()) byAsin.set(asinOf(r.amazonAsin), [...(byAsin.get(asinOf(r.amazonAsin)) ?? []), r])
    addFamily(r.amazonAsin, r.parentId)
  }
  for (const v of variations) addFamily(v.amazonAsin, v.parentId)
  return { byId, bySku, byAsin, familiesOfAsin }
}

/** The families one product row belongs to: its parent; else the families of the variations that carry its ASIN; else itself. */
export function familiesOf(row: ProductRow, catalog: Catalog): string[] {
  if (row.parentId) return [row.parentId]
  const families = row.amazonAsin ? catalog.familiesOfAsin.get(asinOf(row.amazonAsin)) : undefined
  return families?.size ? [...families].sort() : [row.id]
}

/** The families one ad advertises (empty: Nexus cannot tie it), and the key that tied it to several. */
export function tieAd(ad: Pick<AdRef, 'productId' | 'asin' | 'sku'>, catalog: Catalog): { families: string[]; ambiguousKey: string | null } {
  const one = (row: ProductRow, key: string) => {
    const families = familiesOf(row, catalog)
    return { families, ambiguousKey: families.length > 1 ? key : null }
  }
  const byId = ad.productId ? catalog.byId.get(ad.productId) : undefined
  if (byId) return one(byId, ad.asin?.trim() ? asinOf(ad.asin) : byId.sku)
  const bySku = ad.sku?.trim() ? catalog.bySku.get(ad.sku.trim()) : undefined
  if (bySku) return one(bySku, ad.sku!.trim())
  const rows = ad.asin?.trim() ? catalog.byAsin.get(asinOf(ad.asin)) ?? [] : []
  const families = [...new Set(rows.flatMap((r) => familiesOf(r, catalog)))].sort()
  return { families, ambiguousKey: families.length > 1 ? asinOf(ad.asin!) : null }
}

/** The owner of a campaign from the families its ads advertise and how many ads Nexus could not tie. */
export function ownerOf(families: ReadonlySet<string> | readonly string[], unresolved: number): CampaignOwner {
  const list = [...new Set(families)].sort()
  if (!list.length) return { kind: 'none' }
  if (list.length === 1 && unresolved === 0) return { kind: 'product', productId: list[0] }
  return { kind: 'shared', productIds: list }
}

/** Tie every ad of these campaigns (pure): the families, the ads it could not tie, the ambiguous keys, per campaign. */
export function tieCampaigns(campaignIds: readonly string[], ads: readonly AdRef[], catalog: Catalog): Map<string, { productIds: string[]; unresolved: string[]; ambiguous: string[]; owner: CampaignOwner }> {
  const acc = new Map(campaignIds.map((id) => [id, { families: new Set<string>(), unresolved: [] as string[], ambiguous: new Set<string>() }]))
  for (const ad of ads) {
    const c = acc.get(ad.campaignId)
    if (!c) continue
    const tied = tieAd(ad, catalog)
    if (!tied.families.length) c.unresolved.push(ad.asin?.trim() ? asinOf(ad.asin) : ad.sku?.trim() || ad.productId || 'an ad with no ASIN or SKU')
    for (const f of tied.families) c.families.add(f)
    if (tied.ambiguousKey) c.ambiguous.add(tied.ambiguousKey)
  }
  return new Map([...acc].map(([id, c]) => [id, {
    productIds: [...c.families].sort(),
    unresolved: [...new Set(c.unresolved)].sort(),
    ambiguous: [...c.ambiguous].sort(),
    owner: ownerOf(c.families, c.unresolved.length),
  }]))
}

/** The live product rows these ads may name (one query), and the variations whose ASIN a parentless row carries (one more). */
async function loadCatalog(ads: readonly AdRef[]): Promise<Catalog> {
  const ids = [...new Set(ads.map((a) => a.productId).filter((v): v is string => !!v))]
  const skus = [...new Set(ads.map((a) => a.sku?.trim()).filter((v): v is string => !!v))]
  const asins = [...new Set(ads.map((a) => (a.asin?.trim() ? asinOf(a.asin) : null)).filter((v): v is string => !!v))]
  if (!ids.length && !skus.length && !asins.length) return buildCatalog([])
  const rows = await prisma.product.findMany({
    where: {
      deletedAt: null,
      OR: [
        ...(ids.length ? [{ id: { in: ids } }] : []),
        ...(skus.length ? [{ sku: { in: skus } }] : []),
        ...(asins.length ? [{ amazonAsin: { in: asinForms(asins) } }] : []),
      ],
    },
    select: { id: true, parentId: true, amazonAsin: true, sku: true },
  })
  return buildCatalog(rows, await variationsCarrying(rows))
}

/** The live variations that carry the ASIN of a parentless row (RD.10h: the same Amazon product under a second SKU). */
async function variationsCarrying(rows: readonly ProductRow[]): Promise<Array<{ parentId: string; amazonAsin: string | null }>> {
  const asins = [...new Set(rows.filter((r) => !r.parentId && r.amazonAsin?.trim()).map((r) => asinOf(r.amazonAsin!)))]
  if (!asins.length) return []
  const found = await prisma.product.findMany({ where: { deletedAt: null, parentId: { not: null }, amazonAsin: { in: asinForms(asins) } }, select: { parentId: true, amazonAsin: true } })
  return found.flatMap((v) => (v.parentId ? [{ parentId: v.parentId, amazonAsin: v.amazonAsin }] : []))
}

/**
 * Who owns each of these campaigns (ids not in this business are left out). Four queries at most: the campaigns, their
 * serving ads, the products the ads name, and the variations that carry a parentless product's ASIN.
 */
export async function resolveCampaignOwnership(campaignIds: readonly string[]): Promise<Map<string, CampaignOwnership>> {
  const ids = [...new Set(campaignIds.filter(Boolean))]
  if (!ids.length) return new Map()
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, marketplace: true, adProduct: true, status: true } })
  if (!campaigns.length) return new Map()
  const rows = await prisma.adProductAd.findMany({
    where: { status: { not: 'ARCHIVED' }, adGroup: { campaignId: { in: campaigns.map((c) => c.id) }, status: { not: 'ARCHIVED' } } },
    select: { productId: true, asin: true, sku: true, adGroup: { select: { campaignId: true } } },
  })
  const ads: AdRef[] = rows.map((r) => ({ campaignId: r.adGroup.campaignId, productId: r.productId, asin: r.asin, sku: r.sku }))
  const tied = tieCampaigns(campaigns.map((c) => c.id), ads, await loadCatalog(ads))
  return new Map(campaigns.map((c) => [c.id, {
    campaignId: c.id, name: c.name, market: strategyMarket(c.marketplace), adProduct: c.adProduct, status: String(c.status), ...tied.get(c.id)!,
  }]))
}

/**
 * The family root of a product (a variation → its parent; a parentless row whose ASIN one family's variation carries →
 * that family), with the family's live members: what an enrollment is keyed by. Null: no live product with this id, or
 * a parentless row whose ASIN variations of several families carry (Nexus cannot say whose product it is).
 */
export async function productFamily(productId: string): Promise<{ root: string; members: ProductRow[] } | null> {
  const self = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, parentId: true, amazonAsin: true, sku: true } })
  if (!self) return null
  const families = familiesOf(self, buildCatalog([self], await variationsCarrying([self])))
  if (families.length !== 1) return null
  const root = families[0]
  const members = await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: root }, { parentId: root }] }, select: { id: true, parentId: true, amazonAsin: true, sku: true } })
  // RD.10h — parentless rows that carry a variation's ASIN belong to the family too (FBA beside FBM).
  const variationAsins = [...new Set(members.filter((m) => m.parentId && m.amazonAsin?.trim()).map((m) => asinOf(m.amazonAsin!)))]
  const dupes = variationAsins.length
    ? await prisma.product.findMany({ where: { deletedAt: null, parentId: null, id: { notIn: members.map((m) => m.id) }, amazonAsin: { in: asinForms(variationAsins) } }, select: { id: true, parentId: true, amazonAsin: true, sku: true } })
    : []
  return { root, members: [...members, ...dupes] }
}

/**
 * The Sponsored Products campaigns of one market that advertise a product family (archived campaigns left out), split
 * by owner: `owned` — this family's alone (its brain owns them); `shared` — with another family or an ad Nexus cannot
 * tie. Null when the product has no family root (productFamily). The brain runs Sponsored Products only (design §7).
 */
export async function productCampaigns(productId: string, market: string): Promise<{ root: string; owned: CampaignOwnership[]; shared: CampaignOwnership[] } | null> {
  const family = await productFamily(productId)
  if (!family) return null
  const memberIds = family.members.map((m) => m.id)
  const skus = family.members.map((m) => m.sku)
  const asins = [...new Set(family.members.map((m) => m.amazonAsin?.trim()).filter((a): a is string => !!a).map(asinOf))]
  const candidates = await prisma.campaign.findMany({
    where: {
      adProduct: 'SPONSORED_PRODUCTS',
      status: { not: 'ARCHIVED' },
      adGroups: { some: { status: { not: 'ARCHIVED' }, productAds: { some: {
        status: { not: 'ARCHIVED' },
        OR: [{ productId: { in: memberIds } }, { sku: { in: skus } }, ...(asins.length ? [{ asin: { in: asinForms(asins) } }] : [])],
      } } } },
    },
    select: { id: true, marketplace: true },
  })
  const want = strategyMarket(market)
  const owners = await resolveCampaignOwnership(candidates.filter((c) => strategyMarket(c.marketplace) === want).map((c) => c.id))
  const mine = [...owners.values()]
    .filter((o) => o.market === want && o.productIds.includes(family.root))
    .sort((a, b) => a.name.localeCompare(b.name) || a.campaignId.localeCompare(b.campaignId))
  return {
    root: family.root,
    owned: mine.filter((o) => o.owner.kind === 'product'),
    shared: mine.filter((o) => o.owner.kind === 'shared'),
  }
}
