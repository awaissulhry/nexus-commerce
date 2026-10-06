/**
 * ADS PLAYBOOK PB-9 — a product's PHASE SWITCH (design report 9 §3.7, §5.3; Owner decision D-PB3 = A: the phase IS the
 * ads strategy's goal, and a switch is ONE approval carrying that phase's numbers, which needs the approver's code only
 * when it adds spend). apply-ads-playbook op phase plans it here and runs it here, in this order:
 *
 *   strategy   the product's own strategy row (the playbook row's product): the goal, and the phase's recipe numbers made
 *              absolute at enrollment (PB-3) — target ACoS, lowest and highest bid, largest bid change, the harvest and
 *              negate groups — and what Claude may do alone in the phase, through the strategy's ONE writer (W1), each
 *              field judged raise / lower / same by its own rule; the goal moves with them (planStrategyChange
 *              goalByEffect). A number the last phase set that this one does not name is cleared (it inherits again)
 *              where the row still holds the last phase's value; one a person set is left as it is. A group the recipe
 *              cannot set whole is left as it is, said.
 *   slots      each slot as the phase says: `floor` lowers its campaign to the strategy's stop bid (suppressCampaignBids,
 *              its bids remembered; never a pause) and records the floor as the phase's (an AdsPlaybookLink kind
 *              PHASE_FLOOR_KIND, holder = the approver; START records one too for a floor it leaves "held by phase");
 *              `active` gives back ONLY such a floor, still held by its holder, once the playbook runs (before START,
 *              START does) — a floor a person set by hand, or an engine's (the budget engine, the retail guard, an
 *              hourly plan, a stock floor), is left, named. A campaign the playbook BUILT
 *              that is not started (off the live-write allowlist: never started, or stopped), or one at a floor a playbook
 *              STOP holds, gets its bids back only through START (PB-5b held.ts): the phase names it and leaves it. A built
 *              campaign START started and left at the floor the phase holds ("held by phase …", start.ts) is released
 *              here, through the same code gate as a start. A slot the phase leaves active is never touched.
 *   rank       the playbook's own hourly plans per role, off / on / light (PB-8 previewRankPhase / applyRankPhase): on
 *              only once the playbook runs; switched off, what rank set is kept (floors handed to the approver) unless
 *              the request asks to give it back (`rankFloors: giveBack` — a raise, rankOffEffect says so). The Owner's
 *              own hourly plans are never touched (rank.ts refuses a role by name).
 *   harvest    the playbook's harvest rule re-synced (PB-6b syncHarvestRule): it reads the new goal, so it sweeps daily,
 *              weekly or not at all as the phase says (more often: a raise). Its switch and its level stay the Owner's.
 *
 * BY EFFECT. Every part says whether it adds spend: a higher target ACoS or highest bid, a looser harvest or negate
 * group, more Claude may do alone (the strategy writer's rules); a floor given back; an hourly plan switched on, or one
 * switched off that gives back the floors it set; the harvest more often. Any of these and the whole switch is a RAISE:
 * it needs the approver's code, and runs by rule only where the Owner allowed raising phase moves (the tool's
 * `allowPhaseUp`) — never when it lets Claude do more alone (`raisesClaude`): that always needs his code. A switch that only
 * lowers may run by rule where the Owner allows the phase kind. Never a pause, never an archive, never an FBA quantity,
 * never the Owner's own hourly plans.
 */
import prisma from '../../../db.js'
import { DEFAULT_STOP_BID_CENTS } from '../ads-strategy/fields.js'
import type { ClaudeTrust } from '../../agents/tool-types.js'
import type { AdsActor } from '../ads-mutation.service.js'
import type { StrategyPlan, StrategyWriter } from '../ads-strategy/write.js'
import type { ArtifactContext, ArtifactPreviewLine, ArtifactSlot } from './artifacts.js'
import type { Phase, PhaseRecipes, TemplateDoc } from './doc.js'
import type { PhaseCheck } from './phase-check.js'
import type { RankFloors, RankOffEffect, RankPhaseStates } from './rank.js'
import type { PlaybookApplyWriter } from './write.js'

export type Direction = 'raise' | 'lower' | 'same'

/** The link a phase writes for each campaign it floors (key and refId the campaign, updatedBy the floor's holder). */
export const PHASE_FLOOR_KIND = 'phaseFloor'
type Entry = NonNullable<TemplateDoc['phases'][Phase]>
type Recipe = NonNullable<PhaseRecipes[Phase]>
type Own = Readonly<Record<string, unknown>> | null

const overallOf = (ds: readonly Direction[]): Direction => (ds.includes('raise') ? 'raise' : ds.includes('lower') ? 'lower' : 'same')
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// ── The strategy part (pure) ──────────────────────────────────────────────────────────────────────

/** The strategy's input values a recipe group is written as, and the columns it is compared on. */
const SINGLE = [
  { key: 'minBidCents', column: 'minBidCents' },
  { key: 'maxBidCents', column: 'maxBidCents' },
  { key: 'maxChangePct', column: 'maxChangePct' },
] as const

