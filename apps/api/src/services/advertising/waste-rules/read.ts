/**
 * Negative Targeting page (2026-10-11) — the stop-waste rules reads behind the RULES block of
 * routes/advertising-waste.routes.ts:
 *
 *   listWasteRules     every waste rule — a rule that pauses or unpauses a keyword, or adds negatives (the two stop-waste
 *                      kinds and any older one: a Bid rule with THEN Pause, a Negative Targeting builder rule, an engine
 *                      rule) — with the Bid page's row shape (bid-rules/read.ts BidRuleRow: the honest mode, scope, 7 days,
 *                      runs, schedule) plus its `kind`, `source`, its stop-waste `test` and its ad-group grain; and the two
 *                      read-only pseudo-rows: `brain` (the brain's negatives lever) and `harvest` (Harvest's source negatives)
 *   wasteRuleHistory   one rule's (or pseudo-row's) changes: a keyword paused or turned on (the change feed, by the rule's
 *                      actor), a negative added (the rule's own live runs: the negative a rule makes through the harvest
 *                      wire is mirrored with no actor, so its runs are the record), with the undo handle where one exists
 *
 * Read only. The mode is the Bid page's ruleMode (bid-rules/pure.ts) over this page's facts: the ceiling from
 * ads-graduation.ts (D1: a stop-waste kind may be set to Auto), the gate from the level dial's own refusal, the
 * campaigns split by what the write gate does with an automatic pause or negative (market limits, the live-write list).
 * Money only in the money keys (BID_RULES_MONEY), stripped by the route without financials.adspend.view.
 */
import prisma from '../../../db.js'
import { notCapRefusal } from '../../automation-cap-predicate.js'
import { normalizeMarketplaceCode } from '../../../utils/marketplace-code.js'
import { marketLimitsOf } from '@nexus/shared/ads-market-limits'
import { resolveAutonomy, type AutonomyLevel } from '../ads-autonomy.js'
import { graduationCeiling } from '../ads-graduation.js'
import { NOT_PAGE_SHAPE, stopWasteKindOf, stopWasteParamsOf, stopWasteShapeOf, STOP_WASTE_CAPS, type StopWasteParams } from '../ads-graduation-stopwaste.js'
import { producedActionTypes } from '../ads-rule-adapter.service.js'
import { campaignsReachedBy, type ReachRule } from '../ads-rule-reach.service.js'
import { ruleStoredSchedule } from '../ads-rule-schedule.js'
import {
  ARCHIVED_ADS_DOMAIN, autoGateHold, MODE_OF_LEVEL, modeActs, ruleMode, ruleRunTimes, ruleSentence, scheduleWords,
  type AccountPosture, type BidMode, type BidRuleMode, type CampaignSplit, type Hold,
} from '../bid-rules/pure.js'
import { BID_RULES_MONEY, RefBook, ruleActors, writableMarkets, type Ref, type RefCounts, type RefSet } from '../bid-rules/read.js'
import { wasteKindOf, wasteSentence, type StopWasteKind } from './pure.js'
import { waitingAsksByAsker } from '../waste/read.js'

/** Ad-spend money of the waste rules' answers (the Bid page's keys, and the stop-waste test's bars): hidden without financials.adspend.view. */
export const WASTE_RULES_MONEY: Readonly<Record<string, string>> = {
  ...BID_RULES_MONEY,
  ...Object.fromEntries(['spendBarCents', 'targetCpaCents', 'spendFloorCents'].map((key) => [key, BID_RULES_MONEY.spendCents])),
}

export const BRAIN_ROW_ID = 'brain'
export const HARVEST_ROW_ID = 'harvest'
export const PSEUDO_ROWS: ReadonlySet<string> = new Set([BRAIN_ROW_ID, HARVEST_ROW_ID])

const DAY = 86_400_000
const WEEK_DAYS = 7
const UNSENT = new Set(['FAILED', 'SKIPPED', 'CANCELLED', 'SUPERSEDED'])

export interface WasteRuleRow {
  id: string
  /** The family: a keyword pause (or unpause) rule, or a search-term negative rule. */
  kind: StopWasteKind
  /** A rule, or a read-only pseudo-row (the brain's negatives lever, Harvest's source negatives). */
  source: 'rule' | 'brain' | 'harvest'
  /** Pseudo-rows: shown, never changed here (their own pages own them). */
  readOnly: boolean
  name: string
  sentence: string
  market: string | null
  mode: BidRuleMode
  /** The stop-waste test it runs on its own late-order-safe window; null for a rule made elsewhere (its trigger's window). */
  test: StopWasteParams | null
  /** What it applies to (the evaluator's matcher), with its ad-group grain when it has one; counts are the true totals. */
  scope: RefSet & { all: boolean; product: Ref | null; adGroup: Ref | null; counts: RefCounts }
  /** What it changed in 7 days: keywords paused (or turned on), negatives added, and where. */
  changed7d: RefSet & { paused: number; negated: number; counts: RefCounts }
  last7d: { runs: number; asks: number; applied: number; written: number; refused: number; askedByCaps: number }
  waiting: number
  lastRunAt: string | null
  nextRunAt: string | null
  firstRunAt: string | null
  thenRunAt: string | null
  schedule: string
  archived: boolean
}

export interface WasteRulesTotals {
  rules: number
  on: number
  acting: number
  auto: number
  asking: number
  held: number
  waiting: number
  paused7d: number
  negated7d: number
  archived: number
  otherMarkets: number
}

const normMarket = (m: string | null | undefined) => {
  const raw = (m ?? '').trim()
  if (!raw || raw.toLowerCase() === 'all') return null
  return normalizeMarketplaceCode(raw, raw.toUpperCase())
}

