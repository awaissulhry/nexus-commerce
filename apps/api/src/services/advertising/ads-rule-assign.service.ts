/**
 * ADS AUTONOMY W4-8 — which campaigns an Amazon ads rule acts on, changed in bulk (Claude's assign-ad-rules: add, remove
 * or replace), through the screens' own paths — the ones the rule engine reads (ads-rule-scope-resolver.ts):
 *
 *   picker      a builder rule (Budget, Bid, SOV, Keyword Tracker, Placement) is bound by its own picker list
 *               (`actions[0].campaigns`). Written by the rule drawer's save (updateAdsRule, the PATCH
 *               /advertising/automation-rules/:id route): it refuses picks the rule can never fire on (outside its
 *               market, a Placement pick that is not Sponsored Products), audits, and mirrors a Budget rule's picks
 *               into the Apply Rules column. An empty list means "every campaign" for every kind but Budget, so a
 *               request that would empty one is refused.
 *   assignment  an engine-native budget rule (`adjust_ad_budget`) is bound by CampaignRuleAssignment rows. Written by the
 *               Apply Rules page's one Apply (applyCampaignRuleAssignments): one transaction, set-replacement per
 *               campaign — each campaign keeps every other rule it is bound to.
 *
 * Any other rule is not bound to campaigns (its scope decides: save-ad-rule), or is bound by the autopilot plan that
 * made it: refused, naming the way. Nexus only: nothing is sent to Amazon; the rule acts as itself, at its own level, on
 * its next run.
 *
 * The live case this answers (10-07): a rule named for one market bound to campaigns of four. The plan lists each
 * campaign's market and warns when it differs from the rule's market — its scope, else the market its name ends with.
 */
import prisma from '../../db.js'
import { MARKETPLACE_ID_TO_CODE } from '../../utils/marketplace-code.js'
import { builderBudgetCampaignIds, builderDraftCampaignIds, isEngineBudgetRule } from './ads-rule-adapter.service.js'
import { resolveAutonomy } from './ads-autonomy.js'
import type { AdsActor } from './ads-mutation.service.js'

export const ASSIGN_OPS = ['add', 'remove', 'replace'] as const
export type AssignOp = (typeof ASSIGN_OPS)[number]
/** The most campaigns one request names (the tool contract bounds every list to 250). */
export const MAX_ASSIGN_CAMPAIGNS = 250

export interface AssignInput { ruleId: string; op: AssignOp; campaignIds: string[] }

/** How the rule is bound: its own picker list, or the Apply Rules column's rows. */
export type Binding = 'picker' | 'assignment'

/** What a change record stores, and what undo compares: the rule and every campaign it is bound to (sorted). */
export interface BindingState {
  ruleId: string; name: string; binding: Binding; campaignIds: string[]
  /** A Bid, SOV, Keyword Tracker or Placement rule with no campaigns picked: it acts on every campaign in its scope. */
  all?: true
}

/** The builder kinds bound by a picker list; for all but Budget an empty list means every campaign. */
const PICKER_SLUGS = new Set(['budget', 'bid', 'sov', 'keyword-tracker', 'placement'])
const SLUG_WORDS: Record<string, string> = { budget: 'Budget', bid: 'Bid', sov: 'Share of voice', 'keyword-tracker': 'Keyword Tracker', placement: 'Placement' }
/** The two-letter market codes Nexus knows (GB is UK). */
const MARKET_CODES = new Set([...Object.values(MARKETPLACE_ID_TO_CODE), 'GB'])
/** At most this many campaign lines are listed in a preview; the rest are counted. */
const LINES_SHOWN = 20

type RuleRow = { id: string; name: string; domain: string; enabled: boolean; dryRun: boolean; autonomyLevel: string | null; actions: unknown; conditions: unknown; scopeMarketplace: string | null }
type CampaignRow = { id: string; name: string; marketplace: string | null; status: unknown; targetingType: unknown; adProduct: string | null; dailyBudget: unknown; portfolioId: string | null }