const harvestOf = (r: Recipe | undefined) => (r && r.harvestMinOrders != null && r.harvestMinClicks != null && r.harvestWindowDays != null
  ? { minOrders: r.harvestMinOrders, minClicks: r.harvestMinClicks, maxAcosPct: r.harvestMaxAcosPct ?? null, windowDays: r.harvestWindowDays }
  : null)
const negateOf = (r: Recipe | undefined) => (r && r.negateMinClicks != null && r.negateMinSpendCents != null && r.negateMaxOrders != null && r.negateWindowDays != null
  ? { minClicks: r.negateMinClicks, minSpendCents: r.negateMinSpendCents, maxOrders: r.negateMaxOrders, windowDays: r.negateWindowDays }
  : null)
const partial = (r: Recipe | undefined, keys: readonly (keyof Recipe)[]) => !!r && keys.some((k) => r[k] != null)

/**
 * The strategy values a switch writes (set-ads-strategy's `values`), from the new phase's recipe (`to`), the last phase's
 * (`from`) and the product row's own columns now (`own`). Pure. A field the new recipe names is set; one it does not name
 * is cleared only where the row still holds the last phase's value (else a person's own value stays); a group the recipe
 * cannot set whole is left, with a note.
 */
export function recipeValues(to: Recipe | undefined, from: Recipe | undefined, own: Own): { values: Record<string, unknown>; notes: string[] } {
  const values: Record<string, unknown> = {}
  const notes: string[] = []
  const o = own ?? {}
  // The target (ACoS).
  if (to?.targetAcosPct != null) values.target = { kind: 'ACOS', pct: to.targetAcosPct }
  else if (from?.targetAcosPct != null && o.targetKind === 'ACOS' && o.targetPct === from.targetAcosPct) values.target = null
  // The bid band and the largest change.
  for (const { key, column } of SINGLE) {
    if (to?.[key] != null) values[key] = to[key]
    else if (from?.[key] != null && o[column] === from[key]) values[key] = null
  }
  // The harvest group, whole.
  const h = harvestOf(to)
  const hFrom = harvestOf(from)
  if (h) values.harvest = h
  else {
    if (partial(to, ['harvestMinOrders', 'harvestMinClicks', 'harvestMaxAcosPct', 'harvestWindowDays'])) notes.push("the phase's harvest numbers are not a whole group (orders, clicks and window), so the harvest group is left as it is")
    if (hFrom && o.harvestMinOrders === hFrom.minOrders && o.harvestMinClicks === hFrom.minClicks && (o.harvestMaxAcosPct ?? null) === hFrom.maxAcosPct && o.harvestWindowDays === hFrom.windowDays) values.harvest = null
  }
  // The negate group, whole (its spend threshold needs the base bid at enrollment).
  const n = negateOf(to)
  const nFrom = negateOf(from)
  if (n) values.negate = n
  else {
    if (partial(to, ['negateMinClicks', 'negateMinSpendCents', 'negateMaxOrders', 'negateWindowDays'])) {
      notes.push(to?.negateMinSpendCents == null
        ? "the phase's negate numbers have no spend threshold (the product had no base bid at enrollment), so the negate group is left as it is"
        : "the phase's negate numbers are not a whole group, so the negate group is left as it is")
    }
    if (nFrom && o.negateMinClicks === nFrom.minClicks && o.negateMinSpendCents === nFrom.minSpendCents && o.negateMaxOrders === nFrom.maxOrders && o.negateWindowDays === nFrom.windowDays) values.negate = null
  }
  return { values, notes }
}

/**
 * What Claude may do alone on the product row after a switch (the strategy's claudeAutonomy), from the new phase's levels,
 * the last phase's and the row's own map now. Pure. The new phase's levels are set; a level the last phase set that the
 * new one does not name comes off where the row still holds it. `undefined`: nothing changes; null: the map is cleared.
 */
export function claudeValues(to: Readonly<Record<string, string>> | undefined, from: Readonly<Record<string, string>> | undefined, own: unknown): Record<string, ClaudeTrust> | null | undefined {
  const now = own && typeof own === 'object' && !Array.isArray(own) ? (own as Record<string, string>) : {}
  const next: Record<string, string> = { ...now }
  for (const [action, level] of Object.entries(from ?? {})) if (!(action in (to ?? {})) && next[action] === level) delete next[action]
  for (const [action, level] of Object.entries(to ?? {})) next[action] = level
  const key = (m: Record<string, string>) => JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]))
  if (key(next) === key(now)) return undefined
  return Object.keys(next).length ? (next as Record<string, ClaudeTrust>) : null
}

// ── The slots (pure) ──────────────────────────────────────────────────────────────────────────────

export interface SlotCampaign {
  campaignId: string
  name: string
  status: string
  marketplace: string | null
  floored: boolean
  floorBy: string | null
  dailyBudgetCents: number
  /** On the live-write allowlist (a built campaign: START started it). */
  liveWrites?: boolean
  /** The holder of the phase's own floor on it (its PHASE_FLOOR_KIND link), or null: no floor of a phase. */
  phaseFloorBy?: string | null
}

