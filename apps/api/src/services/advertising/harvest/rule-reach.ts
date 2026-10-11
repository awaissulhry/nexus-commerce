/**
 * HARVEST ENGINE — which rules are harvest rules, and which campaigns each reaches (the evaluator's own matcher,
 * ads-rule-reach.service.ts campaignsReachedBy). Read only.
 */
import prisma from '../../../db.js'
import { resolveAutonomy } from '../ads-autonomy.js'
import { normalizeHarvestWire } from '../ads-harvest-wire.js'
import { campaignsReachedBy, type CampaignIdentity, type ReachRule } from '../ads-rule-reach.service.js'
import { strategyMarket } from '../ads-strategy/bids.js'

/** The action types that make a rule a harvest rule (the Keyword Harvest tab's own list, plus the builder's slug). */
export const HARVEST_RULE_ACTION_TYPES: ReadonlySet<string> = new Set(['harvest_and_negate', 'promote_to_exact', 'keyword-harvesting'])
/** An archived ads rule's domain (bid-rules/pure.ts ARCHIVED_ADS_DOMAIN): inert, out of every list, reversible. */
export const ARCHIVED_ADS_DOMAIN = 'advertising-archived'

export function isHarvestRule(actions: unknown): boolean {
  return (Array.isArray(actions) ? actions : []).some((a) => HARVEST_RULE_ACTION_TYPES.has(String((a as { type?: unknown } | null)?.type ?? '')))
}

export interface HarvestRuleLite { id: string; name: string; level: string; scopeMarketplace: string | null }

/**
 * Release safety (Keyword Harvest re-review) — a harvest rule acts alone on Auto only once a person picked Auto for it
 * through the harvest path after the release (POST /harvest/rules/mode: the Rules view, the rule editor, Claude's
 * set-harvest-rules). That pick stores `actions[0].harvestAuto = { confirmedAt, by }`; any other mode clears it. A rule
 * at Auto without it — every rule saved before — keeps asking. Pure.
 */
export function harvestAutoConfirmed(actions: unknown): boolean {
  const a0 = (Array.isArray(actions) ? actions[0] : null) as { harvestAuto?: { confirmedAt?: unknown } | null } | null
  return typeof a0?.harvestAuto?.confirmedAt === 'string' && !!a0.harvestAuto.confirmedAt
}
export const PICK_AUTO_AGAIN = { kind: 'graduation' as const, label: 'Pick Auto again', reason: 'Pick Auto again to let it act: until then it asks.' }

/**
 * The ad groups a harvest rule is bound to, as its run reads them: a builder rule (keyword-harvesting) by its mapping
 * (ads-harvest-wire.ts normalizeHarvestWire / matchedBlocks — a paused entry is out of both sides, HP2; a mapping whose
 * entries are all paused binds nothing), an engine rule (harvest_and_negate) by its `sources` (the ad groups it harvests
 * from, `harvestFrom`, and the places they send to — automation-action-handlers.ts AT.4b: a rule with sources harvests
 * only there). `look` = where it finds terms, `create` = where it adds keywords. Null when it names no ad group: it then
 * reaches by its scope (market, portfolio(s), campaign(s), product). Pure.
 */
export function mappingGroupsOf(actions: unknown): { look: string[]; create: string[] } | null {
  const a0 = Array.isArray(actions) ? (actions[0] as Record<string, unknown> | null | undefined) : undefined
  if (!a0) return null
  if (a0.type === 'harvest_and_negate' && Array.isArray(a0.sources) && a0.sources.length) {
    const rows = a0.sources as Array<{ adGroupId?: unknown; harvestFrom?: unknown; destinations?: Record<string, unknown> | null }>
    return {
      look: [...new Set(rows.filter((r) => r.harvestFrom === true && typeof r.adGroupId === 'string').map((r) => String(r.adGroupId)))],
      create: [...new Set(rows.flatMap((r) => Object.values(r.destinations ?? {}).filter((g): g is string => typeof g === 'string' && !!g)))],
    }
  }
  if (a0.type !== 'keyword-harvesting') return null
  const wire = normalizeHarvestWire(a0)
  if (!wire.blocks) return null
  return { look: [...new Set(wire.blocks.flatMap((b) => b.look))], create: [...new Set(wire.blocks.flatMap((b) => b.create.map((c) => c.adGroupId)))] }
}

