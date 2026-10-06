/**
 * ADS PLAYBOOK PB-7 — what one isolation run reads: the product's own scope, and the facts the pure planner
 * (isolation.ts) judges each negative on. Reads only, through the business-scoped client.
 *
 * Scope (the Owner's rule 3, first layer): the ad groups of the playbook row's slot links (AdsPlaybookLink kind 'slot':
 * one campaign plays one slot of one playbook) whose campaign runs in the rule's market and is not archived, and whose
 * product ads are ALL this product family's (the row's product with its parent's variants, read now: the same product
 * the harvest's home is, ads-winner-lock.ts familyOfProducts). Everything left out is named with its reason: a
 * campaign that also advertises another product, one in another market, an archived one, a slot the rule does not know.
 *
 * Winners: the search terms that meet the ads strategy's harvest bar in each scope ad group, over the strategy's own
 * window for that ad group (ads-harvest.service.ts homeWinners: the bar the harvest asks, the rule's fallbacks where the
 * strategy sets none). No number of its own.
 */
import prisma from '../../../db.js'
import { HARVEST_DEFAULTS } from '@nexus/shared/ads-rule-window'
import { homeWinners, searchTermTotals, winnerKey } from '../ads-harvest.service.js'
import { loadProtectedTerms, type ProtectedTerm } from '../ads-negation-policy.js'
import { normaliseNegTerm } from '../ads-protect-converting.js'
import { openTermsStrategy, strategyMarketOf } from '../ads-strategy/terms.js'
import { familyOfProducts, familyOnly, positivesIn, standingNegativesIn, type Positive, type ProductFamily } from '../ads-winner-lock.js'
import { playbookLinks, waitingSyncedTargets } from './load.js'
import type { IsolationAction, IsolationSlot, ScopeGroup } from './isolation.js'

export interface Excluded { slot: string; campaignId: string; adGroupId: string | null; why: string }

export interface IsolationInputs {
  /** The playbook row's product (a parent or a variation) and the family the scope is held to. */
  productId: string
  family: ProductFamily
  scope: ScopeGroup[]
  excluded: Excluded[]
  positives: Map<string, Positive[]>
  winners: Map<string, Set<string>>
  standing: Set<string>
  protections: Map<string, ProtectedTerm[]>
  /** PB-10 — keywords a sync added at the floor, not given their bid yet (marked `waiting` in `positives`): no home. */
  waiting: Set<string>
}

/** A hero (PB-6c: a winner's own campaign, link key `hero:<term>`) holds one exact keyword: an Exact slot. */
const HERO_SLOT: IsolationSlot = { role: 'exact', match: 'EXACT', intent: 'ANY' }

/**
 * The search terms that meet the harvest bar in each of these ad groups (normalised), by AdGroup.id. The terms are
 * listed over the widest window any bar uses; each is then judged by its own ad group's bar and window.
 */
export async function scopeWinners(adGroupIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  if (!adGroupIds.length) return out
  const groups = await prisma.adGroup.findMany({ where: { id: { in: [...adGroupIds] } }, select: { id: true, externalAdGroupId: true } })
  const idOf = new Map(groups.filter((g) => g.externalAdGroupId).map((g) => [g.externalAdGroupId!, g.id]))
  if (!idOf.size) return out
  const strategy = await openTermsStrategy()
  const widest = Math.max(HARVEST_DEFAULTS.windowDays, ...(strategy?.windows ?? []))
  const pairs = [...(await searchTermTotals(widest, [...idOf.keys()])).values()]
    .map((t) => ({ term: t.query, adGroupId: idOf.get(t.externalAdGroupId)! }))
    .filter((p) => p.adGroupId)
  const winners = await homeWinners(pairs, { defaults: { ...HARVEST_DEFAULTS } })
  for (const p of pairs) {
    if (!winners.has(winnerKey(p.term, p.adGroupId))) continue
    out.set(p.adGroupId, (out.get(p.adGroupId) ?? new Set()).add(normaliseNegTerm(p.term)))
  }
  return out
}

/**
 * Is the product still in its playbook, and not stopped? Each from the row itself, else from its parent's row in the
 * same market (resolve.ts: a product's own fields come from its row, else its parent's; Owner decision D-PB4).
 */
export async function playbookStanding(row: { scopeId: string; market: string; channel: string; enrolled: boolean | null; state: string | null }): Promise<{ enrolled: boolean; state: string | null }> {
  let parentRow: { enrolled: boolean | null; state: string | null } | null = null
  if (row.enrolled == null || row.state == null) {
    const product = await prisma.product.findUnique({ where: { id: row.scopeId }, select: { parentId: true } })
    parentRow = product?.parentId
      ? await prisma.adsPlaybook.findFirst({ where: { channel: row.channel, market: row.market, level: 'PRODUCT', scopeId: product.parentId }, select: { enrolled: true, state: true } })
      : null
  }
  return { enrolled: (row.enrolled ?? parentRow?.enrolled) === true, state: row.state ?? parentRow?.state ?? null }
}