export interface SlotStep {
  slot: string
  campaignId: string | null
  name: string | null
  from: 'active' | 'floor'
  to: 'active' | 'floor'
  does: 'floor' | 'restore' | 'keep' | 'report'
  direction: Direction
  summary: string
  /** floor: the stop bid it lowers to (the strategy's, else the 2¢ floor), and the highest bid above it now; restore: the
   *  highest bid it puts back (the remembered one, an upper bound: a limit may hold it lower). */
  floorCents?: number
  highestBidCents?: number
  /** restore: the daily budget that spends again. */
  dailyBudgetCents?: number
}

/** A floor a person's request set may be given back by a phase (the restore-campaign rule); an engine's never. */
export const isPersonFloor = (by: string | null) => !!by && by.startsWith('user:')

/**
 * Each linked slot's step from the last phase's slot states to the new one's. Pure. `running`: the playbook has started
 * (before START, a floor stays: START gives the bids back). `stopBids`: each campaign's stop bid in cents. Only a floor
 * the phase recorded as its own (`phaseFloorBy`, still its holder's) is given back.
 */
export function slotSteps(args: {
  doc: TemplateDoc
  from: Entry | undefined
  to: Entry
  links: ReadonlyMap<string, string>
  campaigns: ReadonlyMap<string, SlotCampaign>
  running: boolean
  stopBids: ReadonlyMap<string, number>
}): SlotStep[] {
  const steps: SlotStep[] = []
  for (const slot of args.doc.structure.slots) {
    const campaignId = args.links.get(slot.key) ?? null
    const was = args.from?.slots?.[slot.key] ?? 'active'
    const want = args.to.slots?.[slot.key] ?? 'active'
    const c = campaignId ? args.campaigns.get(campaignId) : undefined
    const base = { slot: slot.key, campaignId, name: c?.name ?? null, from: was, to: want }
    if (!c || c.status === 'ARCHIVED') {
      if (want === 'floor' || was === 'floor') steps.push({ ...base, does: 'report', direction: 'same', summary: `Slot "${slot.key}" has no live campaign: nothing to ${want === 'floor' ? 'floor' : 'give back'}.` })
      continue
    }
    const by = c.floorBy ?? 'an unrecorded actor'
    if (want === 'floor') {
      if (c.floored) steps.push({ ...base, does: 'keep', direction: 'same', summary: `"${c.name}" is at the floor already (by ${by}): it stays there.` })
      else {
        const floorCents = args.stopBids.get(c.campaignId) ?? DEFAULT_STOP_BID_CENTS
        steps.push({ ...base, does: 'floor', direction: 'lower', floorCents, summary: `"${c.name}" goes to the floor: every bid to ${floorCents} cents, each remembered (never paused).` })
      }
      continue
    }
    if (!c.floored) continue
    if (was !== 'floor') {
      steps.push({ ...base, does: 'keep', direction: 'same', summary: `"${c.name}" is at the floor (by ${by}), which the last phase did not set: it stays there.` })
    } else if (!args.running) {
      steps.push({ ...base, does: 'keep', direction: 'same', summary: `"${c.name}" stays at the floor until START: the playbook does not run yet.` })
    } else if (!isPersonFloor(c.floorBy)) {
      steps.push({ ...base, does: 'report', direction: 'same', summary: `"${c.name}" is held at the floor by ${by}: a floor an engine set is never lifted here.` })
    } else if (!c.phaseFloorBy || c.phaseFloorBy !== c.floorBy) {
      steps.push({ ...base, does: 'keep', direction: 'same', summary: `"${c.name}" is at a floor ${by} set, not the phase's own: it stays (a person's own floor is lifted by restore-campaign, never by a phase).` })
    } else {
      steps.push({ ...base, does: 'restore', direction: 'raise', dailyBudgetCents: c.dailyBudgetCents, summary: `"${c.name}" gets its remembered bids back (floored by ${by}): it serves again (a raise).` })
    }
  }
  return steps
}

// ── The hourly plans (pure) ───────────────────────────────────────────────────────────────────────

export interface RankStepLine extends ArtifactPreviewLine { role: 'performance' | 'research'; direction: Direction }

/**
 * Each rank line of the switch (rank.ts previewRankPhase), judged by its effect. Pure. Switched on: a raise. Switched
 * off: a raise when it gives back the floors it set (`off`, rankOffEffect per role), else a lowering. Rewritten while
 * the playbook runs: light → full is a raise, full → light a lowering. Before START nothing is switched on.
 */