const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort()
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/**
 * The market a rule's NAME ends with, as a separate token after a dash ("… — DE", "… - IT"), when it is a market code
 * Nexus knows, in capitals; null otherwise — so "pause it" or "let it be" name no market. Pure. It only warns: the rule's
 * scope, when set, is what the engine reads.
 */
export function nameMarket(name: string): string | null {
  const m = /[-–—]\s*([A-Z]{2})$/.exec(name.trim())
  if (!m) return null
  const code = m[1]
  return MARKET_CODES.has(code) ? (code === 'GB' ? 'UK' : code) : null
}

/**
 * What a rule's actions can do to spend, read from its own words: `up` (a raise, or a value set either way), `down` (a
 * cut, a negative). A builder rule says it per condition group (`incPct` up, `decPct` down, `set`/`setCpc`/`targetAcos`
 * either way); an engine-native rule per action type. Unknown counts both ways (fail closed). Pure.
 */
export function ruleMoves(rule: { actions: unknown; conditions: unknown }): { up: boolean; down: boolean } {
  const actions = Array.isArray(rule.actions) ? rule.actions.map(obj) : []
  const slug = String(actions[0]?.type ?? '')
  let up = false
  let down = false
  if (PICKER_SLUGS.has(slug)) {
    const groups = (Array.isArray(rule.conditions) ? rule.conditions : []).map(obj).filter((g) => 'action' in g)
    if (!groups.length) return { up: true, down: true }
    for (const g of groups) {
      const op = String(obj(g.action).op ?? 'set')
      if (/^inc/i.test(op) || op === 'enableTarget') up = true
      else if (/^dec/i.test(op) || op === 'pauseTarget') down = true
      else { up = true; down = true }
    }
    return { up, down }
  }
  for (const a of actions) {
    const type = String(a.type ?? '')
    if (type === 'notify' || type === 'log_only') continue
    if (type === 'bid_up') up = true
    else if (type === 'bid_down' || type.startsWith('add_negative') || type.startsWith('pause_')) down = true
    else if (type === 'adjust_ad_budget' && typeof a.percent === 'number' && a.percent !== 0) { if (a.percent > 0) up = true; else down = true }
    else { up = true; down = true }
  }
  return { up, down }
}

/** How a rule is bound to campaigns now, or why assign-ad-rules does not change it. */
async function bindingOf(rule: RuleRow): Promise<{ binding: Binding; slug: string | null; campaignIds: string[]; legacyAll?: boolean } | { refusal: string }> {
  const a0 = Array.isArray(rule.actions) ? obj(rule.actions[0]) : {}
  const slug = String(a0.type ?? '')
  if (PICKER_SLUGS.has(slug)) {
    if (slug === 'budget') {
      const ids = builderBudgetCampaignIds(rule.actions)
      if (ids == null) return { refusal: `"${rule.name}" is a Budget rule that stores no campaign list (it predates the campaign picker), so it is not bound to campaigns: pick its campaigns in the rule drawer in Nexus once, then ask again` }
      return { binding: 'picker', slug, campaignIds: sorted(ids) }
    }
    const ids = builderDraftCampaignIds(rule.actions, slug) ?? []
    // No picks: a Bid, SOV, Keyword Tracker or Placement rule acts on every campaign in its scope.
    return { binding: 'picker', slug, campaignIds: sorted(ids), ...(ids.length ? {} : { legacyAll: true }) }
  }
  if (isEngineBudgetRule(rule.actions)) {
    const links = await prisma.campaignRuleAssignment.findMany({ where: { ruleId: rule.id, kind: 'budget' }, select: { campaignId: true } })
    return { binding: 'assignment', slug: null, campaignIds: sorted(links.map((l) => l.campaignId)) }
  }
  if (slug === 'negative-targeting' || slug === 'keyword-harvesting') {
    return Array.isArray(a0.campaignIds)
      ? { refusal: `"${rule.name}" is bound to its campaigns by the autopilot plan that made it: change that plan instead` }
      : { refusal: `"${rule.name}" is a ${slug === 'negative-targeting' ? 'Negative Targeting' : 'Keyword Harvesting'} rule: it is bound by its ad-group mappings, not by a campaign list. Its mappings are changed in the rule drawer in Nexus` }
  }
  return { refusal: `"${rule.name}" is not bound to campaigns: its scope decides where it acts (a market, a portfolio, one campaign or a product). Change its scope with save-ad-rule (scope)` }
}

