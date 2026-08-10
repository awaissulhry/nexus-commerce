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