export function rankSteps(lines: readonly ArtifactPreviewLine[], from: RankPhaseStates, to: RankPhaseStates, running: boolean, off: ReadonlyMap<string, RankOffEffect>): RankStepLine[] {
  return lines.map((line) => {
    const role = (line.key.split(':')[1] === 'research' ? 'research' : 'performance') as 'performance' | 'research'
    let direction: Direction = 'same'
    if (line.does === 'enable') direction = 'raise'
    else if (line.does === 'disable') direction = off.get(role)?.direction === 'raise' ? 'raise' : 'lower'
    else if (line.does === 'update' && running) {
      const was = from[role] ?? 'on'
      const want = to[role]
      direction = was === 'light' && want === 'on' ? 'raise' : want === 'light' && was !== 'light' ? 'lower' : 'same'
    }
    return { ...line, role, direction }
  })
}

// ── The plan ──────────────────────────────────────────────────────────────────────────────────────

export interface HarvestStep { does: 'update' | 'keep' | 'report'; summary: string; ruleId?: string; fromCadenceDays?: number | null; toCadenceDays: number | null; harvestFrom: boolean; direction: Direction }

export interface PhasePlan {
  channel: string
  market: string
  product: { productId: string; sku: string }
  /** The playbook row's product: the strategy row the switch writes, and the family it reads. */
  scopeProductId: string
  playbook: { id: string; version: number; state: string | null; label: string; compiledTemplateVersion: number | null }
  nameToken: string | null
  doc: TemplateDoc
  from: Phase | null
  to: Phase
  entry: Entry
  rankFloors: RankFloors
  running: boolean
  strategy: StrategyPlan
  strategyNotes: string[]
  slots: SlotStep[]
  rank: RankStepLine[]
  harvest: HarvestStep
  direction: Direction
  raises: string[]
  /** It lets Claude do more alone (a claudeAutonomy level up, or a narrower level taken off): never by rule, always the code. */
  raisesClaude: boolean
  check: PhaseCheck
  ctx: ArtifactContext
  warnings: string[]
}

const CADENCE: Record<Entry['harvestCadence'], number | null> = { daily: 1, weekly: 7, off: null }
const cadenceWords = (days: number | null | undefined, harvestFrom = true) => (!harvestFrom || days === undefined ? 'off' : days === 1 ? 'daily' : days === 7 ? 'weekly' : 'at most once a day')

/**
 * Plan ONE product's phase switch in ONE market: nothing is written. Refused (an error) when the product has no playbook
 * here, is not enrolled, the playbook does not compile, has no such phase or no recipe for it, or the product is in that
 * phase already.
 */