/** The binding as a change record stores it, read now (undo compares it with what the change wrote). */
export async function ruleBindingNow(ruleId: string): Promise<BindingState | null> {
  const rule = await prisma.automationRule.findFirst({ where: { id: ruleId, domain: 'advertising' } }) as RuleRow | null
  if (!rule) return null
  const b = await bindingOf(rule)
  if ('refusal' in b) return null
  return { ruleId: rule.id, name: rule.name, binding: b.binding, campaignIds: b.campaignIds, ...(b.legacyAll ? { all: true as const } : {}) }
}

export interface AssignLine {
  campaignId: string
  campaign: string
  market: string | null
  from: 'bound' | 'not bound'
  to: 'bound' | 'not bound'
  /** Its market is not the rule's market. */
  otherMarket?: true
}

export interface AssignPlan {
  action: 'assign-ad-rules'
  op: AssignOp
  rule: { id: string; name: string; level: string; market: string | null; marketFrom: 'scope' | 'name' | null; kind: string }
  binding: Binding
  summary: string
  /** Every campaign it adds or removes (the first LINES_SHOWN), with its market. */
  changes: AssignLine[]
  moreChanges?: number
  totals: { before: number; after: number; added: number; removed: number; alreadyBound: number; notBound: number; otherMarketAfter: number }
  /** The campaigns it is bound to after this change, by market ("12 in DE, 3 in IT"). */
  marketsAfter: Record<string, number>
  /** What its actions can do to spend (ruleMoves): up, down, or both. */
  moves: { up: boolean; down: boolean }
  /** What can raise spend (the approver's code), or empty. */
  raises: string[]
  warnings: string[]
  /** Other enabled rules and schedules already bound to the campaigns it adds (the first LINES_SHOWN). */
  alsoChangedBy: Array<{ campaign: string; by: string[] }>
  /** Nexus only: what it changes and when the rule acts. */
  reach: { nexusOnly: true; note: string }
  effect: string
  /**
   * Every campaign bound before and after, the rule's level and scope: a move of any is a different change. Not its
   * updatedAt: every evaluation of the rule bumps it.
   */
  basis: { before: string[]; after: string[]; level: string; scopeMarketplace: string | null }
  /** For the change record and the write: the full lists. */
  before: BindingState
  after: BindingState
  /** The campaigns it adds and removes (all of them), for the strategy's facts and the place resolver. */
  added: string[]
  removed: string[]
}

const LEVEL_WORDS: Record<string, string> = { OFF: 'Off', OBSERVE: 'Observe', PROPOSE: 'Propose', AUTO: 'Auto' }

/**
 * ONE place decides what needs the approver's authenticator code (the Owner's open question: it can flip here). A rule
 * at Auto writes by itself, so binding it to more campaigns adds spend there when it can raise, and taking campaigns
 * from it adds spend there when it was cutting them. Below Auto nothing it does reaches Amazon without a person.
 */
export function assignRaises(level: string, moves: { up: boolean; down: boolean }, added: number, removed: number, everyOther: boolean): string[] {
  if (level !== 'AUTO') return []
  const out: string[] = []
  if (added && moves.up) out.push(`at Auto, the rule starts acting on ${plural(added, 'more campaign')}, and it can raise what they spend`)
  if ((removed || everyOther) && moves.down) out.push(everyOther ? 'at Auto, the rule stops acting on every other campaign, where it was cutting what they spend' : `at Auto, the rule stops acting on ${plural(removed, 'campaign')}, where it was cutting what they spend`)
  return out
}

