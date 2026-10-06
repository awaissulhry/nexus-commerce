/**
 * ADS AUTONOMY W3-3 (agent-results/6 §3, §4 W3-3; Owner 2026-10-06) — stock-aware bids, never the FBA quantity. A stock
 * problem LOWERS bids — an ad group whose every product is out of stock to its floor, one whose every product is short
 * by the ads strategy's step — and gives them back when cover returns. Nothing is paused, and no stock number is written
 * anywhere: Amazon's FBA count is only read (ads-stock.tools.vitest.test.ts holds these files to no stock write).
 *
 *   ad-stock-risk                read: per advertised product its units (the ledger it sells from; Amazon's FBA number
 *                                apart, read only), pace, days of cover, inbound units and its two lines; per ad group
 *                                whether it advertises ONLY short products, and what floors it now
 *                                (advertising/ads-stock-risk.service.ts holds the rules)
 *   lower-ad-bids-for-stock      out of stock → the existing ad-group floor at the stop bid (the ads strategy's, else
 *                                2¢), each bid remembered (lowerAdGroupBids); short → ONE step down by the largest bid
 *                                change per action, a PLAIN bid lowering (no floor markers: every stop — a cap, the retail
 *                                guard, a night or Min-bid window, suppress-campaign — still floors it), its from → to bids
 *                                kept in this request's change record; or to the floor when asked. A mixed ad group, one
 *                                on shared stock, a campaign floored by anyone and an engine's own floor are left alone.
 *                                Undo: restore-ad-bids-after-stock.
 *   restore-ad-bids-after-stock  once every product is back above its restart line: a person's floor (this tool's, or his
 *                                own) gives its remembered bids back (restoreAdGroupBids), and every bid that still equals
 *                                its stepped value goes back through the step records; a bid moved since is left and
 *                                named. It adds spend: judged as a raise (the W2 contract; the halt binds it by rule), and
 *                                by default every give-back waits for a person (maxRestoredBidCents 0). Never an engine's
 *                                floor. Undo: lower-ad-bids-for-stock.
 *
 * Both change tools follow ads-change-kit.ts — preview first, refused and not queued when Amazon's write gate would refuse
 * it, run only as an approved request (as the approver, changeSetId = the approval), re-checked in `execute` — and are
 * strategy-bound (ads-autonomy-kit.ts): the ads strategy's `stop` and `restore` kinds narrow them. Default level ask.
 * An ad group named that cannot be changed is left as it is and listed with why; nothing to change refuses the request.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { lowerAdGroupBids, restoreAdGroupBids } from '../../advertising/ads-bid-suppression.service.js'
import { updateAdGroupWithSync, updateAdTargetWithSync, type AdsActor } from '../../advertising/ads-mutation.service.js'
import {
  moveKey, readStockAdGroups, SHARED_WORDS, stockBidRules, stockBidsNow, stockFloorsNow, stockGiveBackMoves, stockLoweringMoves, STOCK_READ_MAX_AD_GROUPS,
  type StepRecord, type StockAdGroup, type StockBidMove, type StockProduct,
} from '../../advertising/ads-stock-risk.service.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import { amountLabel, checkLiveReach, type LiveReach } from './ads-tool-guards.js'
import { alsoChangedBy, approvedRun, BY_RULE_WORDS, notRun, reachNote, reachRefusal, recheck, ruleFactsFor, ruleRefusal, spOnlyRefusal, type RuleWrite, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, type KitItem } from './ads-autonomy-kit.js'
import type { AgentTool, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = { read: 'ad-stock-risk', lower: 'lower-ad-bids-for-stock', restore: 'restore-ad-bids-after-stock' } as const
/** The most ad groups and campaigns one change request names. */
const MAX_NAMED = 100
/** At most this many lines are listed in a preview or a read; the rest are counted. */
const LINES_SHOWN = 20
/** The most step records a give-back follows back (newest first). */
const STEP_RECORDS_READ = 500
/** What every answer says about stock. */
const FBA_NOTE = 'Nothing here changes a stock quantity: Amazon\'s FBA number is Amazon\'s, and Nexus only reads it.'
const LINES_NOTE = 'A product is short of stock when its days of cover (units ÷ units sold a day, from its latest replenishment suggestion) fall below its lead time — a reorder cannot land before it runs out — and back when they reach its lead time plus its safety days. Out of stock: no unit to sell. No pace known: only out of stock counts. On shared stock (another business\'s pool): only out of stock counts, because the other business\'s sales are not in the pace.'
/**
 * What a step's preview says will hold it, and what will not (auto-bid leaves alone any keyword bid a person set in the
 * last 60 days, and an approved Claude request writes as a person: bid-grid.service.ts personBidTargetIds).
 */
const STEP_NOTE = 'A step is a plain bid lowering, not a floor: auto-bid leaves these keyword and target bids alone for 60 days (a bid an approved request wrote counts as a person\'s), but an enabled rule, an hourly bid plan or a dayparting window that also moves the campaign may move them again (alsoChangedBy). Any stop still floors them. restore-ad-bids-after-stock gives back only the bids still at their stepped value.'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const named = (list: string[], shown = 3) => (list.length > shown ? `${list.slice(0, shown).join(', ')} and ${list.length - shown} more` : list.join(', '))
const unique = (ids: readonly string[] | undefined) => [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))]
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)
const isPerson = (by: string | null | undefined) => !!by?.startsWith('user:')
const groupLabel = (g: StockAdGroup) => `ad group "${g.name}" (campaign "${g.campaign.name}")`
const ownerWords = (by: string | null | undefined) => (isPerson(by) ? `a person (${by})` : by || 'an unrecorded actor')
const isShort = (p: StockProduct) => p.risk === 'out-of-stock' || p.risk === 'low-stock'

/** One product as a preview or the read shows it: units and days, never money. */
function productLine(p: StockProduct) {
  return {
    productId: p.productId, sku: p.sku, name: p.name, risk: p.risk,
    units: p.units, unitsInOwnOrPoolStock: p.warehouseUnits, amazonFbaUnits: p.amazonFbaUnits, ...(p.pooled ? { sharedStock: SHARED_WORDS } : {}),
    unitsPerDay: p.unitsPerDay, daysOfCover: p.daysOfCover, shortBelowDays: p.lowBelowDays, backAtDays: p.restoreAtDays,
    leadTimeDays: p.leadTimeDays, safetyDays: p.safetyDays, inboundUnits: p.inboundUnits, paceAsOf: iso(p.paceAsOf),
  }
}

/** Why a short product holds its ad group down (the first one), in words. */
function shortWords(p: StockProduct): string {
  if (p.risk === 'out-of-stock') return `${p.sku ?? p.productId} is out of stock`
  return `${p.sku ?? p.productId} has ${p.daysOfCover} days of cover, below its line of ${p.lowBelowDays} days`
}

// ── Where the writes land ─────────────────────────────────────────────────────────────────────────