export async function planPhase(args: { market: string; productId?: string; sku?: string; phase: Phase; rankFloors?: RankFloors; actor?: AdsActor; channel?: string; now?: Date }): Promise<{ data: PhasePlan } | { error: string }> {
  // Imported here: the tool registry loads this module inside its import cycle (only db and types load with it).
  const [{ loadProductPlaybook }, { openStrategy, stopBidsFor }, { loadIndex }, { planStrategyChange }, { previewRankPhase, rankOffEffect }, { loadPhaseCheck }] = await Promise.all([
    import('./build-preview.js'), import('../ads-strategy/effective.js'), import('../ads-strategy/load.js'), import('../ads-strategy/write.js'),
    import('./rank.js'), import('./phase-check.js'),
  ])
  const loaded = await loadProductPlaybook({ market: args.market, productId: args.productId, sku: args.sku, channel: args.channel })
  if ('error' in loaded) return { error: loaded.error }
  const { market, channel, product, resolved, row } = loaded
  if (!row) return { error: `${product.sku} has no product playbook row in ${market}: set one (set-ads-playbook) and enroll it first.` }
  if (resolved.product?.enrolled.value !== true) return { error: `${product.sku} is not enrolled in its playbook in ${market}: a person includes it first (set-ads-playbook op enroll).` }
  const doc = resolved.doc
  if (!doc) return { error: `The playbook does not compile yet: ${resolved.problems.join('; ') || 'a section is missing'}.` }
  const to = args.phase
  const entry = doc.phases[to]
  if (!entry) return { error: `The playbook has no ${to} phase (its phase table names ${Object.keys(doc.phases).join(', ') || 'none'}).` }
  const recipes = (resolved.product?.phaseRecipes.value ?? {}) as PhaseRecipes
  if (!recipes[to]) return { error: `${product.sku} holds no ${to} recipe: its recipes are made at enrollment (set-ads-playbook op enroll with recompute makes them again).` }
  const scopeProductId = row.scopeId

  // Where the product stands: the goal at the playbook row's product.
  const view = await openStrategy(market, channel)
  const goal = (await view.forProducts([scopeProductId])).resolved.fields.get('goal')?.value
  const from = typeof goal === 'string' && goal ? (goal as Phase) : null
  if (from === to) return { error: `${product.sku} is in ${to} already in ${market}: nothing to switch.` }
  const fromEntry = from ? doc.phases[from] : undefined

  // The strategy part, through its one writer.
  const { rows } = await loadIndex(market, channel)
  const own = rows.find((r) => r.level === 'PRODUCT' && r.scopeId === scopeProductId) ?? null
  const ownColumns = own as unknown as Own
  const made = recipeValues(recipes[to], from ? recipes[from] : undefined, ownColumns)
  const claude = claudeValues(entry.claude as Record<string, string>, fromEntry?.claude as Record<string, string> | undefined, own?.claudeAutonomy)
  const values = { goal: to, ...made.values, ...(claude !== undefined ? { claudeAutonomy: claude } : {}) }
  const planned = await planStrategyChange({
    channel, market, level: 'product', productId: scopeProductId, op: 'set', values,
    reason: `Playbook phase ${from ?? 'none'} → ${to}`,
  }, { goalByEffect: true })
  if ('error' in planned) return { error: `The ads strategy refuses this phase's numbers: ${planned.error}` }
  const strategy = planned.plan

  // The slots, the hourly plans, the harvest rule.
  const running = row.state === 'RUNNING'
  const links = await prisma.adsPlaybookLink.findMany({ where: { playbookId: row.id }, select: { kind: true, key: true, refId: true, adGroupId: true, origin: true, updatedBy: true } })
  const slotLinks = links.filter((l) => l.kind === 'slot')
  const slotCampaigns = slotLinks.length
    ? await prisma.campaign.findMany({ where: { id: { in: slotLinks.map((l) => l.refId) } }, select: { id: true, name: true, status: true, marketplace: true, bidsSuppressedAt: true, bidsSuppressedBy: true, dailyBudget: true, liveBidWritesEnabled: true } })
    : []
  const phaseFloorOf = new Map(links.filter((l) => l.kind === PHASE_FLOOR_KIND).map((l) => [l.refId, l.updatedBy]))
  const campaigns = new Map(slotCampaigns.map((c) => [c.id, {
    campaignId: c.id, name: c.name, status: String(c.status), marketplace: c.marketplace, floored: !!c.bidsSuppressedAt,
    floorBy: c.bidsSuppressedAt ? c.bidsSuppressedBy ?? null : null, dailyBudgetCents: Math.round(Number(c.dailyBudget ?? 0) * 100),
    liveWrites: c.liveBidWritesEnabled, phaseFloorBy: phaseFloorOf.get(c.id) ?? null,
  } satisfies SlotCampaign]))
  const stops = await stopBidsFor(slotCampaigns.map((c) => ({ id: c.id, marketplace: c.marketplace })), channel)
  let slots = slotSteps({
    doc, from: fromEntry, to: entry, links: new Map(slotLinks.map((l) => [l.key, l.refId])), campaigns, running,
    stopBids: new Map([...stops].map(([id, s]) => [id, s.cents])),
  })
  // PB-5b — a floor a STOP holds, and a built campaign not started (off the allowlist), go back only through START.
  const { playbookHolds, startOnlyRefusal } = await import('./held.js')
  const held = await playbookHolds(slots.filter((s) => s.does === 'restore' && s.campaignId).map((s) => s.campaignId!))
  slots = slots.map((s) => {
    const why = s.does === 'restore' && s.campaignId ? held.get(s.campaignId) : undefined
    const startOnly = why === 'held' || (why === 'built' && !campaigns.get(s.campaignId!)?.liveWrites)
    return startOnly ? { ...s, does: 'report' as const, direction: 'same' as const, summary: `"${s.name}" stays at the floor: ${startOnlyRefusal('it', why!)}.` } : s
  })
  // Each write as Amazon's write gate would judge it now: a refused one is named and left out.
  const { checkLiveReach } = await import('../../agents/tools/ads-tool-guards.js')
  slots = await Promise.all(slots.map(async (s) => {
    if ((s.does !== 'floor' && s.does !== 'restore') || !s.campaignId) return s
    const c = campaigns.get(s.campaignId)!
    const reach = await checkLiveReach({ campaignId: s.campaignId, marketplace: c.marketplace, changes: [{ field: 'bid', valueCents: s.does === 'floor' ? s.floorCents ?? DEFAULT_STOP_BID_CENTS : null }], isSuppression: true })
    if (reach.reach === 'refused') return { ...s, does: 'report' as const, direction: 'same' as const, summary: `"${c.name}" is left as it is: Amazon's write gate refuses it — ${reach.reason}.` }
    if (s.does === 'restore') {
      // The highest bid it puts back: the remembered ones (an ad group at its own floor stays: restoreCampaignBids).
      const [t, g] = await Promise.all([
        prisma.adTarget.aggregate({ where: { adGroup: { campaignId: s.campaignId, bidsSuppressedAt: null }, suppressedFromBidCents: { not: null } }, _max: { suppressedFromBidCents: true } }),
        prisma.adGroup.aggregate({ where: { campaignId: s.campaignId, bidsSuppressedAt: null, suppressedFromBidCents: { not: null } }, _max: { suppressedFromBidCents: true } }),
      ])
      return { ...s, highestBidCents: Math.max(t._max.suppressedFromBidCents ?? 0, g._max.suppressedFromBidCents ?? 0) }
    }
    // The highest bid the floor lowers (what a stop moves, as suppress-campaign counts it).
    const floor = s.floorCents ?? DEFAULT_STOP_BID_CENTS
    const [t, g] = await Promise.all([
      prisma.adTarget.aggregate({ where: { adGroup: { campaignId: s.campaignId }, isNegative: false, bidCents: { gt: floor }, suppressedFromBidCents: null }, _max: { bidCents: true } }),
      prisma.adGroup.aggregate({ where: { campaignId: s.campaignId, defaultBidCents: { gt: floor }, suppressedFromBidCents: null }, _max: { defaultBidCents: true } }),
    ])
    return { ...s, highestBidCents: Math.max(floor, t._max.bidCents ?? 0, g._max.defaultBidCents ?? 0) }
  }))

  const rankRole = (key: string) => doc.structure.slots.find((s) => s.key === key)?.rankRole ?? 'none'
  const artifactSlots: ArtifactSlot[] = slotLinks.map((l) => ({ key: l.key, campaignId: l.refId, adGroupId: l.adGroupId ?? null, origin: l.origin === 'adopted' ? 'adopted' : 'built', rankRole: rankRole(l.key) }))
  const nameToken = typeof resolved.product?.nameToken.value === 'string' ? resolved.product.nameToken.value : null
  const ctx: ArtifactContext = {
    playbookId: row.id, market, productId: scopeProductId, nameToken: nameToken ?? '', doc, slots: artifactSlots,
    mode: 'phase', actor: args.actor ?? 'user:preview', changeSetId: null, compiledVersion: row.version,
  }
  const rankFloors = args.rankFloors ?? 'keep'
  let rank: RankStepLine[] = []
  try {
    const lines = await previewRankPhase(ctx, entry.rank, { floors: rankFloors })
    const off = new Map<string, RankOffEffect>()
    for (const l of lines.filter((x) => x.does === 'disable')) {
      const role = l.key.split(':')[1] as 'performance' | 'research'
      off.set(role, await rankOffEffect(ctx, [role], rankFloors))
    }
    rank = rankSteps(lines, fromEntry?.rank ?? {}, entry.rank, running, off)
    for (const [role, e] of off) {
      const line = rank.find((r) => r.role === role && r.does === 'disable')
      if (line && e.words && !line.summary.includes(e.words)) line.summary = `${line.summary} ${e.words}.`
    }
  } catch (e) {
    // Fail closed: what the switch does to the hourly plans decides whether it adds spend.
    return { error: `The playbook's hourly plans could not be read just now (${(e as Error).message.slice(0, 160)}): nothing is queued; ask again.` }
  }

  const ruleLink = links.find((l) => l.kind === 'harvestRule')
  const toDays = CADENCE[entry.harvestCadence]
  let harvest: HarvestStep
  if (!ruleLink) harvest = { does: 'report', summary: 'The product has no playbook harvest rule yet (a build or an adopt compiles it): it follows the phase from then.', toCadenceDays: toDays, harvestFrom: entry.harvestCadence !== 'off', direction: 'same' }
  else {
    const rule = await prisma.automationRule.findUnique({ where: { id: ruleLink.refId }, select: { id: true, name: true, actions: true } })
    const action = (Array.isArray(rule?.actions) ? rule!.actions[0] : null) as { cadenceDays?: number | null; sources?: Array<{ harvestFrom?: boolean }> } | null
    const fromDays = action?.cadenceDays ?? null
    const fromOn = (action?.sources ?? []).some((s) => s.harvestFrom !== false)
    const same = fromDays === toDays && fromOn === (entry.harvestCadence !== 'off')
    // More often harvests more (off < weekly < once a day at most < daily): a raise; less often a lowering.
    const often = (days: number | null, on: boolean) => (!on ? 0 : days === 7 ? 1 : days === 1 ? 3 : 2)
    const was = often(fromDays, fromOn)
    const is = often(toDays, entry.harvestCadence !== 'off')
    harvest = {
      does: !rule ? 'report' : same ? 'keep' : 'update', ruleId: ruleLink.refId, fromCadenceDays: fromDays, toCadenceDays: toDays, harvestFrom: entry.harvestCadence !== 'off',
      direction: !rule || same || is === was ? 'same' : is > was ? 'raise' : 'lower',
      summary: !rule
        ? 'The playbook harvest rule is gone: the next build or adopt compiles it again.'
        : `The playbook harvest rule "${rule.name}" ${same ? 'keeps' : 'is re-synced to'} the ${to} cadence: ${cadenceWords(toDays, entry.harvestCadence !== 'off')} (was ${cadenceWords(fromDays, fromOn)}). It only proposes; its switch and level stay as they are.`,
    }
  }

  const direction = overallOf([strategy.direction, ...slots.map((s) => s.direction), ...rank.map((r) => r.direction), harvest.direction])
  const raisesClaude = strategy.changes.some((c) => c.field === 'claudeAutonomy' && c.direction === 'raise')
  const raises = [
    ...strategy.raises.filter((r) => r !== 'Goal'),
    ...slots.filter((s) => s.direction === 'raise').map((s) => `bids given back: "${s.name}"`),
    ...rank.filter((r) => r.direction === 'raise').map((r) => (r.does === 'disable' ? `the ${r.role} hourly plan gives back the floors it set` : `the ${r.role} hourly plan ${r.does === 'enable' ? 'switched on' : 'back to its full hours'}`)),
    ...(harvest.direction === 'raise' ? ['the harvest rule sweeps more often'] : []),
  ]
  const check = await loadPhaseCheck({ market, channel, productId: scopeProductId, doc, now: args.now })
  const warnings = [
    ...resolved.warnings,
    ...(!running ? ['The playbook does not run yet (no START): hourly plans stay off and no floor is given back until START; floors and the strategy numbers take effect now.'] : []),
    ...(check.hold.held ? [`Inside the ${check.hold.minDays}-day hold of ${from}: only a person's own switch (this one, approved by a person) moves it now; it does not run by rule.`] : []),
    ...(check.proposal && check.proposal.to !== to ? [`Nexus proposes ${check.proposal.to}, not ${to}: this is a person's own switch.`] : []),
  ]
  return {
    data: {
      channel, market, product: { productId: product.id, sku: product.sku }, scopeProductId,
      playbook: { id: row.id, version: row.version, state: row.state, label: row.label, compiledTemplateVersion: resolved.template.value?.version ?? null },
      nameToken, doc, from, to, entry, rankFloors, running, strategy, strategyNotes: made.notes, slots, rank, harvest,
      direction, raises: [...new Set(raises)], raisesClaude, check, ctx, warnings,
    },
  }
}