/** A request decided: the plan, or why it is refused. Reads only. */
export async function planRuleAssign(input: AssignInput): Promise<{ plan: AssignPlan } | { error: string }> {
  const asked = sorted(input.campaignIds.map((id) => id.trim()).filter(Boolean))
  if (input.op !== 'replace' && !asked.length) return { error: 'Name the campaigns (campaignIds, Nexus ids from ad-campaigns).' }
  if (asked.length > MAX_ASSIGN_CAMPAIGNS) return { error: `${asked.length} campaigns named: at most ${MAX_ASSIGN_CAMPAIGNS} in one request. Split them.` }
  const rule = await prisma.automationRule.findFirst({ where: { id: input.ruleId, domain: 'advertising' } }) as RuleRow | null
  if (!rule) return { error: `Amazon ads rule ${input.ruleId} not found in this business (list-automations A1 lists them).` }
  const bound = await bindingOf(rule)
  if ('refusal' in bound) return { error: `Not queued: ${bound.refusal}.` }

  const found = asked.length ? await prisma.campaign.findMany({ where: { id: { in: asked } }, select: { id: true } }) : []
  const missing = asked.filter((id) => !found.some((c) => c.id === id))
  if (missing.length) return { error: `Not queued: ${plural(missing.length, 'campaign')} ${missing.length === 1 ? 'was' : 'were'} not found in this business (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}).` }

  const before = new Set(bound.campaignIds)
  const afterIds = input.op === 'add' ? sorted([...before, ...asked]) : input.op === 'remove' ? sorted([...before].filter((id) => !asked.includes(id))) : asked
  const after = new Set(afterIds)
  const added = afterIds.filter((id) => !before.has(id))
  const removed = [...before].filter((id) => !after.has(id)).sort()
  const alreadyBound = input.op === 'add' ? asked.filter((id) => before.has(id)).length : 0
  const notBound = input.op === 'remove' ? asked.filter((id) => !before.has(id)).length : 0
  if (!added.length && !removed.length) {
    return { error: input.op === 'remove' ? `Nothing would change: "${rule.name}" is bound to none of these campaigns.` : `Nothing would change: "${rule.name}" is bound to exactly these campaigns already.` }
  }
  const kind = bound.slug ? `a ${SLUG_WORDS[bound.slug]} rule` : 'an engine budget rule'
  if (bound.binding === 'picker' && bound.slug !== 'budget' && !afterIds.length) {
    return { error: `Not queued: an empty campaign list makes ${kind} act on every campaign in its scope, so a request never empties it. To stop "${rule.name}", turn it down instead (turn-down-automation A1, level OFF).` }
  }

  // The drawer's own save check, on the list it would store: what it refuses is refused here, before anything waits.
  if (bound.binding === 'picker') {
    const { ruleScopeProblems } = await import('./ads-rule-crud.service.js')
    const problems = await ruleScopeProblems({ actions: withPicks(rule.actions, afterIds.map((id) => ({ id }))), scopeMarketplace: rule.scopeMarketplace })
    if (problems.length) return { error: `Not queued: the rule drawer's save refuses it — ${problems.join(' ')}` }
  }

  const everyId = sorted([...before, ...after])
  const campaigns = new Map((await prisma.campaign.findMany({ where: { id: { in: everyId } }, select: { id: true, name: true, marketplace: true } })).map((c) => [c.id, c]))
  const marketOf = (id: string) => campaigns.get(id)?.marketplace?.toUpperCase() ?? null
  const ruleMarket = rule.scopeMarketplace?.trim().toUpperCase() || nameMarket(rule.name)
  const marketFrom = rule.scopeMarketplace?.trim() ? 'scope' as const : ruleMarket ? 'name' as const : null
  const otherMarket = (id: string) => !!ruleMarket && marketOf(id) !== ruleMarket
  const lines: AssignLine[] = [...added.map((id) => ['bound', id] as const), ...removed.map((id) => ['not bound', id] as const)].map(([to, id]) => ({
    campaignId: id, campaign: campaigns.get(id)?.name ?? id, market: marketOf(id),
    from: to === 'bound' ? 'not bound' : 'bound', to,
    ...(otherMarket(id) ? { otherMarket: true as const } : {}),
  }))
  const marketsAfter: Record<string, number> = {}
  for (const id of afterIds) { const m = marketOf(id) ?? 'no market'; marketsAfter[m] = (marketsAfter[m] ?? 0) + 1 }
  const outside = afterIds.filter(otherMarket)
  const tally = (ids: string[]) => {
    const counts = new Map<string, number>()
    for (const id of ids) counts.set(marketOf(id) ?? 'no market', (counts.get(marketOf(id) ?? 'no market') ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m, n]) => `${n} in ${m}`).join(', ')
  }

  const level = resolveAutonomy(rule as never)
  const moves = ruleMoves(rule)
  const everyOther = !!bound.legacyAll && added.length > 0
  const raises = assignRaises(level, moves, added.length, removed.length, everyOther)
  const warnings: string[] = []
  if (outside.length && ruleMarket) {
    warnings.push(`The rule's ${marketFrom === 'scope' ? 'scope' : 'name'} says ${ruleMarket}, but ${plural(outside.length, 'campaign')} it will act on ${outside.length === 1 ? 'is' : 'are'} in other markets (${tally(outside)}). Check that this rule is meant for them.`)
  }
  const fixed = removed.filter(otherMarket)
  if (fixed.length && ruleMarket) warnings.push(`It takes ${plural(fixed.length, 'campaign')} outside ${ruleMarket} off the rule (${tally(fixed)}).`)
  if (everyOther) warnings.push(`"${rule.name}" has no campaigns picked today, so it acts on every campaign in its scope: after this it acts only on the ${plural(afterIds.length, 'campaign')} picked.`)
  if (raises.length) warnings.push(`It can raise spend: ${raises.join('; ')}. Approving it needs the approver's authenticator code.`)

  const alsoChangedBy: AssignPlan['alsoChangedBy'] = []
  if (added.length) {
    const { automationsBoundToCampaign } = await import('./rule-campaign-binding.service.js')
    for (const id of added.slice(0, LINES_SHOWN)) {
      const { rules, schedules } = await automationsBoundToCampaign(id)
      const by = [...rules.filter((r) => r.id !== rule.id).map((r) => `the rule "${r.name}"`), ...schedules.map((s) => `the schedule "${s.name}"`)]
      if (by.length) alsoChangedBy.push({ campaign: campaigns.get(id)?.name ?? id, by })
    }
  }

  const levelWords = LEVEL_WORDS[level] ?? level
  const acts = level === 'AUTO'
    ? 'its changes reach Amazon by themselves on its next run'
    : level === 'PROPOSE' ? 'it suggests changes there on its next run, and a person decides them' : level === 'OBSERVE' ? 'it records what it would do there and changes nothing' : 'it is switched off, so it does nothing there until it is turned up'
  const what = [added.length ? `binds it to ${plural(added.length, 'more campaign')}` : '', removed.length ? `takes ${plural(removed.length, 'campaign')} off it` : ''].filter(Boolean).join(' and ')
  const effect = `"${rule.name}" (${kind}, at ${levelWords}): ${what}, from ${plural(before.size, 'campaign')} to ${plural(afterIds.length, 'campaign')}${Object.keys(marketsAfter).length ? ` (${tally(afterIds)})` : ''}. Nexus only: nothing is sent to Amazon by this change; at ${levelWords} ${acts}.`
  const state = (ids: string[]): BindingState => ({ ruleId: rule.id, name: rule.name, binding: bound.binding, campaignIds: ids })

  return {
    plan: {
      action: 'assign-ad-rules',
      op: input.op,
      rule: { id: rule.id, name: rule.name, level, market: ruleMarket, marketFrom, kind },
      binding: bound.binding,
      summary: effect,
      changes: lines.slice(0, LINES_SHOWN),
      ...(lines.length > LINES_SHOWN ? { moreChanges: lines.length - LINES_SHOWN } : {}),
      totals: { before: before.size, after: afterIds.length, added: added.length, removed: removed.length, alreadyBound, notBound, otherMarketAfter: outside.length },
      marketsAfter,
      moves,
      raises,
      warnings,
      alsoChangedBy,
      reach: { nexusOnly: true, note: `Nexus only: the rule's campaign list changes in Nexus. The rule acts as itself, at its own level (${levelWords}), on its next run.` },
      effect,
      basis: { before: [...before].sort(), after: afterIds, level, scopeMarketplace: rule.scopeMarketplace },
      before: { ...state([...before].sort()), ...(bound.legacyAll ? { all: true as const } : {}) },
      after: state(afterIds),
      added,
      removed,
    },
  }
}