/** Every campaign the writes touch must answer the same way, or the request is refused (as pause-ads decides it). */
async function reachOf(writes: readonly RuleWrite[]): Promise<{ reach: StoredReach } | { refused: Extract<LiveReach, { reach: 'refused' }> }> {
  const profiles = new Set<string>()
  for (const { label: _label, ...intent } of [...writes].sort((a, b) => (a.campaignId < b.campaignId ? -1 : 1))) {
    const reach = await checkLiveReach(intent)
    if (reach.reach === 'refused') return { refused: reach }
    if (reach.reach === 'live') profiles.add(reach.profileId)
  }
  return { reach: profiles.size ? { reach: 'live', profileId: [...profiles].sort().join(',') } : { reach: 'sandbox' } }
}

/**
 * One write per campaign and kind, at the highest bid it sets there, judged as the ads worker judges it: a floor is a
 * suppression (a halt does not hold it), a step and a give-back are plain writes (a halt holds them by rule).
 */
function writesOf(plans: ReadonlyArray<{ group: StockAdGroup; moves: StockBidMove[]; suppression: boolean }>): RuleWrite[] {
  const byKey = new Map<string, RuleWrite>()
  for (const { group, moves, suppression } of plans) {
    const highest = Math.max(0, ...moves.map((m) => m.toCents))
    const key = `${group.campaign.id}|${suppression}`
    const kept = byKey.get(key)
    if (kept && (kept.changes[0]?.valueCents ?? 0) >= highest) continue
    byKey.set(key, {
      campaignId: group.campaign.id, adGroupId: group.id, marketplace: group.campaign.marketplace,
      changes: [{ field: 'bid', valueCents: highest || null }], isSuppression: suppression, label: `campaign "${group.campaign.name}"`,
    })
  }
  return [...byKey.values()]
}

const fingerprint = (parts: string[]) => createHash('sha256').update(parts.join('|')).digest('base64url').slice(0, 32)
const movesKey = (moves: StockBidMove[]) => moves.map((m) => `${moveKey(m)}:${m.fromCents}:${m.toCents}:${m.rememberedCents ?? ''}`).join(',')

/** The ad groups a change names, read with their stock; a request naming nothing, or too much, is refused. */
async function namedGroups(args: Record<string, unknown>): Promise<{ groups: StockAdGroup[] } | { refusal: string }> {
  const adGroupIds = unique(args.adGroupIds as string[] | undefined), campaignIds = unique(args.campaignIds as string[] | undefined)
  if (!adGroupIds.length && !campaignIds.length) return { refusal: 'Name the ad groups (adGroupIds) or the campaigns (campaignIds, each with its ad groups).' }
  if (adGroupIds.length + campaignIds.length > MAX_NAMED) return { refusal: `${adGroupIds.length + campaignIds.length} named: at most ${MAX_NAMED} ad groups and campaigns in one request. Split them.` }
  const { adGroups, missing } = await readStockAdGroups({ adGroupIds, campaignIds })
  if (missing.length) return { refusal: `Not queued: ${named(missing)} ${missing.length === 1 ? 'was' : 'were'} not found in this business.` }
  if (adGroups.length > MAX_NAMED * 4) return { refusal: `The campaigns named hold ${adGroups.length} ad groups: name fewer campaigns, or the ad groups themselves.` }
  return { groups: adGroups }
}

/** A plain bid write of one ad group default or one target, as the approved request (the normal Claude bid path). */
function writeBid(m: Pick<StockBidMove, 'kind' | 'id'>, cents: number, w: { actor: AdsActor; reason: string; changeSetId: string; manual: boolean; confirmOwnLimits: boolean; force: boolean }) {
  const common = { actor: w.actor, reason: w.reason, changeSetId: w.changeSetId, manual: w.manual, force: w.force, ...(w.force ? {} : { confirmOwnLimits: w.confirmOwnLimits }) }
  return m.kind === 'adGroup'
    ? updateAdGroupWithSync({ adGroupId: m.id, patch: { defaultBidCents: cents }, ...common })
    : updateAdTargetWithSync({ adTargetId: m.id, patch: { bidCents: cents }, ...common })
}

/** How a stock change records its ad groups and bids, and what the undo guard compares now. */
interface StockChangeAfter { adGroups: Array<{ adGroupId: string; floored: boolean; by: string | null }>; stepAdGroupIds?: string[]; steps: Array<{ kind: 'adGroup' | 'target'; id: string; cents: number | null }> }
interface StepEntry { adGroupId: string; kind: 'adGroup' | 'target'; id: string; fromCents: number; toCents: number }

async function stockStateOf(change: Pick<ToolChange, 'after'>): Promise<StockChangeAfter> {
  const a = (change.after ?? {}) as Partial<StockChangeAfter>
  const groups = (a.adGroups ?? []).map((g) => g.adGroupId)
  const keys = (a.steps ?? []).map((s) => `${s.kind}:${s.id}`)
  const [floors, bids] = await Promise.all([stockFloorsNow(groups), stockBidsNow(keys)])
  return {
    adGroups: groups.map((id) => ({ adGroupId: id, ...(floors.get(id) ?? { floored: false, by: null }) })),
    ...(a.stepAdGroupIds ? { stepAdGroupIds: a.stepAdGroupIds } : {}),
    steps: (a.steps ?? []).map((s) => ({ kind: s.kind, id: s.id, cents: bids.get(`${s.kind}:${s.id}`) ?? null })),
  }
}

/**
 * The stock steps on record for these ad groups, newest first: each lowering's change record keeps the bids it stepped
 * (`before.steps`); one undone is left out (its undo gave them back).
 */
async function stepRecordsFor(adGroupIds: readonly string[]): Promise<Map<string, StepRecord[]>> {
  const ids = [...new Set(adGroupIds)]
  const out = new Map<string, StepRecord[]>()
  if (!ids.length) return out
  const rows = await prisma.agentChange.findMany({
    where: { toolName: TOOL.lower, undoneAt: null, OR: ids.map((id) => ({ after: { path: ['stepAdGroupIds'], array_contains: [id] } })) },
    orderBy: [{ executedAt: 'desc' }, { id: 'desc' }],
    take: STEP_RECORDS_READ,
    select: { approvalId: true, before: true },
  })
  for (const row of rows) {
    const byGroup = new Map<string, Map<string, { fromCents: number; toCents: number }>>()
    for (const s of ((row.before as { steps?: StepEntry[] } | null)?.steps ?? [])) {
      if (!ids.includes(s.adGroupId)) continue
      const bids = byGroup.get(s.adGroupId) ?? new Map<string, { fromCents: number; toCents: number }>()
      bids.set(`${s.kind}:${s.id}`, { fromCents: s.fromCents, toCents: s.toCents })
      byGroup.set(s.adGroupId, bids)
    }
    for (const [groupId, bids] of byGroup) out.set(groupId, [...(out.get(groupId) ?? []), { approvalId: row.approvalId, bids }])
  }
  return out
}

// ── lower-ad-bids-for-stock ───────────────────────────────────────────────────────────────────────