// ── The run ───────────────────────────────────────────────────────────────────────────────────────

export interface PhaseRun {
  actor: AdsActor
  reason: string
  changeSetId: string
  manual: boolean
  /** The writer of the strategy row and the playbook version. */
  writer: Omit<StrategyWriter, 'stepUpAt' | 'raiseByRule'> & Omit<PlaybookApplyWriter, 'stepUpAt'>
  /** A raise: when its code was confirmed, or the sentence of the rule that let it run without one. */
  stepUpAt?: Date | null
  raiseByRule?: string | null
}

export interface PhaseOutcome {
  strategy: { strategyId: string; version: number; direction: Direction } | null
  floored: Array<{ slot: string; campaignId: string; moved: number }>
  restored: Array<{ slot: string; campaignId: string; restored: number }>
  rank: { changed: string[]; errors: string[] }
  harvest: { saved: boolean; ruleId?: string | null; cadenceDays?: number | null; problems?: string[] } | null
  recorded: { version: number } | null
  errors: string[]
}

/**
 * Run a planned switch, in order: the strategy row (one transaction; a row moved since → nothing at all is done), the
 * slots (each campaign checked again just before: a floor set or lifted meanwhile is left), the hourly plans, the harvest
 * rule, and one playbook version (op phase). A part that fails is named; the parts before it stand.
 */