const adsLive = () => (process.env.NEXUS_AMAZON_ADS_MODE ?? 'sandbox') === 'live'

async function accountPosture(): Promise<AccountPosture> {
  const { getAutomationState } = await import('../ads-automation-state.service.js')
  const s = await getAutomationState()
  return { autonomy: s.autonomy, halted: s.halted, killed: process.env.NEXUS_ADS_AUTOMATION_KILL === '1', degraded: s.degraded }
}

const RULE_SELECT = {
  id: true, name: true, domain: true, trigger: true, enabled: true, dryRun: true, autonomyLevel: true, conditions: true, actions: true,
  maxExecutionsPerDay: true, maxWritesPerDay: true, maxValueCentsEur: true,
  scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true, scopeAdGroupId: true,
  evaluationCount: true, matchCount: true, lastEvaluatedAt: true, createdAt: true,
} as const

export type WasteRuleRecord = {
  id: string; name: string; domain: string; trigger: string; enabled: boolean; dryRun: boolean; autonomyLevel: string | null; conditions: unknown; actions: unknown
  maxExecutionsPerDay: number | null; maxWritesPerDay: number | null; maxValueCentsEur: number | null
  scopeMarketplace: string | null; scopePortfolioId: string | null; scopeCampaignId: string | null; scopeProductId: string | null; scopeAdGroupId: string | null
  evaluationCount: number; matchCount: number; lastEvaluatedAt: Date | null; createdAt: Date
}

/** The waste rule of this id (an archived one too); null when there is none in this business. */
export async function findWasteRule(id: string): Promise<WasteRuleRecord | null> {
  const r = await prisma.automationRule.findUnique({ where: { id }, select: RULE_SELECT }) as WasteRuleRecord | null
  if (!r || (r.domain !== 'advertising' && r.domain !== ARCHIVED_ADS_DOMAIN) || !wasteKindOf(producedActionTypes(r))) return null
  return r
}

// ── the page's words for what holds a waste rule ────────────────────────────────────────────────────────────────────

export const WASTE_HOLDS = {
  /** D1 — an Auto stop-waste rule acts alone only inside its caps: shown beside its mode, so Auto never reads as unbounded. */
  insideCaps: (kind: StopWasteKind): Hold => ({
    kind: 'cap', label: 'Auto inside caps',
    reason: kind === 'PAUSE_KEYWORD'
      ? `Alone it pauses at most ${STOP_WASTE_CAPS.pausesPerProductPerDay} keywords per product a day; past that, or for a row it must never stop alone, it asks you.`
      : `Alone it adds at most ${STOP_WASTE_CAPS.negativesPerProductPerDay} negatives per product a day; past that, or for a row it must never stop alone, it asks you.`,
  }),
  noProtectedTerms: (): Hold => ({ kind: 'gate', label: 'No protected terms', reason: 'No protected term is set for this market: every negative waits for your yes until your brand terms are protected.' }),
  alwaysAsks: (blockedBy: readonly string[], notPageShape = false): Hold => ({
    kind: 'graduation', label: 'Asks first',
    reason: notPageShape ? NOT_PAGE_SHAPE
      : blockedBy.includes('enable_target') ? 'Turning a keyword back on always waits for your yes.'
      : blockedBy.includes('add_negative_phrase') ? 'A negative phrase blocks every search that contains it, so it always waits for your yes.'
        : 'One of its actions always waits for your yes.',
  }),
  locked: (n: number, names: string[]): Hold => ({
    kind: 'allowlist', label: n === 1 ? '1 campaign read only' : `${n} campaigns read only`,
    reason: `Nexus changes nothing by itself in ${n === 1 ? 'this campaign' : 'these campaigns'}${names.length ? `: ${names.slice(0, 3).join(', ')}${n > 3 ? ` +${n - 3}` : ''}` : ''}. A person's change still goes through.`,
  }),
  allLocked: (names: string[]): Hold => ({
    kind: 'allowlist', label: 'Campaigns read only',
    reason: `Nexus changes nothing by itself in its campaigns${names.length ? `: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}` : ''}. A person's change still goes through.`,
  }),
} as const

/** Rewrite the Bid page's bid words for a waste rule (its holds are about pauses and negatives, not bids). Pure. */
export function wasteMode(m: BidRuleMode, kind: StopWasteKind, extra: { ceilingBlockedBy: string[]; stopWaste: boolean; notPageShape?: boolean; noProtectedTerms: boolean; locked: { n: number; names: string[]; all: boolean } }): BidRuleMode {
  const words = (h: Hold): Hold => {
    if (h.kind === 'graduation' && h.label === 'Always asks') return WASTE_HOLDS.alwaysAsks(extra.ceilingBlockedBy, extra.notPageShape)
    if (h.kind === 'allowlist') return extra.locked.all ? WASTE_HOLDS.allLocked(extra.locked.names) : WASTE_HOLDS.locked(extra.locked.n, extra.locked.names)
    return h
  }
  let out: BidRuleMode = { ...m, heldBy: m.heldBy ? words(m.heldBy) : null, also: m.also.map(words), autoLocked: m.autoLocked ? words(m.autoLocked) : null }
  if (out.acts === 'AUTO' && extra.stopWaste) {
    if (kind === 'NEGATE_TERM' && extra.noProtectedTerms) {
      const h = WASTE_HOLDS.noProtectedTerms()
      out = out.heldBy ? { ...out, acts: 'ASK', also: [...out.also, h] } : { ...out, acts: 'ASK', heldBy: h }
    } else {
      out = { ...out, also: [...out.also, WASTE_HOLDS.insideCaps(kind)] }
    }
  }
  return out
}

