/**
 * RA.GRAIN — what does a proposed rule scope actually cover?
 *
 * One resolver, because the number has to be identical in three places: the reach line the
 * operator reads before binding, the refusal that stops a combination which can never fire, and
 * the evaluator's own enforcement. Three implementations of "which campaigns" would drift, and a
 * reach line that disagrees with enforcement is worse than no reach line.
 *
 * The four dimensions AND together, which is what `ruleMatchesScope` already does. Measured on
 * prod 2026-08-10, only one of the six pairings buys anything:
 *   · market × portfolio  — REDUNDANT. No portfolio in this account spans more than one market.
 *   · market × campaign   — REDUNDANT. A campaign has exactly one market.
 *   · portfolio × campaign— redundant or contradictory; the write path keeps them exclusive.
 *   · market × product    — GENUINELY USEFUL. 106 of 250 ASINs span >1 market, max 4. The GALE
 *     line runs in all four: IT 32 · DE 22 · FR 14 · ES 9. "GALE in DE only" was inexpressible.
 *
 * A combination resolving to ZERO campaigns is refused rather than stored. That is the house rule
 * applied to scope: a rule bound to "DE" and to a campaign that lives in IT can never fire, and
 * silently keeping it would look armed and do nothing forever.
 */
import prisma from '../../db.js'

export interface ScopeSelection {
  marketplace?: string | null
  portfolioId?: string | null
  campaignId?: string | null
  /** A `Product.id` — either a PARENT (the whole line) or one child variation. */
  productId?: string | null
}

export interface ScopeReach {
  /** Local Campaign.ids the scope resolves to. */
  campaignIds: string[]
  /** Campaigns in the account, so the UI can say "N of M". */
  total: number
  /** Which dimensions were applied, in the order they narrowed. */
  applied: string[]
  /** Non-fatal facts the operator should see — e.g. the portfolio blind spot. */
  notes: string[]
  /** Set when the combination can never fire, naming the pair that conflicts. */
  contradiction?: string
}

/**
 * Expand a chosen product into the product ids a rule scoped to it should match.
 *
 * A parent expands to itself plus its children — that IS the product line, and it is already
 * modelled (`Product.parentId`, self-relation `ProductHierarchy`). A child expands to itself
 * alone. Measured: all 223 advertised products are children of exactly 13 parents, so the line
 * grain needs no heuristic and the picker needs 13 rows, not 223.
 */
export async function expandProductScope(productId: string): Promise<string[]> {
  const children = await prisma.product.findMany({ where: { parentId: productId }, select: { id: true } })
  return children.length ? [productId, ...children.map((c) => c.id)] : [productId]
}

/** Campaign ids that advertise any of these products, via AdProductAd → AdGroup → Campaign. */
async function campaignsForProducts(productIds: string[]): Promise<string[]> {
  if (productIds.length === 0) return []
  const rows = await prisma.adProductAd.findMany({
    where: { productId: { in: productIds } },
    select: { adGroup: { select: { campaignId: true } } },
  })
  return [...new Set(rows.map((r) => r.adGroup?.campaignId).filter((x): x is string => !!x))]
}