interface LowerPlan {
  group: StockAdGroup
  how: 'floor' | 'step'
  floorCents: number
  stepPct: number | null
  moves: StockBidMove[]
  floorWords: string
  stepWords: string | null
}

/** Why an ad group is not lowered (left as it is), or null when its stock lets it be. */
function lowerLeft(g: StockAdGroup): string | null {
  const notSp = spOnlyRefusal(g.campaign)
  if (notSp) return notSp
  if (g.status !== 'ENABLED') return 'it is not enabled: it spends nothing'
  if (g.campaign.status !== 'ENABLED') return 'its campaign is not enabled: it spends nothing'
  if (g.campaign.floor) return `its campaign is already stopped with low bids (by ${ownerWords(g.campaign.floor.by)})`
  if (g.ownFloor && !isPerson(g.ownFloor.by)) return `it is already floored by ${ownerWords(g.ownFloor.by)}, which holds its bids at its stop bid`
  switch (g.risk) {
    case 'ok': return 'every product it advertises has enough stock'
    case 'none': return 'it advertises no enabled product ad'
    case 'unknown': return 'it advertises an ad Nexus cannot tie to a product, so Nexus cannot judge its stock'
    case 'shared': return `${SHARED_WORDS} (${named(g.products.filter((p) => p.risk === 'shared').map((p) => p.sku ?? p.productId))}), so it is lowered only when that shared stock is out`
    case 'mixed': {
      const fine = g.products.filter((p) => p.risk === 'ok').map((p) => p.sku ?? p.productId)
      return `mixed — it also advertises ${named(fine)} with enough stock, so it is never lowered as a whole: move the short products into their own ad group in Nexus, or lower single bids (bulk-ad-bid-change)`
    }
    default: return null
  }
}

async function decideLower(args: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; plans: LowerPlan[] }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult, plans: [] as LowerPlan[] })
  const loaded = await namedGroups(args)
  if ('refusal' in loaded) return refuse(loaded.refusal)
  const lowerTo = args.lowerTo === 'floor' ? 'floor' : 'step'
  const rules = await stockBidRules(loaded.groups)
  const plans: LowerPlan[] = []
  const left: Array<{ group: StockAdGroup; why: string }> = []
  for (const g of loaded.groups) {
    const why = lowerLeft(g)
    if (why) { left.push({ group: g, why }); continue }
    const r = rules.get(g.id)!
    // A person's floor already holds an ad group at its floor: only a floor (a keyword added since) is left to do.
    const how = g.risk === 'out-of-stock' || lowerTo === 'floor' || g.ownFloor ? 'floor' : 'step'
    if (how === 'step' && r.stepPct == null) {
      left.push({ group: g, why: 'it is short (not out) of stock, and no largest bid change is set to step by (the ads strategy or the campaign\'s guardrail): ask with lowerTo "floor", or set one' })
      continue
    }
    const moves = await stockLoweringMoves(g, how === 'step' ? { stepPct: r.stepPct!, minCents: r.stepMinCents } : { floorCents: r.floorCents })
    if (!moves.length) {
      left.push({ group: g, why: how === 'step' ? `its bids are already at or below the lowest a step may set (${amountLabel(r.stepMinCents, g.campaign.currency)})` : `its bids are already at or below its floor (${amountLabel(r.floorCents, g.campaign.currency)})` })
      continue
    }
    plans.push({
      group: g, how, floorCents: r.floorCents, stepPct: how === 'step' ? r.stepPct : null, moves,
      floorWords: how === 'step'
        ? `never below ${amountLabel(r.stepMinCents, g.campaign.currency)}`
        : r.floorFrom ? `the stop bid ${amountLabel(r.floorCents, g.campaign.currency)} (${strategyWords(r.floorFrom)})` : `the ${r.floorCents}-cent floor (the ads strategy sets no stop bid here)`,
      stepWords: how === 'step' ? `${r.stepPct} % (${r.stepFrom ? strategyWords(r.stepFrom) : 'the campaign\'s max-change guardrail'})` : null,
    })
  }
  if (!plans.length) return refuse(`Nothing to lower: ${named(left.map((l) => `${groupLabel(l.group)}: ${l.why}`))}.`)

  const writes = writesOf(plans.map((p) => ({ ...p, suppression: p.how === 'floor' })))
  const reach = await reachOf(writes)
  if ('refused' in reach) return refuse(reachRefusal(reach.refused))
  const stored = reach.reach
  // The facts a run by rule is judged on: each ad group one cut, from its highest bid to its highest after — a floor's low
  // bid (forced: no lowest bid and no step binds it), or a plain step (the strategy's band and step bind it) — the ads
  // strategy where it lands and the gate as the rule's write.
  const items: KitItem[] = plans.map((p) => ({
    entity: { kind: 'adGroup', id: p.group.id },
    change: { field: 'bid', fromCents: Math.max(...p.moves.map((m) => m.fromCents)), toCents: Math.max(...p.moves.map((m) => m.toCents)), forced: p.how === 'floor' },
  }))
  const ruleFacts = await ruleFactsFor({ tool: TOOL.lower, limits: LOWER_LIMITS, items, writes, approvalId: ctx.approvalId ?? null })
  const steps = plans.filter((p) => p.how === 'step')
  const stepCampaigns = [...new Map(steps.map((p) => [p.group.campaign.id, p.group.campaign])).values()].slice(0, 10)
  const alsoMoved = (await Promise.all(stepCampaigns.map(async (c) => ({ campaign: c, bound: await alsoChangedBy(c.id) })))).filter((x) => x.bound.automations.length)

  const bids = plans.reduce((n, p) => n + p.moves.length, 0)
  const out = plans.filter((p) => p.group.risk === 'out-of-stock').length
  const lines = plans.map((p) => {
    const top = p.moves.reduce((a, b) => (b.fromCents > a.fromCents ? b : a))
    return { label: `${groupLabel(p.group)} · ${plural(p.moves.length, 'bid')}, the highest`, fromCents: top.fromCents, toCents: top.toCents, currency: p.group.campaign.currency, marketplace: p.group.campaign.marketplace }
  })
  const effect = `Lowers the bids of ${plural(plans.length, 'ad group')} whose every product is short of stock (${plural(bids, 'bid')}), never pausing them: `
    + named(plans.map((p) => `${groupLabel(p.group)} ${p.group.risk === 'out-of-stock' ? 'out of stock → floored at' : `short → ${p.how === 'step' ? `one step down, ${p.stepWords},` : 'floored at'}`} ${p.floorWords}`), 5)
    + `. ${plans.some((p) => p.how === 'floor') ? 'A floor remembers each bid; ' : ''}restore-ad-bids-after-stock gives them back when cover returns.`
    + (left.length ? ` ${plural(left.length, 'ad group')} named ${left.length === 1 ? 'is' : 'are'} left as ${left.length === 1 ? 'it is' : 'they are'} (see left).` : '')
    + ` ${FBA_NOTE}`
  // Every ad group named, its verdict, and every bid it moves: a move of stock or of a bid after approval is caught.
  const basis = fingerprint([
    ...plans.map((p) => `${p.group.id}:${p.group.risk}:${p.how}:${p.floorCents}:${p.stepPct ?? ''}:${movesKey(p.moves)}`),
    ...left.map((l) => `${l.group.id}:left:${l.why}`),
  ])
  const covers = plans.flatMap((p) => p.group.products.map((x) => (x.risk === 'out-of-stock' ? 0 : x.daysOfCover)))
  return {
    plans,
    result: {
      ok: true,
      preview: {
        action: TOOL.lower,
        summary: effect,
        ...(new Set(plans.map((p) => p.group.campaign.id)).size === 1 ? { campaign: { id: plans[0].group.campaign.id, name: plans[0].group.campaign.name, marketplace: plans[0].group.campaign.marketplace } } : {}),
        totals: { adGroups: plans.length, outOfStock: out, short: plans.length - out, floored: plans.length - steps.length, stepped: steps.length, bids, left: left.length },
        changes: lines.slice(0, LINES_SHOWN),
        ...(lines.length > LINES_SHOWN ? { moreChanges: lines.length - LINES_SHOWN } : {}),
        adGroups: plans.slice(0, LINES_SHOWN).map((p) => ({
          adGroupId: p.group.id, name: p.group.name, campaign: { id: p.group.campaign.id, name: p.group.campaign.name, marketplace: p.group.campaign.marketplace },
          risk: p.group.risk, how: p.how, ...(p.how === 'floor' ? { floorCents: p.floorCents } : {}), floor: p.floorWords, ...(p.stepWords ? { step: p.stepWords } : {}),
          currency: p.group.campaign.currency, bids: p.moves.slice(0, LINES_SHOWN).map((m) => ({ kind: m.kind, id: m.id, text: m.text, fromCents: m.fromCents, toCents: m.toCents })),
          ...(p.moves.length > LINES_SHOWN ? { moreBids: p.moves.length - LINES_SHOWN } : {}),
          products: p.group.products.slice(0, 5).map(productLine),
          why: named(p.group.products.filter(isShort).map(shortWords)),
        })),
        ...(left.length ? { left: left.slice(0, LINES_SHOWN).map((l) => ({ adGroupId: l.group.id, name: l.group.name, campaignId: l.group.campaign.id, risk: l.group.risk, why: l.why })) } : {}),
        ...(left.length > LINES_SHOWN ? { moreLeft: left.length - LINES_SHOWN } : {}),
        ...(steps.length ? { stepNote: STEP_NOTE, warning: STEP_NOTE } : {}),
        ...(alsoMoved.length ? { alsoChangedBy: alsoMoved.map((x) => ({ campaignId: x.campaign.id, campaign: x.campaign.name, automations: x.bound.automations })) } : {}),
        // For the limits: the most days of cover of any product it lowers for (out of stock is 0).
        cover: { highestDaysOfCover: covers.some((c) => c == null) ? null : Math.max(0, ...(covers as number[])) },
        basis,
        reach: stored,
        reachNote: reachNote(stored),
        stockNote: FBA_NOTE,
        ...ruleFacts,
        effect,
      },
    },
  }
}