// ── the list ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface WriteRow { userId: string | null; entityType: string; entityId: string; actionType: string; amazonResponseStatus: string | null; createdAt: Date; payloadAfter: unknown }
const landed = (w: { amazonResponseStatus: string | null }) => !UNSENT.has(String(w.amazonResponseStatus ?? ''))

/** A rule's live runs of the window: the negatives each landed (from its outcomes), and whether D1's gate made it ask. */
export function negativesOfRun(actionResults: unknown): Array<{ externalTargetId: string | null; adGroupId: string | null; keyword: string | null; level: string | null; matchType: string | null }> {
  const out: Array<{ externalTargetId: string | null; adGroupId: string | null; keyword: string | null; level: string | null; matchType: string | null }> = []
  for (const a of (Array.isArray(actionResults) ? actionResults : []) as Array<{ type?: string; ok?: boolean; output?: Record<string, unknown> }>) {
    if (a.type !== 'add_negative_exact' && a.type !== 'add_negative_phrase') continue
    const o = a.output ?? {}
    if (o.dryRun) continue
    const keyword = typeof o.keyword === 'string' ? o.keyword : null
    if (Array.isArray(o.outcomes)) {
      for (const x of o.outcomes as Array<Record<string, unknown>>) {
        if (x.reachedAmazon !== true) continue
        out.push({ externalTargetId: (x.externalTargetId as string | undefined) ?? null, adGroupId: (x.adGroupId as string | undefined) ?? null, keyword, level: (x.level as string | undefined) ?? null, matchType: (x.matchType as string | undefined) ?? null })
      }
    } else if (a.ok !== false && o.externalTargetId != null && !o.alreadyExisted) {
      out.push({ externalTargetId: String(o.externalTargetId), adGroupId: null, keyword, level: (o.scope as string | undefined) ?? null, matchType: (o.matchType as string | undefined) ?? null })
    }
  }
  return out
}