/** Why a playbook row runs no isolation now (not enrolled, stopped), or null. */
export function standingRefusal(s: { enrolled: boolean; state: string | null }): string | null {
  if (!s.enrolled) return 'The product is no longer in its ads playbook (not enrolled), so nothing is kept apart.'
  if (s.state === 'STOPPED') return 'The product\'s ads playbook is stopped, so nothing is kept apart until it starts again.'
  return null
}

/** One run's inputs, or why there is no run (the playbook row is gone or not a product's, the product left it, it is stopped). */
export async function loadIsolation(action: Pick<IsolationAction, 'playbookId' | 'market' | 'slots'>): Promise<{ inputs: IsolationInputs } | { refused: string }> {
  const row = await prisma.adsPlaybook.findUnique({ where: { id: action.playbookId }, select: { id: true, level: true, scopeId: true, market: true, channel: true, enrolled: true, state: true } })
  if (!row) return { refused: 'The playbook this rule was compiled from is gone, so nothing is kept apart.' }
  if (row.level !== 'PRODUCT') return { refused: 'This rule names a market or category playbook; isolation runs only inside one product\'s own campaigns.' }
  const market = strategyMarketOf(action.market)
  if (strategyMarketOf(row.market) !== market) return { refused: `The playbook is for ${row.market}, not ${action.market}: the rule is out of date, so nothing is kept apart.` }
  const standing = standingRefusal(await playbookStanding(row))
  if (standing) return { refused: standing }

  const family = await familyOfProducts([row.scopeId])
  const links = (await playbookLinks([row.id])).filter((l) => l.kind === 'slot')
  const campaigns = links.length
    ? await prisma.campaign.findMany({
      where: { id: { in: links.map((l) => l.refId) } },
      select: { id: true, status: true, marketplace: true, adGroups: { select: { id: true, name: true, status: true } } },
    })
    : []
  const byId = new Map(campaigns.map((c) => [c.id, c]))
  const excluded: Excluded[] = []
  const candidates: ScopeGroup[] = []
  for (const link of links) {
    const out = (why: string, adGroupId: string | null = link.adGroupId) => excluded.push({ slot: link.key, campaignId: link.refId, adGroupId, why })
    const slot = action.slots[link.key] ?? (link.key.startsWith('hero:') ? HERO_SLOT : null)
    if (!slot) { out('the compiled rule does not know this slot; it is kept out until the rule is compiled again'); continue }
    const c = byId.get(link.refId)
    if (!c) { out('its campaign is gone'); continue }
    if (String(c.status) === 'ARCHIVED') { out('its campaign is archived'); continue }
    if (strategyMarketOf(c.marketplace) !== market) { out(`its campaign runs in ${c.marketplace ?? 'no market'}, not ${action.market}`); continue }
    const groups = c.adGroups.filter((g) => String(g.status) !== 'ARCHIVED' && (!link.adGroupId || g.id === link.adGroupId))
    if (!groups.length) { out(link.adGroupId ? 'its ad group is no longer in the campaign, or is archived' : 'its campaign has no ad group'); continue }
    for (const g of groups) candidates.push({ adGroupId: g.id, campaignId: c.id, slot: link.key, ...slot, name: g.name })
  }
  const owned = await familyOnly(candidates.map((g) => g.adGroupId), family)
  const ok = new Set(owned.ok)
  for (const e of owned.excluded) {
    const g = candidates.find((x) => x.adGroupId === e.adGroupId)!
    excluded.push({ slot: g.slot, campaignId: g.campaignId, adGroupId: g.adGroupId, why: e.why })
  }
  const scope = candidates.filter((g) => ok.has(g.adGroupId))
  const ids = scope.map((g) => g.adGroupId)
  const marketOf = new Map(campaigns.map((c) => [c.id, c.marketplace]))
  const campaignIds = [...new Set(scope.map((g) => g.campaignId))]
  const [positives, standingNegatives, winners, waiting] = await Promise.all([positivesIn(ids), standingNegativesIn(ids), scopeWinners(ids), waitingSyncedTargets(row.id, 2)])
  if (waiting.size) for (const list of positives.values()) for (const p of list) if (waiting.has(p.adTargetId)) p.waiting = true
  // The protected terms that bind a negative in each campaign, as the write gate reads them (one read per campaign).
  const protections = new Map<string, ProtectedTerm[]>()
  for (const id of campaignIds) protections.set(id, await loadProtectedTerms({ marketplace: marketOf.get(id) ?? null, campaignId: id }))
  return { inputs: { productId: row.scopeId, family, scope, excluded, positives, winners, standing: standingNegatives, protections, waiting } }
}