/** lower-ad-bids-for-stock's Claude limits: the kit's, and the most days of cover a run by rule lowers for. */
const LOWER_LIMITS = adKitLimits({ maxItems: 50 }, {
  maxDaysOfCover: z.number().int().min(0).max(365).default(365)
    .describe('by rule, lower only ad groups whose products have at most this many days of cover (out of stock is 0); Nexus\'s own short-of-stock line binds first; lower is tighter'),
})

function lowerLimitsRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const highest = (preview as { cover?: { highestDaysOfCover?: unknown } } | null)?.cover?.highestDaysOfCover
  if (typeof highest !== 'number') return 'the preview does not say the days of cover it lowers for; a person decides'
  const max = typeof limits.maxDaysOfCover === 'number' ? limits.maxDaysOfCover : 365
  return highest > max ? `it lowers for a product with ${highest} days of cover, more than the ${max} this tool's limits let run without a person; a person decides` : null
}

/** C2 — undo of a lowering gives back what it lowered (even while stock is still short: a person's undo). */
const LOWER_UNDO: ToolUndo = {
  current: stockStateOf,
  request(change) {
    const a = (change.after ?? {}) as Partial<StockChangeAfter>
    const ids = [...new Set([...(a.adGroups ?? []).filter((g) => g.floored).map((g) => g.adGroupId), ...(a.stepAdGroupIds ?? [])])]
    if (!ids.length) return { refusal: 'This change does not record the ad groups it lowered.' }
    return { tool: TOOL.restore, args: { adGroupIds: ids, evenIfStillShort: true, why: 'undo of a stock lowering' } }
  },
}

async function runLower(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { result: fresh, plans } = await decideLower(args, ctx)
  const refusal = recheck(ctx, fresh, ['basis', 'reach'])
  if (refusal) return notRun(refusal)
  const p = fresh.preview as { reach: StoredReach; effect: string }
  const run = approvedRun(ctx, String(args.why ?? '').trim() || 'stock is short: bids lowered instead of pausing')
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  let moved = 0
  const failed: string[] = []
  const steps: StepEntry[] = []
  for (const plan of plans) {
    if (plan.how === 'floor') {
      const out = await lowerAdGroupBids(plan.group.id, { actor: run.actor, reason: run.reason, floorCents: plan.floorCents, changeSetId: run.changeSetId, manual: run.manual })
      moved += out.moved
      if (out.failed) failed.push(`${groupLabel(plan.group)} (${plural(out.failed, 'bid')} refused)`)
      continue
    }
    // A step: plain bid writes (not forced), so the gate, the bounds and the step clamp judge each as any Claude bid.
    let refused = 0
    for (const m of plan.moves) {
      const out = await writeBid(m, m.toCents, { actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, force: false })
      if (out.ok) { moved++; steps.push({ adGroupId: plan.group.id, kind: m.kind, id: m.id, fromCents: m.fromCents, toCents: m.toCents }) }
      else refused++
    }
    if (refused) failed.push(`${groupLabel(plan.group)} (${plural(refused, 'bid')} refused)`)
  }
  const floorGroups = plans.filter((x) => x.how === 'floor')
  const stepAdGroupIds = [...new Set(steps.map((s) => s.adGroupId))]
  // The stepped bids (only those that landed) are what a give-back follows back: kept in this record.
  const change = {
    before: { changeSetId: run.changeSetId, adGroups: floorGroups.map((x) => ({ adGroupId: x.group.id, floored: !!x.group.ownFloor, by: x.group.ownFloor?.by ?? null })), steps },
    after: await stockStateOf({ after: { adGroups: floorGroups.map((x) => ({ adGroupId: x.group.id, floored: false, by: null })), stepAdGroupIds, steps: steps.map((s) => ({ kind: s.kind, id: s.id, cents: null })) } }),
  }
  const data = { lowered: plans.length, floored: floorGroups.length, stepped: stepAdGroupIds.length, bidsMoved: moved, failed: failed.length, reach: p.reach, changeSetId: run.changeSetId, note: 'Each lowered bid is queued for Amazon; approval-status follows them.' }
  if (failed.length) return { ok: false, data, change, error: `Partly run: ${moved} bids lowered; ${named(failed)}. undo-change puts back what ran.` }
  return { ok: true, data, change }
}