/** GET /advertising/waste/rules — every waste rule of this business (the pseudo-rows first), in the market asked or every market. */
export async function listWasteRules(q: { market?: string | null; channel?: string | null }, opts: { now?: Date } = {}): Promise<{ channel: 'AMAZON' | 'EBAY'; market: string | null; rules: WasteRuleRow[]; totals: WasteRulesTotals; note: string | null }> {
  const now = opts.now ?? new Date()
  const market = normMarket(q.market)
  const channel = String(q.channel ?? 'AMAZON').toUpperCase() === 'EBAY' ? 'EBAY' as const : 'AMAZON' as const
  const zero: WasteRulesTotals = { rules: 0, on: 0, acting: 0, auto: 0, asking: 0, held: 0, waiting: 0, paused7d: 0, negated7d: 0, archived: 0, otherMarkets: 0 }
  // D5 — eBay's negatives and its keyword pause come to this page in step 4.
  if (channel === 'EBAY') return { channel, market, rules: [], totals: zero, note: 'eBay rules come to this page later (its own engine runs them today).' }
  const weekAgo = new Date(now.getTime() - WEEK_DAYS * DAY)

  const all = (await prisma.automationRule.findMany({
    where: { domain: { in: ['advertising', ARCHIVED_ADS_DOMAIN] } }, select: RULE_SELECT, orderBy: [{ name: 'asc' }],
  }) as WasteRuleRecord[]).map((r) => ({ r, produced: producedActionTypes(r) })).filter((x) => wasteKindOf(x.produced) != null)
  // S13 — a rule's market: its own, else the one market every campaign its scope reaches is in (a rule on one IT campaign is
  // an IT rule, shown only in IT); a whole-account rule, or one whose scope spans markets, shows in every market it reaches.
  const reached = await campaignsReachedBy(all.map((x) => x.r) as unknown as ReachRule[])
  const marketsOf = new Map(all.map(({ r }) => [r.id, new Set((reached.byRule.get(r.id) ?? []).filter((c) => c.status !== 'ARCHIVED').map((c) => normMarket(c.marketplace)).filter((m): m is string => !!m))]))
  const narrow = (r: WasteRuleRecord) => !!(r.scopePortfolioId || r.scopeCampaignId || r.scopeAdGroupId || r.scopeProductId)
  const ruleMarket = (r: WasteRuleRecord) => normMarket(r.scopeMarketplace) ?? (narrow(r) && marketsOf.get(r.id)?.size === 1 ? [...marketsOf.get(r.id)!][0] : null)
  const inMarket = (r: WasteRuleRecord) => !market || (r.scopeMarketplace ? normMarket(r.scopeMarketplace) === market : !narrow(r) || !!marketsOf.get(r.id)?.has(market))
  const rules = all.filter((x) => inMarket(x.r))
  const otherMarkets = all.filter((x) => !inMarket(x.r) && x.r.domain !== ARCHIVED_ADS_DOMAIN).length
  const live = rules.filter((x) => x.r.domain !== ARCHIVED_ADS_DOMAIN)
  const ids = rules.map((x) => x.r.id)

  const [posture, runs, asks, applied, waiting, refusals, writes, protections] = await Promise.all([
    accountPosture(),
    ids.length ? prisma.automationRuleExecution.findMany({
      where: { ruleId: { in: ids }, startedAt: { gte: weekAgo }, ...notCapRefusal() },
      select: { ruleId: true, startedAt: true, dryRun: true, triggerData: true, actionResults: true },
    }) : Promise.resolve([]),
    ids.length ? prisma.adsRuleSuggestion.groupBy({ by: ['ruleId'], where: { ruleId: { in: ids }, createdAt: { gte: weekAgo } }, _count: { _all: true } }) : Promise.resolve([]),
    ids.length ? prisma.adsRuleSuggestion.groupBy({ by: ['ruleId'], where: { ruleId: { in: ids }, status: 'applied', decidedAt: { gte: weekAgo } }, _count: { _all: true } }) : Promise.resolve([]),
    // NFIX — what waits is read from the page's own rows (the tile's): one truth for the tile, each rule and the Brain.
    waitingAsksByAsker({ market }, now),
    (await import('../../automation-refusals.service.js')).refusalCountsByActor(WEEK_DAYS),
    ids.length ? prisma.advertisingActionLog.findMany({
      where: { userId: { in: ids.flatMap(ruleActors) }, createdAt: { gte: weekAgo }, entityType: 'AD_TARGET' },
      select: { userId: true, entityType: true, entityId: true, actionType: true, amazonResponseStatus: true, createdAt: true, payloadAfter: true },
    }) as Promise<WriteRow[]> : Promise.resolve([] as WriteRow[]),
    prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' }, select: { marketplace: true } }),
  ])
  const count = (rows: Array<{ ruleId: string; _count: { _all: number } }>) => new Map(rows.map((r) => [r.ruleId, r._count._all]))
  const asksBy = count(asks as never)
  const appliedBy = count(applied as never)
  const waitingBy = new Map([...waiting].map(([by, asks]) => [by, asks.size]))

  // The live negatives each rule's runs landed this week (the record of a rule's negatives: see the file's note).
  const negs = new Map<string, ReturnType<typeof negativesOfRun>>()
  const runTicks = new Map<string, Set<number>>()
  const askedByCaps = new Map<string, number>()
  for (const run of runs) {
    const ticks = runTicks.get(run.ruleId) ?? new Set<number>()
    ticks.add(Math.floor(run.startedAt.getTime() / (15 * 60_000)))
    runTicks.set(run.ruleId, ticks)
    if ((run.triggerData as { stopWaste?: { asks?: unknown } } | null)?.stopWaste?.asks) askedByCaps.set(run.ruleId, (askedByCaps.get(run.ruleId) ?? 0) + 1)
    if (!run.dryRun) negs.set(run.ruleId, [...(negs.get(run.ruleId) ?? []), ...negativesOfRun(run.actionResults)])
  }
  const reachOf = new Map<string, string[]>()
  for (const { r } of rules) {
    reachOf.set(r.id, (reached.byRule.get(r.id) ?? []).filter((c) => c.status !== 'ARCHIVED' && (!market || normMarket(c.marketplace) === market)).map((c) => c.id))
  }
  const book = new RefBook()
  await book.load({
    campaigns: [...reachOf.values()].flat(),
    targets: writes.map((w) => w.entityId),
    adGroups: [...rules.map((x) => x.r.scopeAdGroupId ?? ''), ...[...negs.values()].flat().map((n) => n.adGroupId ?? '')],
    portfolios: rules.map((x) => x.r.scopePortfolioId ?? ''),
  })
  const liveMarkets = await writableMarkets([...book.campaigns.values()].map((c) => c.marketplace))
  const gates = await autoGates(live.map((x) => x.r).filter((r) => resolveAutonomy(r) !== 'AUTO'), now)
  const protectedIn = (m: string | null) => protections.some((p) => p.marketplace == null || (m != null && p.marketplace === m))

  const rows: WasteRuleRow[] = rules.map(({ r, produced }) => {
    const archived = r.domain === ARCHIVED_ADS_DOMAIN
    const kind = wasteKindOf(produced)!
    const level = resolveAutonomy(r) as AutonomyLevel
    const reach = reachOf.get(r.id) ?? []
    const ceiling = graduationCeiling({ actionTypes: produced, hasKeywordProtections: false, actions: r.actions })
    // What the write gate does with an automatic pause or negative: a market without Amazon's limits refuses every write;
    // a campaign off the live-change list, or an account that takes no changes, refuses an automatic one.
    const split: CampaignSplit = { total: reach.length, open: 0, locked: 0, market: 0, brain: 0, brainStopped: 0, names: { locked: [], market: [] } }
    for (const id of reach) {
      const c = book.campaigns.get(id)
      const part = !c?.marketplace || !marketLimitsOf(c.marketplace) ? 'market' : !c.liveBidWritesEnabled || !liveMarkets.has(c.marketplace) ? 'locked' : 'open'
      split[part]++
      if (part !== 'open') split.names![part]!.push(c?.name ?? id)
    }
    const myWrites = writes.filter((w) => ruleActors(r.id).includes(String(w.userId)))
    const myNegs = negs.get(r.id) ?? []
    const mode = wasteMode(ruleMode({
      level, archived, account: posture, adsLive: adsLive(), ceiling: ceiling.maxLevel, ceilingBlockedBy: ceiling.blockedBy,
      manualBelt: (Array.isArray(r.actions) ? (r.actions[0] as { control?: unknown } | undefined) : undefined)?.control === 'manual',
      matchesCapHit: false, writeCapHit: false, valueCapZero: r.maxValueCentsEur === 0,
      caps: { matchesPerDay: r.maxExecutionsPerDay, writesPerDay: r.maxWritesPerDay },
      campaigns: split, autoGate: gates.get(r.id) ?? null,
    }), kind, {
      ceilingBlockedBy: ceiling.blockedBy, stopWaste: stopWasteShapeOf(r.actions) != null,
      notPageShape: stopWasteKindOf(produced) != null && stopWasteShapeOf(r.actions) == null,
      noProtectedTerms: !protectedIn(normMarket(r.scopeMarketplace) ?? market),
      locked: { n: split.locked, names: split.names?.locked ?? [], all: split.open === 0 },
    })
    const schedule = ruleStoredSchedule(r.actions)
    const runsAt = modeActs(mode) ? ruleRunTimes(schedule, r.lastEvaluatedAt, now) : { nextRunAt: null, firstRunAt: null, thenRunAt: null }
    const pausedTargets = new Set(myWrites.filter((w) => landed(w) && (w.payloadAfter as { status?: unknown } | null)?.status === 'PAUSED').map((w) => w.entityId))
    const touchedGroups = new Set([...[...pausedTargets].map((t) => book.targets.get(t)?.adGroupId ?? ''), ...myNegs.map((n) => n.adGroupId ?? '')].filter(Boolean))
    const touchedCampaigns = new Set([...touchedGroups].map((g) => book.campaignOfAdGroup(g) ?? '').filter(Boolean))
    const changed = book.refSet(touchedCampaigns, touchedGroups)
    const picks = r.scopeCampaignId || r.scopePortfolioId || r.scopeProductId || r.scopeAdGroupId
    const scope = book.refSet(reach, r.scopeAdGroupId ? [r.scopeAdGroupId] : [])
    const byReason = refusals.get(r.id)?.byReason ?? {}
    return {
      id: r.id, kind, source: 'rule' as const, readOnly: false, name: r.name,
      sentence: wasteSentence(r, ruleSentence),
      market: ruleMarket(r), mode, test: stopWasteParamsOf(r.actions),
      scope: {
        ...scope, all: !picks,
        product: r.scopeProductId ? { id: r.scopeProductId, name: r.scopeProductId, href: `/products/${encodeURIComponent(r.scopeProductId)}` } : null,
        adGroup: r.scopeAdGroupId ? book.adGroupRef(r.scopeAdGroupId) ?? { id: r.scopeAdGroupId, name: r.scopeAdGroupId } : null,
      },
      changed7d: { ...changed, paused: pausedTargets.size, negated: myNegs.length },
      last7d: {
        runs: runTicks.get(r.id)?.size ?? 0, asks: asksBy.get(r.id) ?? 0, applied: appliedBy.get(r.id) ?? 0,
        written: myWrites.filter(landed).length + myNegs.length,
        refused: (byReason.DAILY_CAP_EXCEEDED ?? 0) + (byReason.VALUE_CAP_EXCEEDED ?? 0) + myWrites.filter((w) => !landed(w)).length,
        askedByCaps: askedByCaps.get(r.id) ?? 0,
      },
      waiting: archived ? 0 : waitingBy.get(r.id) ?? 0,
      lastRunAt: r.lastEvaluatedAt?.toISOString() ?? null,
      nextRunAt: runsAt.nextRunAt?.toISOString() ?? null,
      firstRunAt: runsAt.firstRunAt?.toISOString() ?? null,
      thenRunAt: runsAt.thenRunAt?.toISOString() ?? null,
      schedule: scheduleWords(schedule),
      archived,
    }
  })
  const productIds = [...new Set(rows.map((r) => r.scope.product?.id).filter((x): x is string => !!x))]
  if (productIds.length) {
    const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true, name: true } })
    const named = new Map(products.map((p) => [p.id, p.sku || p.name || p.id]))
    for (const row of rows) if (row.scope.product) row.scope.product.name = named.get(row.scope.product.id) ?? row.scope.product.id
  }

  const pseudo = await pseudoRows({ market, now, book, brainWaiting: waitingBy.get(BRAIN_ROW_ID) ?? 0 })
  const active = rows.filter((r) => !r.archived)
  const totals: WasteRulesTotals = {
    rules: active.length,
    on: active.filter((r) => r.mode.set !== 'OFF').length,
    acting: active.filter((r) => modeActs(r.mode)).length,
    auto: active.filter((r) => r.mode.acts === 'AUTO').length,
    asking: active.filter((r) => r.mode.acts === 'ASK').length,
    held: active.filter((r) => r.mode.heldBy != null).length,
    waiting: active.reduce((n, r) => n + r.waiting, 0),
    paused7d: active.reduce((n, r) => n + r.changed7d.paused, 0),
    negated7d: active.reduce((n, r) => n + r.changed7d.negated, 0) + pseudo.reduce((n, r) => n + r.changed7d.negated, 0),
    archived: rows.length - active.length,
    otherMarkets,
  }
  const order = (r: WasteRuleRow) => (r.archived ? 2 : r.mode.set === 'OFF' ? 1 : 0)
  return { channel, market, rules: [...pseudo, ...rows.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))], totals, note: null }
}