export async function runPhase(plan: PhasePlan, run: PhaseRun): Promise<PhaseOutcome | { error: string }> {
  const [{ applyStrategyPlan }, { suppressCampaignBids, restoreCampaignBids }, { applyRankPhase }, { syncHarvestRule }, { recordPlaybookApply }, { playbookHolds }] = await Promise.all([
    import('../ads-strategy/write.js'), import('../ads-bid-suppression.service.js'), import('./rank.js'), import('./harvest-rule.js'), import('./write.js'), import('./held.js'),
  ])
  const raise = plan.strategy.direction === 'raise'
  const wrote = await applyStrategyPlan(plan.strategy, { ...run.writer, stepUpAt: raise ? run.stepUpAt ?? null : null, raiseByRule: raise ? run.raiseByRule ?? null : null })
  if ('error' in wrote) return { error: wrote.error }
  const out: PhaseOutcome = {
    strategy: { strategyId: wrote.strategyId, version: wrote.version, direction: wrote.direction },
    floored: [], restored: [], rank: { changed: [], errors: [] }, harvest: null, recorded: null, errors: [],
  }

  for (const s of plan.slots) {
    if (!s.campaignId || (s.does !== 'floor' && s.does !== 'restore')) continue
    try {
      const now = await prisma.campaign.findUnique({ where: { id: s.campaignId }, select: { bidsSuppressedAt: true, bidsSuppressedBy: true } })
      if (s.does === 'floor') {
        if (now?.bidsSuppressedAt) { out.errors.push(`"${s.name}" was floored meanwhile (by ${now.bidsSuppressedBy ?? 'an unrecorded actor'}): left as it is`); continue }
        const moved = await suppressCampaignBids(s.campaignId, { actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, floorCents: s.floorCents ?? null })
        // The floor is the phase's own: only a later phase (or START) gives it back, and only while its holder holds it.
        await recordPhaseFloor(plan.playbook.id, s.campaignId, run.actor, plan.playbook.version)
        out.floored.push({ slot: s.slot, campaignId: s.campaignId, moved })
      } else {
        if (!now?.bidsSuppressedAt || !isPersonFloor(now.bidsSuppressedBy ?? null)) { out.errors.push(`"${s.name}" is no longer at a floor a person's request set: left as it is`); continue }
        const link = await prisma.adsPlaybookLink.findFirst({ where: { playbookId: plan.playbook.id, kind: PHASE_FLOOR_KIND, refId: s.campaignId }, select: { updatedBy: true } })
        if (link?.updatedBy !== now.bidsSuppressedBy) { out.errors.push(`"${s.name}" is no longer at the phase's own floor (${now.bidsSuppressedBy} holds it): left as it is`); continue }
        const why = (await playbookHolds([s.campaignId])).get(s.campaignId)
        const live = (await prisma.campaign.findUnique({ where: { id: s.campaignId }, select: { liveBidWritesEnabled: true } }))?.liveBidWritesEnabled
        if (why === 'held' || (why === 'built' && !live)) { out.errors.push(`"${s.name}" is now held for a playbook START: left at the floor`); continue }
        const restored = await restoreCampaignBids(s.campaignId, { actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, manual: run.manual })
        const after = await prisma.campaign.findUnique({ where: { id: s.campaignId }, select: { bidsSuppressedAt: true } })
        if (after?.bidsSuppressedAt) out.errors.push(`"${s.name}": ${plural(restored, 'bid')} put back, some not; it stays at the floor until all are`)
        else await prisma.adsPlaybookLink.deleteMany({ where: { playbookId: plan.playbook.id, kind: PHASE_FLOOR_KIND, refId: s.campaignId } })
        out.restored.push({ slot: s.slot, campaignId: s.campaignId, restored })
      }
    } catch (e) {
      out.errors.push(`"${s.name}": ${(e as Error).message.slice(0, 200)}`)
    }
  }

  try {
    out.rank = await applyRankPhase({ ...plan.ctx, actor: run.actor, changeSetId: run.changeSetId }, plan.entry.rank, { floors: plan.rankFloors })
    out.errors.push(...out.rank.errors)
  } catch (e) {
    out.errors.push(`the hourly plans: ${(e as Error).message.slice(0, 200)}`)
  }

  if (plan.harvest.ruleId) {
    try {
      const r = await syncHarvestRule(plan.playbook.id, { enabled: false, actor: run.actor })
      if ('ruleId' in r) out.harvest = { saved: true, ruleId: r.ruleId, cadenceDays: r.cadenceDays }
      else {
        out.harvest = { saved: false, problems: r.problems }
        out.errors.push(`the harvest rule was not re-synced: ${r.problems.join('; ')}`)
      }
    } catch (e) {
      out.errors.push(`the harvest rule: ${(e as Error).message.slice(0, 200)}`)
    }
  }

  try {
    const recorded = await recordPlaybookApply(plan.playbook.id, {
      op: 'phase', state: plan.playbook.state ?? 'DRAFT', compiledVersion: plan.playbook.version, compiledTemplateVersion: plan.playbook.compiledTemplateVersion,
      reason: run.reason, direction: plan.direction,
      changes: [{ field: 'phase', label: 'Phase', from: plan.from, to: plan.to, direction: plan.direction }],
    }, { ...run.writer, stepUpAt: plan.direction === 'raise' ? run.stepUpAt ?? null : null })
    out.recorded = recorded ? { version: recorded.version } : null
  } catch (e) {
    out.errors.push(`the playbook version was not recorded: ${(e as Error).message.slice(0, 200)}`)
  }
  return out
}