// ── restore-ad-bids-after-stock ───────────────────────────────────────────────────────────────────

interface RestorePlan { group: StockAdGroup; moves: StockBidMove[]; moved: Array<{ kind: 'adGroup' | 'target'; id: string; text: string; nowCents: number }> }

/** Why an ad group's bids are not given back (left as they are), or null. `stepped`: stock steps on record for it. */
function restoreLeft(g: StockAdGroup, evenIfStillShort: boolean, stepped: boolean): string | null {
  const notSp = spOnlyRefusal(g.campaign)
  if (notSp) return notSp
  if (g.campaign.floor) return `its campaign is stopped with low bids (by ${ownerWords(g.campaign.floor.by)}): its bids cannot serve until that floor is lifted, and the campaign's own restore leaves an ad group's own floor and its stock steps alone — give this one back after that`
  if (g.ownFloor && !isPerson(g.ownFloor.by)) return `it was floored by ${ownerWords(g.ownFloor.by)}: only a floor a person set (this tool's, or his own) is given back here; that engine gives back its own`
  if (!g.ownFloor && !stepped) return 'it was not lowered for stock: no floor of its own and no stock step on record'
  if (evenIfStillShort) return null
  if (g.risk === 'unknown') return 'it advertises an ad Nexus cannot tie to a product, so Nexus cannot tell its stock is back'
  if (g.risk === 'none') return 'it advertises no enabled product ad, so Nexus cannot tell its stock is back'
  if (!g.recovered) {
    const short = g.products.find((p) => !p.recovered)!
    return short.risk === 'out-of-stock'
      ? `still out of stock: ${short.sku ?? short.productId}`
      : `still short of stock: ${short.sku ?? short.productId} has ${short.daysOfCover} days of cover, below its restart line of ${short.restoreAtDays} days`
  }
  return null
}

async function decideRestore(args: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; plans: RestorePlan[] }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult, plans: [] as RestorePlan[] })
  const loaded = await namedGroups(args)
  if ('refusal' in loaded) return refuse(loaded.refusal)
  const evenIfStillShort = args.evenIfStillShort === true
  const records = await stepRecordsFor(loaded.groups.map((g) => g.id))
  const plans: RestorePlan[] = []
  const left: Array<{ group: StockAdGroup; why: string }> = []
  for (const g of loaded.groups) {
    const why = restoreLeft(g, evenIfStillShort, (records.get(g.id) ?? []).length > 0)
    if (why) { left.push({ group: g, why }); continue }
    const back = await stockGiveBackMoves(g, records.get(g.id) ?? [])
    // A person's floor is lifted even with nothing to give back; a step alone with nothing left to give back is said.
    if (!g.ownFloor && !back.moves.length) {
      left.push({ group: g, why: back.moved.length ? `every bid a stock step lowered was moved since (${named(back.moved.map((m) => `“${m.text}” now ${amountLabel(m.nowCents, g.campaign.currency)}`))}): left as it is` : 'its bids are back already' })
      continue
    }
    plans.push({ group: g, ...back })
  }
  if (!plans.length) return refuse(`Nothing to give back: ${named(left.map((l) => `${groupLabel(l.group)}: ${l.why}`))}.`)

  // Item 2 of the W3-3 review — a give-back adds spend: never a suppression, so a halt refuses it by rule.
  const writes = writesOf(plans.map((p) => ({ ...p, suppression: false })))
  const reach = await reachOf(writes)
  if ('refused' in reach) return refuse(reachRefusal(reach.refused))
  const stored = reach.reach
  // It adds spend: an ad group whose floor lifts is a restart (its campaign's daily budget counted once per campaign — it
  // can spend again in full), a stepped one a raise of its highest bid; the month projected; the gate as the rule's write.
  const counted = new Set<string>()
  const items: KitItem[] = plans.map((p) => {
    if (!p.group.ownFloor) {
      return { entity: { kind: 'adGroup', id: p.group.id }, change: { field: 'bid', fromCents: Math.max(...p.moves.map((m) => m.fromCents)), toCents: Math.max(...p.moves.map((m) => m.toCents)), forced: true } }
    }
    const first = !counted.has(p.group.campaign.id)
    counted.add(p.group.campaign.id)
    return { entity: { kind: 'adGroup', id: p.group.id }, change: { field: 'status', from: 'LOW_BIDS', to: 'ENABLED', dailyBudgetCents: first ? p.group.campaign.dailyBudgetCents : 0 } }
  })
  const ruleFacts = await ruleFactsFor({ tool: TOOL.restore, limits: RESTORE_LIMITS, items, writes, approvalId: ctx.approvalId ?? null, projectMonth: true })

  const all = plans.flatMap((p) => p.moves.map((m) => ({ ...m, currency: p.group.campaign.currency })))
  const top = all.reduce<(typeof all)[number] | null>((best, m) => (!best || m.toCents > best.toCents ? m : best), null)
  const held = all.filter((m) => m.heldBy)
  const moved = plans.flatMap((p) => p.moved.map((m) => ({ ...m, adGroupId: p.group.id, currency: p.group.campaign.currency })))
  const lines = plans.flatMap((p) => p.moves.map((m) => ({
    label: `${groupLabel(p.group)} · ${m.kind === 'adGroup' ? 'default bid' : `“${m.text}”`}`, fromCents: m.fromCents, toCents: m.toCents, currency: p.group.campaign.currency,
    marketplace: p.group.campaign.marketplace, ...(m.heldBy ? { heldBy: m.heldBy } : {}),
  })))
  const effect = `Gives back the bids of ${plural(plans.length, 'ad group')} lowered for stock (${plural(all.length, 'bid')}${top ? `, the highest ${amountLabel(top.toCents, top.currency)}` : ''}): `
    + named(plans.map((p) => groupLabel(p.group)), 5)
    + (evenIfStillShort ? ', even though stock is still short there (an undo)' : ', their stock back above every restart line')
    + `. Spend resumes${held.length ? `; ${plural(held.length, 'bid')} at a bid limit instead of the bid it had (each line says which)` : ''}.`
    + (moved.length ? ` ${plural(moved.length, 'bid')} a stock step lowered ${moved.length === 1 ? 'was' : 'were'} moved since by an engine or a person: left as ${moved.length === 1 ? 'it is' : 'they are'} (see notGivenBack).` : '')
    + (left.length ? ` ${plural(left.length, 'ad group')} named ${left.length === 1 ? 'is' : 'are'} left as ${left.length === 1 ? 'it is' : 'they are'} (see left).` : '')
    + ` ${FBA_NOTE}`
  const covers = evenIfStillShort ? [] : plans.flatMap((p) => p.group.products.map((x) => x.daysOfCover))
  return {
    plans,
    result: {
      ok: true,
      preview: {
        action: TOOL.restore,
        summary: effect,
        ...(new Set(plans.map((p) => p.group.campaign.id)).size === 1 ? { campaign: { id: plans[0].group.campaign.id, name: plans[0].group.campaign.name, marketplace: plans[0].group.campaign.marketplace } } : {}),
        currency: top?.currency ?? plans[0].group.campaign.currency,
        totals: { adGroups: plans.length, bids: all.length, notGivenBack: moved.length, left: left.length },
        changes: lines.slice(0, LINES_SHOWN),
        ...(lines.length > LINES_SHOWN ? { moreChanges: lines.length - LINES_SHOWN } : {}),
        adGroups: plans.slice(0, LINES_SHOWN).map((p) => ({
          adGroupId: p.group.id, name: p.group.name, campaign: { id: p.group.campaign.id, name: p.group.campaign.name, marketplace: p.group.campaign.marketplace },
          floor: p.group.ownFloor ? { by: p.group.ownFloor.by, since: iso(p.group.ownFloor.at) } : null, products: p.group.products.slice(0, 5).map(productLine),
        })),
        ...(moved.length ? { notGivenBack: moved.slice(0, LINES_SHOWN).map((m) => ({ adGroupId: m.adGroupId, kind: m.kind, id: m.id, text: m.text, nowCents: m.nowCents, currency: m.currency, why: 'moved since the stock step (by an engine or a person)' })) } : {}),
        ...(left.length ? { left: left.slice(0, LINES_SHOWN).map((l) => ({ adGroupId: l.group.id, name: l.group.name, campaignId: l.group.campaign.id, risk: l.group.risk, why: l.why })) } : {}),
        ...(left.length > LINES_SHOWN ? { moreLeft: left.length - LINES_SHOWN } : {}),
        ...(evenIfStillShort ? { evenIfStillShort: true, warning: 'Stock is still short for some of these products: the bids come back anyway (an undo).' } : {}),
        highestRestoredBidCents: top?.toCents ?? 0,
        // For the limits: the fewest days of cover among the products it restarts (unknown pace: null), and how many are unknown.
        cover: { lowestDaysOfCover: covers.filter((c): c is number => c != null).reduce<number | null>((min, c) => (min == null || c < min ? c : min), null), unknown: covers.filter((c) => c == null).length },
        // Every ad group named, whose floor it lifts and every bid it gives back: a move after approval is caught.
        basis: fingerprint([
          ...plans.map((p) => `${p.group.id}:${p.group.ownFloor?.by ?? ''}:${p.group.recovered}:${movesKey(p.moves)}:${p.moved.map((m) => `${m.kind}:${m.id}`).join(',')}`),
          ...left.map((l) => `${l.group.id}:left:${l.why}`),
        ]),
        reach: stored,
        reachNote: reachNote(stored),
        stockNote: FBA_NOTE,
        ...ruleFacts,
        effect,
      },
    },
  }
}