/** Why Auto cannot be picked, for the rules not on Auto: the ceiling and the gate's evidence first (no query), then the dial. */
async function autoGates(rules: readonly WasteRuleRecord[], now: Date): Promise<Map<string, Hold | null>> {
  const out = new Map<string, Hold | null>()
  if (!rules.length) return out
  const { adsRuleLevelRefusal, GRADUATION_GATE } = await import('../ads-rule-crud.service.js')
  const { isRefused } = await import('../../automation/service-outcome.js')
  await Promise.all(rules.map(async (r) => {
    const ceiling = graduationCeiling({ actionTypes: producedActionTypes(r), hasKeywordProtections: false, actions: r.actions })
    const age = Math.floor((now.getTime() - r.createdAt.getTime()) / DAY)
    let refusal: { error?: unknown; failures?: unknown; blockedBy?: unknown } | null = ceiling.maxLevel !== 'AUTO' ? { error: 'above_ceiling', blockedBy: ceiling.blockedBy }
      : !r.enabled ? { error: 'gate_not_open', failures: ['RULE_ENABLED'] }
        : age < GRADUATION_GATE.observationDays ? { error: 'gate_not_open', failures: ['OBSERVATION_WINDOW'] }
          : r.evaluationCount < GRADUATION_GATE.evaluations ? { error: 'gate_not_open', failures: ['HAS_EVALUATIONS'] }
            : r.matchCount < GRADUATION_GATE.matches ? { error: 'gate_not_open', failures: ['HAS_MATCHES'] }
              : null
    if (!refusal) {
      const asked = await adsRuleLevelRefusal(r.id, 'AUTO')
      refusal = isRefused(asked) ? asked.body as typeof refusal : null
    }
    const hold = autoGateHold(refusal, r.createdAt, { observationDays: GRADUATION_GATE.observationDays, evaluations: { have: r.evaluationCount, need: GRADUATION_GATE.evaluations } })
    const notShaped = stopWasteKindOf(producedActionTypes(r)) != null && stopWasteShapeOf(r.actions) == null
    out.set(r.id, hold && hold.label === 'Always asks' ? WASTE_HOLDS.alwaysAsks(ceiling.blockedBy, notShaped) : hold)
  }))
  return out
}