export interface HarvestRuleReachOf {
  /** The campaigns it really reaches: its scope's (the evaluator's own matcher), narrowed to its mapped ad groups' campaigns. */
  campaigns: CampaignIdentity[]
  /** A mapping-bound rule's ad groups (sources and destinations) inside those campaigns; null: every ad group of them. */
  adGroups: string[] | null
  /** A mapping-bound rule's sources (look) inside its scope; null: every ad group of its campaigns. */
  look: string[] | null
  /** The campaign of each mapped ad group. */
  campaignOf: ReadonlyMap<string, string>
}

/** What each harvest rule really reaches (one campaign load, one ad-group read for every mapping). */
export async function harvestRulesReach(rules: Array<ReachRule & { actions?: unknown }>): Promise<Map<string, HarvestRuleReachOf>> {
  const out = new Map<string, HarvestRuleReachOf>()
  if (!rules.length) return out
  const reached = await campaignsReachedBy(rules)
  const maps = new Map(rules.map((r) => [r.id, mappingGroupsOf(r.actions)]))
  const groupIds = [...new Set([...maps.values()].flatMap((m) => (m ? [...m.look, ...m.create] : [])))]
  const campaignOf = new Map((groupIds.length ? await prisma.adGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, campaignId: true } }) : []).map((g) => [g.id, g.campaignId]))
  for (const r of rules) {
    const all = reached.byRule.get(r.id) ?? []
    const m = maps.get(r.id)
    if (!m) { out.set(r.id, { campaigns: all, adGroups: null, look: null, campaignOf: new Map() }); continue }
    const inScope = new Set(all.map((c) => c.id))
    const keep = (id: string) => { const c = campaignOf.get(id); return !!c && inScope.has(c) }
    const groups = [...new Set([...m.look, ...m.create])].filter(keep)
    const campaigns = new Set(groups.map((id) => campaignOf.get(id)!))
    out.set(r.id, { campaigns: all.filter((c) => campaigns.has(c.id)), adGroups: groups, look: m.look.filter(keep), campaignOf: new Map(groups.map((id) => [id, campaignOf.get(id)!])) })
  }
  return out
}

/** The harvest rules (on, not archived) of a market: by campaign (a rule that reaches by its scope), by ad group (a builder
 *  rule bound to the ad groups its mapping reads). */
export interface HarvestReach { campaign: Map<string, HarvestRuleLite[]>; adGroup: Map<string, HarvestRuleLite[]> }

/** The rules on one source ad group: those whose scope reaches its campaign, and those whose mapping reads it. */
export function rulesAt(reach: HarvestReach, campaignId: string | null, adGroupId: string | null): HarvestRuleLite[] {
  const out = new Map<string, HarvestRuleLite>()
  for (const r of (campaignId ? reach.campaign.get(campaignId) : null) ?? []) out.set(r.id, r)
  for (const r of (adGroupId ? reach.adGroup.get(adGroupId) : null) ?? []) out.set(r.id, r)
  return [...out.values()]
}

/** Per campaign and per source ad group of the market: the harvest rules (on, not archived) that reach it. */
export async function harvestRuleReach(market: string | null): Promise<HarvestReach> {
  const rules = (await prisma.automationRule.findMany({
    where: { domain: 'advertising' },
    select: { id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, actions: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true },
  })).filter((r) => isHarvestRule(r.actions) && resolveAutonomy(r) !== 'OFF')
  const out: HarvestReach = { campaign: new Map(), adGroup: new Map() }
  if (!rules.length) return out
  const reached = await harvestRulesReach(rules as unknown as Array<ReachRule & { actions?: unknown }>)
  const add = (map: Map<string, HarvestRuleLite[]>, key: string, lite: HarvestRuleLite) => map.set(key, [...(map.get(key) ?? []), lite])
  for (const r of rules) {
    const got = reached.get(r.id)
    if (!got) continue
    const lite: HarvestRuleLite = { id: r.id, name: r.name, level: resolveAutonomy(r), scopeMarketplace: r.scopeMarketplace }
    const live = got.campaigns.filter((c) => c.status !== 'ARCHIVED' && (!market || strategyMarket(c.marketplace) === market))
    // A mapping-bound builder rule reads only the ad groups its mapping names, never every ad group of their campaigns.
    if (got.look) {
      const liveIds = new Set(live.map((c) => c.id))
      for (const g of got.look) if (liveIds.has(got.campaignOf.get(g) ?? '')) add(out.adGroup, g, lite)
      continue
    }
    for (const c of live) add(out.campaign, c.id, lite)
  }
  return out
}