/** restore-ad-bids-after-stock's Claude limits: the kit's, the highest bid given back by rule (0: every give-back waits), the cover it needs. */
const RESTORE_LIMITS = adKitLimits({ maxItems: 50 }, {
  maxRestoredBidCents: z.number().int().min(0).max(100_000).default(0)
    .describe('the highest bid a give-back may put back without a person, in minor units of the campaign\'s currency; 0 = every give-back waits for a person'),
  minDaysOfCoverToRestore: z.number().int().min(0).max(365).default(0)
    .describe('by rule, give back only when every product has at least this many days of cover (Nexus\'s own restart line binds first; an unknown pace never passes a number above 0); higher is tighter'),
})

function restoreLimitsRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { evenIfStillShort?: unknown; highestRestoredBidCents?: unknown; currency?: unknown; cover?: { lowestDaysOfCover?: unknown; unknown?: unknown } }
  if (p.evenIfStillShort === true) return 'it gives bids back while stock is still short (an undo); a person decides'
  const highest = Number(p.highestRestoredBidCents)
  if (!Number.isFinite(highest)) return 'the preview does not say the highest bid it gives back; a person decides'
  const max = typeof limits.maxRestoredBidCents === 'number' ? limits.maxRestoredBidCents : 0
  const currency = typeof p.currency === 'string' ? p.currency : 'EUR'
  if (highest > max) return `its highest bid given back is ${amountLabel(highest, currency)}, more than the ${amountLabel(max, currency)} this tool's limits let run without a person${max === 0 ? ' (0: every give-back waits for a person)' : ''}; a person decides`
  const min = typeof limits.minDaysOfCoverToRestore === 'number' ? limits.minDaysOfCoverToRestore : 0
  if (min > 0) {
    if (!p.cover || typeof p.cover.unknown !== 'number') return 'the preview does not say the days of cover it gives back for; a person decides'
    if (p.cover.unknown > 0) return `${plural(p.cover.unknown, 'product')} it gives back for ${p.cover.unknown === 1 ? 'has' : 'have'} no known pace, so no days of cover to hold against the ${min} this tool's limits need; a person decides`
    const lowest = typeof p.cover.lowestDaysOfCover === 'number' ? p.cover.lowestDaysOfCover : null
    if (lowest != null && lowest < min) return `a product it gives back for has ${lowest} days of cover, fewer than the ${min} this tool's limits need to run without a person; a person decides`
  }
  return null
}

/** C2 — undo of a give-back lowers the same ad groups again (refused, and said, once their stock is no longer short). */
const RESTORE_UNDO: ToolUndo = {
  current: stockStateOf,
  request(change) {
    const b = (change.before ?? {}) as { adGroups?: Array<{ adGroupId: string }>; steps?: StepEntry[] }
    const ids = [...new Set([...(b.adGroups ?? []).map((g) => g.adGroupId), ...(b.steps ?? []).map((s) => s.adGroupId)])]
    if (!ids.length) return { refusal: 'This change does not record the ad groups it gave back.' }
    return { tool: TOOL.lower, args: { adGroupIds: ids, why: 'undo of a give-back after stock' } }
  },
}