/** The rule's actions with its picker list replaced (the builder's own campaign fields, as the Apply Rules mirror writes them). */
function withPicks(actions: unknown, picks: Array<Record<string, unknown>>): object[] {
  const list = Array.isArray(actions) ? (actions as Array<Record<string, unknown>>) : []
  return list.map((a, i) => {
    if (i !== 0) return a
    const { campaignIds: _ids, ...rest } = a
    return { ...rest, campaigns: picks }
  })
}

/** A picker entry: kept as it is when the rule already holds it (its own extras), else the builder's fields. */
function pickOf(kept: Map<string, Record<string, unknown>>, c: CampaignRow | undefined, id: string): Record<string, unknown> {
  const own = kept.get(id)
  if (own) return own
  return {
    id,
    name: c?.name ?? id,
    marketplace: c?.marketplace ?? null,
    status: c?.status ?? null,
    targetingType: c?.targetingType ?? null,
    adProduct: c?.adProduct ?? null,
    dailyBudget: c?.dailyBudget != null ? Number(c.dailyBudget) : null,
    portfolioId: c?.portfolioId ?? null,
  }
}

/**
 * Run an approved request: decided again on what is stored now, then written through the screen's own path — the rule
 * drawer's save (picker) or the Apply Rules Apply (assignment). The change record keeps both lists.
 */