export async function resolveScopeReach(sel: ScopeSelection): Promise<ScopeReach> {
  const total = await prisma.campaign.count()
  const applied: string[] = []
  const notes: string[] = []

  // Start from the campaigns the market/portfolio/campaign dimensions allow. Doing it in one
  // query rather than three intersections keeps the numbers consistent with `ruleMatchesScope`,
  // which applies all of them to the same context.
  const where: Record<string, unknown> = {}
  if (sel.marketplace) { where.marketplace = sel.marketplace; applied.push(`market ${sel.marketplace}`) }
  if (sel.campaignId) { where.id = sel.campaignId; applied.push('one campaign') }
  if (sel.portfolioId) { where.portfolioId = sel.portfolioId; applied.push('one portfolio') }

  const base = await prisma.campaign.findMany({ where, select: { id: true } })
  let ids = base.map((c) => c.id)

  if (sel.portfolioId) {
    // The blind spot is a fact about the account, not about this selection, so it is stated
    // whenever a portfolio is chosen — including when the chosen one is healthy.
    const orphans = await prisma.campaign.count({ where: { portfolioId: null } })
    if (orphans > 0) {
      notes.push(`${orphans} of ${total} campaigns carry no portfolio at all, so no portfolio binding can ever reach them`)
    }
  }

  if (sel.productId) {
    const expanded = await expandProductScope(sel.productId)
    // ADVERTISED children, not catalogue children. GALE-JACKET has 40 children in the PIM and 18
    // of them are advertised; saying "40 variations" here while the picker says 18 would be two
    // numbers for one thing, and only the advertised count explains the reach beside it.
    const advertised = await prisma.adProductAd.findMany({
      where: { productId: { in: expanded } },
      select: { productId: true, adGroup: { select: { campaignId: true } } },
    })
    const advertisedProducts = new Set(advertised.map((a) => a.productId).filter((x): x is string => !!x))
    const productCampaigns = new Set(advertised.map((a) => a.adGroup?.campaignId).filter((x): x is string => !!x))
    const isLine = expanded.length > 1
    applied.push(isLine ? `one product line (${advertisedProducts.size} advertised variations)` : 'one product')
    ids = Object.keys(where).length === 0 ? [...productCampaigns] : ids.filter((id) => productCampaigns.has(id))
    if (productCampaigns.size === 0) {
      notes.push(isLine
        ? 'no variation of this product line is advertised by any campaign yet'
        : 'this product is not advertised by any campaign yet')
    } else if (isLine && advertisedProducts.size < expanded.length - 1) {
      notes.push(`${expanded.length - 1 - advertisedProducts.size} of this line's ${expanded.length - 1} variations are not advertised anywhere, so no binding can reach them`)
    }
  }

  const reach: ScopeReach = { campaignIds: ids, total, applied, notes }

  // A narrowed-to-nothing scope is a rule that can never fire. Name the pair, because "0
  // campaigns" alone does not tell an operator which of their two choices to change.
  if (ids.length === 0 && applied.length > 0) {
    reach.contradiction = applied.length === 1
      ? `${applied[0]} matches no campaign in this account`
      : `${applied.join(' + ')} have no campaign in common — a rule scoped this way could never fire`
  }
  return reach
}

/**
 * Scope filter (2026-10-12) — the ids of a scoped read (ads-scope-lists.ts) that are not this business's, in the words
 * the Bid and Negative Targeting reads give a singular param: the first unknown id named, campaigns, then ad groups (an
 * ad group outside every campaign named is not found "and campaign"), portfolios, products. Null: every id is known. The
 * client is the business's, so another business's id reads exactly as one that does not exist.
 */
export async function unknownScopeId(l: { campaignIds?: readonly string[] | null; adGroupIds?: readonly string[] | null; portfolioIds?: readonly string[] | null; productIds?: readonly string[] | null }): Promise<string | null> {
  const missing = (asked: readonly string[], found: Iterable<string | null>) => {
    const have = new Set(found)
    return asked.find((id) => !have.has(id)) ?? null
  }
  const campaigns = l.campaignIds?.length ? l.campaignIds : null
  if (campaigns) {
    const id = missing(campaigns, (await prisma.campaign.findMany({ where: { id: { in: [...campaigns] } }, select: { id: true } })).map((c) => c.id))
    if (id) return `No campaign ${id} in this business.`
  }
  if (l.adGroupIds?.length) {
    const groups = await prisma.adGroup.findMany({ where: { id: { in: [...l.adGroupIds] } }, select: { id: true, campaignId: true } })
    const id = missing(l.adGroupIds, groups.filter((g) => !campaigns || campaigns.includes(g.campaignId)).map((g) => g.id))
    if (id) return `No ad group ${id} in this business${campaigns ? ` and campaign${campaigns.length > 1 ? 's' : ''}` : ''}.`
  }
  if (l.portfolioIds?.length) {
    const rows = await prisma.campaign.findMany({ where: { portfolioId: { in: [...l.portfolioIds] } }, select: { portfolioId: true }, distinct: ['portfolioId'] })
    const id = missing(l.portfolioIds, rows.map((r) => r.portfolioId))
    if (id) return `No portfolio ${id} in this business.`
  }
  if (l.productIds?.length) {
    const id = missing(l.productIds, (await prisma.product.findMany({ where: { id: { in: [...l.productIds] } }, select: { id: true } })).map((p) => p.id))
    if (id) return `No product ${id} in this business.`
  }
  return null
}

/** Scope filter (2026-10-12) — every ad group not archived, for GET /advertising/scope-options (the picker's Ad group list). */
export async function scopeAdGroups(): Promise<Array<{ id: string; name: string; campaignId: string; status: string }>> {
  const rows = await prisma.adGroup.findMany({
    where: { status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, campaignId: true, status: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  })
  return rows.map((g) => ({ id: g.id, name: g.name, campaignId: g.campaignId, status: String(g.status) }))
}