async function runRestore(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { result: fresh, plans } = await decideRestore(args, ctx)
  const refusal = recheck(ctx, fresh, ['basis', 'reach'])
  if (refusal) return notRun(refusal)
  const p = fresh.preview as { reach: StoredReach }
  const run = approvedRun(ctx, String(args.why ?? '').trim() || 'stock is back: bids given back')
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  let refused = 0
  const given: StepEntry[] = []
  for (const plan of plans) {
    // A person's floor first (its remembered bids, retry-safe); then each bid that goes back through the stock steps, a
    // give-back (forced past the step clamp, held inside the bid limits like the floor's own give-back).
    if (plan.group.ownFloor) await restoreAdGroupBids(plan.group.id, { actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, manual: run.manual })
    for (const m of plan.moves) {
      if (plan.group.ownFloor && !m.viaSteps) { given.push({ adGroupId: plan.group.id, kind: m.kind, id: m.id, fromCents: m.fromCents, toCents: m.toCents }); continue }
      const out = await writeBid(m, m.toCents, { actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, force: true })
      if (out.ok || out.error === 'no_changes') given.push({ adGroupId: plan.group.id, kind: m.kind, id: m.id, fromCents: m.fromCents, toCents: m.toCents })
      else refused++
    }
  }
  const restored = given.length
  const floorGroups = plans.filter((x) => x.group.ownFloor)
  const change = {
    before: { changeSetId: run.changeSetId, adGroups: floorGroups.map((x) => ({ adGroupId: x.group.id, floored: true, by: x.group.ownFloor?.by ?? null })), steps: given },
    after: await stockStateOf({ after: { adGroups: floorGroups.map((x) => ({ adGroupId: x.group.id, floored: false, by: null })), steps: given.map((s) => ({ kind: s.kind, id: s.id, cents: null })) } }),
  }
  const still = change.after.adGroups.filter((g) => g.floored)
  const data = { gaveBack: plans.length - still.length, bidsRestored: restored, reach: p.reach, changeSetId: run.changeSetId, note: 'Each bid is queued for Amazon; approval-status follows them.' }
  if (still.length || refused) {
    return { ok: false, data, change, error: `Partly run: ${restored} bids given back${still.length ? `; ${plural(still.length, 'ad group')} stay floored until every bid is accepted` : ''}${refused ? `; ${plural(refused, 'bid')} refused by the write` : ''}. Approve again to retry.` }
  }
  return { ok: true, data, change }
}

// ── ad-stock-risk (read) ──────────────────────────────────────────────────────────────────────────

const RISK_ORDER: Record<StockAdGroup['risk'], number> = { 'out-of-stock': 0, 'low-stock': 1, mixed: 2, shared: 3, unknown: 4, ok: 5, none: 6 }

/** What Claude may ask for next with one ad group, and why, from the facts alone. `stepped`: stock steps on record. */
function nextStep(g: StockAdGroup, stepped: boolean): { suggestedTool: string | null; why: string } {
  const personFloor = !!g.ownFloor && isPerson(g.ownFloor.by)
  if (personFloor || (stepped && !lowerLeft(g)?.startsWith('mixed') && g.products.every((p) => !isShort(p) || p.recovered))) {
    const held = restoreLeft(g, false, stepped)
    if (held == null) return { suggestedTool: TOOL.restore, why: `its stock is back above every restart line: its ${personFloor ? 'remembered' : 'stepped'} bids can be given back` }
    if (personFloor) return { suggestedTool: null, why: `a person's stock floor holds it; ${held}` }
  }
  const left = lowerLeft(g)
  return left == null ? { suggestedTool: TOOL.lower, why: named(g.products.filter(isShort).map(shortWords)) } : { suggestedTool: null, why: left }
}

async function stockRiskRead(args: Record<string, unknown>): Promise<ToolResult> {
  const lowBelowDays = typeof args.lowBelowDays === 'number' ? args.lowBelowDays : null
  const { adGroups, missing, capped } = await readStockAdGroups({
    adGroupIds: unique(args.adGroupIds as string[] | undefined), campaignIds: unique(args.campaignIds as string[] | undefined),
    market: typeof args.market === 'string' ? args.market : null, lowBelowDays,
  })
  const atRisk = (g: StockAdGroup) => g.risk === 'out-of-stock' || g.risk === 'low-stock' || g.risk === 'mixed' || (!!g.ownFloor && isPerson(g.ownFloor.by))
  // Ad groups or campaigns named: each one is shown, whatever its verdict (the at-risk filter is for a market-wide look).
  const asked = unique(args.adGroupIds as string[] | undefined).length + unique(args.campaignIds as string[] | undefined).length > 0
  const show = args.show === 'all' || args.show === 'at-risk' ? args.show : asked ? 'all' : 'at-risk'
  const chosen = (show === 'all' ? adGroups : adGroups.filter(atRisk)).sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.id.localeCompare(b.id))
  const limit = typeof args.limit === 'number' ? args.limit : 50
  const page = chosen.slice(0, limit)
  const records = await stepRecordsFor(page.map((g) => g.id))
  const products = new Map<string, { p: StockProduct; adGroupIds: string[] }>()
  for (const g of page) for (const p of g.products) {
    const kept = products.get(p.productId) ?? { p, adGroupIds: [] }
    kept.adGroupIds.push(g.id)
    products.set(p.productId, kept)
  }
  const count = (risk: StockAdGroup['risk']) => adGroups.filter((g) => g.risk === risk).length
  return {
    ok: true,
    data: {
      lines: lowBelowDays != null
        ? `Asked with its own line: a product is short below ${lowBelowDays} days of cover and back at ${lowBelowDays} (each product's own lead time is not used). ${LINES_NOTE.slice(LINES_NOTE.indexOf('Out of stock'))}`
        : LINES_NOTE,
      stockNote: `${FBA_NOTE} Units count the ledger the product sells from (its own warehouses, or the shared pool it borrows from) plus what Amazon and the channels hold, as the retail guard counts them; amazonFbaUnits is Amazon's number, read only.`,
      totals: {
        adGroups: adGroups.length, outOfStock: count('out-of-stock'), short: count('low-stock'), mixed: count('mixed'), shared: count('shared'), unknown: count('unknown'), ok: count('ok'),
        flooredByAPerson: adGroups.filter((g) => g.ownFloor && isPerson(g.ownFloor.by)).length, shown: page.length,
      },
      adGroups: page.map((g) => ({
        adGroupId: g.id, name: g.name, status: g.status, campaignId: g.campaign.id, campaign: g.campaign.name, market: g.campaign.marketplace,
        risk: g.risk, products: g.products.length, ...(g.unknownAds ? { adsWithoutProduct: g.unknownAds } : {}),
        floor: g.ownFloor ? { by: g.ownFloor.by, since: iso(g.ownFloor.at) } : null,
        campaignFloor: g.campaign.floor ? { by: g.campaign.floor.by, since: iso(g.campaign.floor.at) } : null,
        ...((records.get(g.id) ?? []).length ? { stockStepsOnRecord: (records.get(g.id) ?? []).length } : {}),
        ...nextStep(g, (records.get(g.id) ?? []).length > 0),
      })),
      products: [...products.values()].slice(0, LINES_SHOWN * 5).map(({ p, adGroupIds }) => ({ ...productLine(p), hasBuyBox: p.hasBuyBox, adGroupIds: adGroupIds.slice(0, 10) })),
      ...(chosen.length > page.length ? { more: chosen.length - page.length, moreNote: 'Narrow with market or campaignIds, or raise limit.' } : {}),
      ...(capped ? { capped: `Read the first ${STOCK_READ_MAX_AD_GROUPS} ad groups only: name a market or campaigns.` } : {}),
      ...(missing.length ? { notFound: missing } : {}),
    },
  }
}