export async function applyRuleAssign(input: AssignInput, actor: AdsActor, note: string): Promise<{ plan: AssignPlan; before: BindingState; after: BindingState } | { error: string }> {
  const planned = await planRuleAssign(input)
  if ('error' in planned) return planned
  const { plan } = planned
  if (plan.binding === 'picker') {
    const rule = await prisma.automationRule.findUniqueOrThrow({ where: { id: plan.rule.id }, select: { actions: true } })
    const a0 = Array.isArray(rule.actions) ? obj((rule.actions as unknown[])[0]) : {}
    const stored = Array.isArray(a0.campaigns) ? (a0.campaigns as unknown[]).map(obj) : []
    const kept = new Map(stored.filter((p) => typeof p.id === 'string').map((p) => [p.id as string, p]))
    const fresh = plan.added.length
      ? new Map((await prisma.campaign.findMany({ where: { id: { in: plan.added } }, select: { id: true, name: true, marketplace: true, status: true, targetingType: true, adProduct: true, dailyBudget: true, portfolioId: true } })).map((c) => [c.id, c as CampaignRow]))
      : new Map<string, CampaignRow>()
    const picks = plan.after.campaignIds.map((id) => pickOf(kept, fresh.get(id), id))
    const { updateAdsRule } = await import('./ads-rule-crud.service.js')
    const out = await updateAdsRule(plan.rule.id, { actions: withPicks(rule.actions, picks) }, actor, { note })
    if (!out.ok) {
      const body = (out as { body: Record<string, unknown> }).body
      return { error: `The rule drawer's save refused it — ${String(body.error ?? 'refused')}` }
    }
  } else {
    // Set-replacement per campaign: each keeps every other budget rule it is bound to.
    // Only this rule moves on each campaign; its other rules are read inside the Apply's own transaction and kept.
    const { applyCampaignRuleAssignments } = await import('./rule-campaign-binding.service.js')
    const out = await applyCampaignRuleAssignments({ kind: 'budget' }, actor, { ruleId: plan.rule.id, add: plan.added, remove: plan.removed })
    if (out.status !== 200) return { error: `The Apply Rules write refused it — ${String(out.body.error ?? 'refused')}` }
  }
  const now = await ruleBindingNow(plan.rule.id)
  return { plan, before: plan.before, after: now ?? plan.after }
}