/**
 * Record a floor as a phase's own (PHASE_FLOOR_KIND: key and refId the campaign, updatedBy its holder) — after a phase
 * floors a slot, or when START leaves a floor "held by phase" (start.ts). Replaces an earlier one for the campaign.
 */
export async function recordPhaseFloor(playbookId: string, campaignId: string, holder: string, compiledVersion: number): Promise<void> {
  const had = await prisma.adsPlaybookLink.findFirst({ where: { kind: PHASE_FLOOR_KIND, refId: campaignId }, select: { id: true } })
  if (had) await prisma.adsPlaybookLink.update({ where: { id: had.id }, data: { playbookId, key: campaignId, updatedBy: holder, compiledVersion } })
  else await prisma.adsPlaybookLink.create({ data: { playbookId, kind: PHASE_FLOOR_KIND, key: campaignId, refId: campaignId, origin: 'built', compiledVersion, updatedBy: holder } })
}

/** The phase a product holds now in a market (its strategy's goal at the playbook row's product), for an undo's check. */
export async function phaseNow(market: string, scopeProductId: string, channel = 'AMAZON'): Promise<Phase | null> {
  const { openStrategy } = await import('../ads-strategy/effective.js')
  const goal = (await (await openStrategy(market, channel)).forProducts([scopeProductId])).resolved.fields.get('goal')?.value
  return typeof goal === 'string' && goal ? (goal as Phase) : null
}