// ── The tools ─────────────────────────────────────────────────────────────────────────────────────

const idList = (what: string) => z.array(z.string().trim().min(1).max(64)).max(MAX_NAMED).optional().describe(what)
const whyArg = z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit')

const adStockRisk: AgentTool = {
  name: TOOL.read,
  title: 'Stock risk of advertised products',
  input: z.object({
    market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('only this Amazon marketplace code (IT, DE, FR, ES, UK)'),
    campaignIds: idList('only the ad groups of these campaigns: Nexus campaign ids (campaignId in ad-campaigns)'),
    adGroupIds: idList('only these ad groups: Nexus ad group ids (adGroupId in ad-targets)'),
    lowBelowDays: z.coerce.number().int().min(1).max(365).optional().describe('count a product short below this many days of cover instead of its own lead time (a what-if: the change tools always use each product\'s own lines)'),
    show: z.enum(['at-risk', 'all']).optional().describe('at-risk: ad groups out of stock, short, mixed, or held by a person\'s stock floor (the default for a whole market); all: every ad group read (the default when ad groups or campaigns are named)'),
    limit: z.coerce.number().int().min(1).max(100).optional().describe('the most ad groups listed (default 50)'),
  }),
  requires: [F.adsView, F.inventoryView, F.replenishmentView],
  category: 'advertising',
  riskTier: 'low',
  readOnly: true,
  description:
    'Which advertised Amazon products are short of stock, and which ad groups advertise ONLY such products (read only; '
    + 'nothing changes). Per product: its units (the ledger it sells from — its own warehouses or the shared pool it '
    + 'borrows from — plus Amazon FBA, whose number is Amazon\'s and only read), units sold a day and days of cover from '
    + 'its latest replenishment suggestion, inbound units, and its two lines: short below its lead time, back at its lead '
    + 'time plus its safety days. Per ad group: out-of-stock, short, mixed (some products have enough stock: never '
    + 'lowered as a whole), ok or unknown; what floors it now; and the tool to ask with next (lower-ad-bids-for-stock, '
    + 'restore-ad-bids-after-stock). Stock problems lower bids, never pause, and never change a stock quantity.',
  handler: (args) => stockRiskRead(args),
}

const lowerAdBidsForStock: AgentTool = {
  name: TOOL.lower,
  title: 'Lower ad bids for low stock',
  input: z.object({
    adGroupIds: idList('the ad groups: Nexus ad group ids (adGroupId in ad-stock-risk or ad-targets)'),
    campaignIds: idList('campaigns: each of their ad groups whose every product is short of stock is lowered; the others are left and listed'),
    lowerTo: z.enum(['step', 'floor']).optional().describe('for an ad group short (not out) of stock: step (the default) — one step down by the largest bid change per action, a plain bid lowering; floor — straight to the stop bid, each bid remembered. Out of stock always goes to the floor'),
    why: whyArg,
  }),
  requires: [F.adsBidsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  // A stock brake may run by the business's rule, only inside its limits and the ads strategy (its `stop` kind; never
  // the ad group of a product the strategy protects) and only where the gate lets the rule's own write through.
  strategyBound: 'amazon-ads',
  maxClaudeTrust: 'auto',
  limits: LOWER_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits) ?? lowerLimitsRefusal(preview, limits),
  undo: LOWER_UNDO,
  description:
    'Lower the bids of Amazon Sponsored Products ad groups whose every advertised product is short of stock, never '
    + 'pausing them: out of stock, every keyword and target bid and the default bid go to the stop bid the ads strategy '
    + 'sets (the 2-cent floor when it sets none), each bid remembered; short, one step down by the largest bid change per '
    + 'action (the ads strategy\'s, or the campaign\'s guardrail) as a plain bid lowering — auto-bid leaves such a bid '
    + 'alone for 60 days, any stop still floors it, and a rule or plan bound to the campaign may move it — or to the floor '
    + 'when asked. restore-ad-bids-after-stock gives the bids back when cover returns. "Short" is Nexus\'s own line per '
    + 'product (days of cover below its lead time; see ad-stock-risk). An ad group that also advertises a product with '
    + 'enough stock (mixed) or one on another business\'s shared stock (unless that stock is out), whose campaign is already '
    + 'stopped with low bids, or that an engine floored, is left as it is and listed. '
    + `${BY_RULE_WORDS} — never the ad group of a product the strategy protects. The preview lists each ad group, its `
    + 'bids from → to, its products\' stock, where it lands (live at Amazon or sandbox) and the limits that apply. Refused, '
    + 'and not queued, when nothing would be lowered or Amazon\'s write gate would refuse it (a halt does not block '
    + 'lowering). It never changes a stock quantity: Amazon\'s FBA number is only read.',
  handler: async (args, ctx) => (await decideLower(args, ctx)).result,
  execute: (args, ctx) => runLower(args, ctx),
}

const restoreAdBidsAfterStock: AgentTool = {
  name: TOOL.restore,
  title: 'Restore ad bids after stock returns',
  input: z.object({
    adGroupIds: idList('the ad groups: Nexus ad group ids (adGroupId in ad-stock-risk)'),
    campaignIds: idList('campaigns: each of their ad groups lowered for stock, whose stock is back, gets its bids back; the others are left and listed'),
    evenIfStillShort: z.boolean().optional().describe('give the bids back even though stock is still short (an undo of a lowering); never runs by rule'),
    why: whyArg,
  }),
  requires: [F.adsBidsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  // It adds spend: strategy-bound, its `restore` kind; by default every give-back waits for a person (D-W2-1 = A).
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: RESTORE_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits) ?? restoreLimitsRefusal(preview, limits),
  undo: RESTORE_UNDO,
  description:
    'Give back the bids of Amazon Sponsored Products ad groups lowered for stock (lower-ad-bids-for-stock, or a person\'s '
    + 'own floor), once every advertised product is back above its restart line (days of cover at its lead time plus its '
    + 'safety days; see ad-stock-risk): a floor\'s remembered bids come back, and every bid a stock step lowered goes back '
    + 'to the bid it had while it still equals its stepped value (one an engine or a person moved since is left and '
    + 'named), held inside the bid limits in force. Only a floor a person set is given back here — never one an engine set '
    + '(the budget engine owns its own). Spend resumes. '
    + `${BY_RULE_WORDS}: no bid given back above the highest its limits allow (0 by default: every give-back waits for a `
    + 'person), within the market\'s daily raises and budget increase by rule, and keeping the month\'s spend forecast '
    + 'under its monthly cap. The preview lists each bid from → to in the campaign\'s currency, the products\' stock, '
    + 'where it lands and the limits that apply. An ad group still short of stock is left as it is and listed. It never '
    + 'changes a stock quantity.',
  handler: async (args, ctx) => (await decideRestore(args, ctx)).result,
  execute: (args, ctx) => runRestore(args, ctx),
}

export const ADS_STOCK_TOOLS: AgentTool[] = [adStockRisk, lowerAdBidsForStock, restoreAdBidsAfterStock]