// ── the pseudo-rows ─────────────────────────────────────────────────────────────────────────────────────────────────

const RANK: Record<BidMode, number> = { OFF: 0, WATCH: 1, ASK: 2, AUTO: 3 }
const MODE_OF: Record<string, BidMode> = { OBSERVE: 'WATCH', PROPOSE: 'ASK', AUTO: 'AUTO' }
const highest = (modes: Iterable<string | null | undefined>): BidMode => {
  let best: BidMode = 'OFF'
  for (const m of modes) { const b = MODE_OF[String(m ?? '')]; if (b && RANK[b] > RANK[best]) best = b }
  return best
}
const plainMode = (m: BidMode): BidRuleMode => ({ set: m, acts: m, heldBy: null, also: [], autoLocked: null })

async function pseudoRows(a: { market: string | null; now: Date; book: RefBook; brainWaiting: number }): Promise<WasteRuleRow[]> {
  const weekAgo = new Date(a.now.getTime() - WEEK_DAYS * DAY)
  const marketWhere = a.market ? { marketplace: a.market } : {}
  const [negLatest, negWeek, hvLatest, hvWeek, hvWaiting] = await Promise.all([
    prisma.adsBrainNegative.findFirst({ where: marketWhere, orderBy: { checkedAt: 'desc' }, select: { runId: true, checkedAt: true } }),
    prisma.adsBrainNegative.findMany({ where: { ...marketWhere, checkedAt: { gte: weekAgo } }, select: { runId: true, status: true, action: true, campaignId: true, adGroupId: true, actedAt: true } }),
    prisma.adsBrainHarvest.findFirst({ where: marketWhere, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    prisma.adsBrainHarvest.findMany({ where: { ...marketWhere, updatedAt: { gte: weekAgo } }, select: { status: true, level: true, sources: true, destCampaignId: true } }),
    // NFIX — harvests that still wait for a person: asked, and their request still open (not decided, not expired).
    prisma.adsBrainHarvest.findMany({ where: { ...marketWhere, status: { in: ['PROPOSED', 'CAMPAIGN_PROPOSED'] }, approvalId: { not: null } }, select: { approvalId: true } })
      .then(async (rows) => {
        const ids = [...new Set(rows.map((r) => r.approvalId!))]
        if (!ids.length) return 0
        const open = new Set((await prisma.agentApproval.findMany({ where: { id: { in: ids }, status: 'pending', OR: [{ expiresAt: null }, { expiresAt: { gt: a.now } }] }, select: { id: true } })).map((x) => x.id))
        return rows.filter((r) => open.has(r.approvalId!)).length
      }),
  ])
  const newestRun = negLatest ? await prisma.adsBrainNegative.findMany({ where: { ...marketWhere, runId: negLatest.runId }, select: { mode: true } }) : []
  const written = negWeek.filter((n) => n.status === 'WRITTEN' && n.action === 'ADD' && n.actedAt && n.actedAt >= weekAgo)
  await a.book.load({ campaigns: [...written.map((n) => n.campaignId), ...hvWeek.map((h) => h.destCampaignId ?? '')], adGroups: written.map((n) => n.adGroupId ?? '') })
  const brainChanged = a.book.refSet(written.map((n) => n.campaignId), written.map((n) => n.adGroupId ?? ''))
  const brainMode = highest(newestRun.map((r) => r.mode))
  const brain: WasteRuleRow = {
    id: BRAIN_ROW_ID, kind: 'NEGATE_TERM', source: 'brain', readOnly: true, name: 'Brain (negatives)',
    sentence: 'The Brain\'s negatives for its products — kept by the Brain',
    market: a.market, mode: plainMode(brainMode), test: null,
    scope: { ...a.book.refSet(new Set(negWeek.map((n) => n.campaignId))), all: false, product: null, adGroup: null },
    changed7d: { ...brainChanged, paused: 0, negated: written.length },
    last7d: {
      runs: new Set(negWeek.map((n) => n.runId)).size, asks: negWeek.filter((n) => n.status === 'PROPOSED').length, applied: 0,
      written: written.length, refused: negWeek.filter((n) => n.status === 'REFUSED' || n.status === 'FAILED').length, askedByCaps: 0,
    },
    // NFIX — the Brain's asks waiting on this page (approvals still open, each listed in its Waiting tab), not its log's
    // PROPOSED rows (one change plan holds many; an expired or decided plan left them PROPOSED until the next run).
    waiting: a.brainWaiting, lastRunAt: negLatest?.checkedAt.toISOString() ?? null, nextRunAt: null, firstRunAt: null, thenRunAt: null,
    schedule: 'Every day', archived: false,
  }
  const landedSources = (s: unknown) => (Array.isArray(s) ? s as Array<{ action?: unknown; result?: unknown }> : []).filter((x) => x.action === 'negate' && x.result === 'landed').length
  const hvNegated = hvWeek.reduce((n, h) => n + landedSources(h.sources), 0)
  const harvest: WasteRuleRow = {
    id: HARVEST_ROW_ID, kind: 'NEGATE_TERM', source: 'harvest', readOnly: true, name: 'Harvest (source negatives)',
    sentence: 'When a search term becomes a keyword, its source gets a negative exact — Harvest owns it',
    market: a.market, mode: plainMode(highest(hvWeek.map((h) => h.level))), test: null,
    scope: { ...a.book.refSet(new Set(hvWeek.map((h) => h.destCampaignId ?? '').filter(Boolean))), all: false, product: null, adGroup: null },
    changed7d: { portfolios: [], campaigns: [], adGroups: [], counts: { portfolios: 0, campaigns: 0, adGroups: 0 }, paused: 0, negated: hvNegated },
    last7d: { runs: 0, asks: hvWeek.filter((h) => h.status === 'PROPOSED').length, applied: 0, written: hvNegated, refused: hvWeek.filter((h) => h.status === 'REFUSED' || h.status === 'FAILED').length, askedByCaps: 0 },
    // NFIX — decided on the Keyword Harvest page (this page links there with the count: harvestWaitingHref, web).
    waiting: hvWaiting, lastRunAt: hvLatest?.updatedAt.toISOString() ?? null, nextRunAt: null, firstRunAt: null, thenRunAt: null,
    schedule: 'With each harvest', archived: false,
  }
  return [brain, harvest]
}

// ── history ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WasteRuleChange {
  id: string
  at: string
  action: 'paused' | 'turned_on' | 'negated' | 'removed'
  /** The keyword paused, or the negative added (its text). */
  target: Ref | null
  adGroup: Ref | null
  campaign: Ref | null
  portfolio: Ref | null
  /** Negatives: exact / phrase / product, at the ad group or the campaign. */
  match: string | null
  level: string | null
  from: string | null
  to: string | null
  who: { kind: 'rule' | 'brain' | 'harvest' | 'person'; id: string | null; name: string }
  delivery: string | null
  /** The id POST /advertising/changes/:id/undo takes; null when there is none (`undoBlocked` says why). */
  changeId: string | null
  undoBlocked: string | null
}

export type WasteHistoryAnswer = { data: { id: string; name: string; days: number; changes: WasteRuleChange[] } } | { error: string; status: 404 | 400 }

/** GET /advertising/waste/rules/:id/history — a rule's (or a pseudo-row's) changes over `days`, newest first. */
export async function wasteRuleHistory(id: string, q: { days?: number; market?: string | null; limit?: number }, opts: { now?: Date } = {}): Promise<WasteHistoryAnswer> {
  const now = opts.now ?? new Date()
  const days = Math.min(90, Math.max(1, Math.round(q.days ?? WEEK_DAYS)))
  const limit = Math.min(500, Math.max(1, Math.round(q.limit ?? 200)))
  const market = normMarket(q.market)
  const since = new Date(now.getTime() - days * DAY)
  const book = new RefBook()
  const changes: WasteRuleChange[] = []
  const inMarket = (campaignId: string | null) => !market || (!!campaignId && book.campaigns.get(campaignId)?.marketplace === market)
  const portfolioOf = (campaignId: string | null) => { const p = campaignId ? book.campaigns.get(campaignId)?.portfolioId : null; return p ? book.portfolioRef(p) : null }

  if (id === BRAIN_ROW_ID || id === HARVEST_ROW_ID) {
    if (id === BRAIN_ROW_ID) {
      const rows = await prisma.adsBrainNegative.findMany({
        where: { action: 'ADD', status: 'WRITTEN', actedAt: { gte: since }, ...(market ? { marketplace: market } : {}) },
        orderBy: { actedAt: 'desc' }, take: limit,
        select: { id: true, actedAt: true, text: true, match: true, level: true, campaignId: true, adGroupId: true, adTargetId: true },
      })
      await book.load({ campaigns: rows.map((r) => r.campaignId), adGroups: rows.map((r) => r.adGroupId ?? '') })
      for (const r of rows) {
        changes.push({
          id: r.id, at: (r.actedAt ?? now).toISOString(), action: 'negated', target: { id: r.adTargetId ?? r.id, name: r.text },
          adGroup: r.adGroupId ? book.adGroupRef(r.adGroupId) : null, campaign: book.campaignRef(r.campaignId), portfolio: portfolioOf(r.campaignId),
          match: r.match, level: r.level, from: null, to: null, who: { kind: 'brain', id: BRAIN_ROW_ID, name: 'Brain' },
          delivery: 'SENT', changeId: null, undoBlocked: 'The Brain keeps this negative.',
        })
      }
      return { data: { id, name: 'Brain (negatives)', days, changes } }
    }
    const rows = await prisma.adsBrainHarvest.findMany({
      where: { updatedAt: { gte: since }, status: { in: ['DONE', 'HALF_DONE'] }, ...(market ? { marketplace: market } : {}) },
      orderBy: { updatedAt: 'desc' }, take: limit, select: { id: true, updatedAt: true, term: true, sources: true },
    })
    const srcs = rows.flatMap((r) => (Array.isArray(r.sources) ? r.sources as Array<{ adGroupId?: string; campaignId?: string; action?: string; result?: string; negativeTargetId?: string }> : [])
      .filter((s) => s.action === 'negate' && s.result === 'landed').map((s) => ({ r, s })))
    await book.load({ campaigns: srcs.map((x) => x.s.campaignId ?? ''), adGroups: srcs.map((x) => x.s.adGroupId ?? '') })
    for (const { r, s } of srcs) {
      changes.push({
        id: `${r.id}:${s.adGroupId ?? ''}`, at: r.updatedAt.toISOString(), action: 'negated', target: { id: s.negativeTargetId ?? r.id, name: r.term },
        adGroup: s.adGroupId ? book.adGroupRef(s.adGroupId) : null, campaign: s.campaignId ? book.campaignRef(s.campaignId) : null, portfolio: portfolioOf(s.campaignId ?? null),
        match: 'EXACT', level: 'AD_GROUP', from: null, to: null, who: { kind: 'harvest', id: HARVEST_ROW_ID, name: 'Harvest' },
        delivery: 'SENT', changeId: null, undoBlocked: 'Harvest owns this negative: undo the harvest on its page.',
      })
    }
    return { data: { id, name: 'Harvest (source negatives)', days, changes: changes.slice(0, limit) } }
  }

  const rule = await findWasteRule(id)
  if (!rule) return { error: `No waste rule ${id} in this business.`, status: 404 }
  // Pauses and turn-ons: the rule's own state writes (its actor), each the id the undo route takes while it may be undone.
  const { rollbackWindowMsFor } = await import('../rollback.service.js')
  const states = await prisma.advertisingActionLog.findMany({
    where: { userId: { in: ruleActors(id) }, entityType: 'AD_TARGET', actionType: 'AD_ENTITY_STATE_UPDATE', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' }, take: 500,
    select: { id: true, createdAt: true, entityId: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true, rolledBackAt: true },
  })
  // Negatives: the rule's own live runs (a rule's negative is mirrored with no actor; its run is the record).
  const runs = await prisma.automationRuleExecution.findMany({
    where: { ruleId: id, startedAt: { gte: since }, dryRun: false }, orderBy: { startedAt: 'desc' }, take: 500,
    select: { id: true, startedAt: true, triggerData: true, actionResults: true },
  })
  const negs = runs.flatMap((run) => negativesOfRun(run.actionResults).map((n) => ({ run, n })))
  const negRows = negs.length ? await prisma.adTarget.findMany({
    where: { isNegative: true, externalTargetId: { in: negs.map((x) => x.n.externalTargetId).filter((v): v is string => !!v) } },
    select: { id: true, externalTargetId: true, expressionValue: true, expressionType: true, adGroupId: true, negativeLevel: true, status: true },
  }) : []
  const negByExt = new Map(negRows.map((t) => [t.externalTargetId as string, t]))
  const creates = negRows.length ? await prisma.advertisingActionLog.findMany({
    where: { entityId: { in: negRows.map((t) => t.id) }, actionType: { in: ['create_negative_keyword', 'create_negative_product_target'] } },
    select: { id: true, entityId: true },
  }) : []
  const createOf = new Map(creates.map((c) => [c.entityId, c.id]))
  await book.load({
    targets: states.map((r) => r.entityId),
    adGroups: [...negs.map((x) => x.n.adGroupId ?? ''), ...negRows.map((t) => t.adGroupId)],
  })
  for (const r of states) {
    const g = book.targets.get(r.entityId)?.adGroupId ?? null
    const campaignId = g ? book.campaignOfAdGroup(g) : null
    if (!inMarket(campaignId)) continue
    const from = (r.payloadBefore as { status?: unknown } | null)?.status
    const to = (r.payloadAfter as { status?: unknown } | null)?.status
    const sent = !UNSENT.has(String(r.amazonResponseStatus ?? ''))
    const undoBlocked = r.rolledBackAt ? 'Already undone.' : !sent ? 'It never reached Amazon: nothing to undo.'
      : now.getTime() - r.createdAt.getTime() >= rollbackWindowMsFor('AD_ENTITY_STATE_UPDATE') ? 'Past the undo window: turn it on (or pause it) again by hand.' : null
    changes.push({
      id: r.id, at: r.createdAt.toISOString(), action: to === 'ENABLED' ? 'turned_on' : 'paused',
      target: book.targetRef(r.entityId), adGroup: g ? book.adGroupRef(g) : null, campaign: campaignId ? book.campaignRef(campaignId) : null, portfolio: portfolioOf(campaignId),
      match: null, level: null, from: typeof from === 'string' ? from : null, to: typeof to === 'string' ? to : null, who: { kind: 'rule', id, name: rule.name },
      delivery: r.amazonResponseStatus, changeId: undoBlocked ? null : r.id, undoBlocked,
    })
  }
  for (const { run, n } of negs) {
    const row = n.externalTargetId ? negByExt.get(n.externalTargetId) : undefined
    const g = row?.adGroupId ?? n.adGroupId
    const campaignId = g ? book.campaignOfAdGroup(g) : null
    if (!inMarket(campaignId)) continue
    const changeId = row ? createOf.get(row.id) ?? null : null
    changes.push({
      id: `${run.id}:${n.externalTargetId ?? n.keyword ?? ''}`, at: run.startedAt.toISOString(), action: row?.status === 'ARCHIVED' ? 'removed' : 'negated',
      target: { id: row?.id ?? n.externalTargetId ?? run.id, name: row?.expressionValue ?? n.keyword ?? '' },
      adGroup: g ? book.adGroupRef(g) : null, campaign: campaignId ? book.campaignRef(campaignId) : null, portfolio: portfolioOf(campaignId),
      match: row?.expressionType ?? n.matchType, level: row?.negativeLevel ?? n.level, from: null, to: null, who: { kind: 'rule', id, name: rule.name },
      delivery: row ? 'LIVE' : 'SENT', changeId,
      undoBlocked: changeId ? null : row ? 'Nexus has no create record for this negative to undo.' : 'Nexus has not read this negative back from Amazon yet.',
    })
  }
  changes.sort((a, b) => b.at.localeCompare(a.at))
  return { data: { id, name: rule.name, days, changes: changes.slice(0, limit) } }
}

export { MODE_OF_LEVEL }
