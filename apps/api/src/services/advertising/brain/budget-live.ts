/**
 * ONE BRAIN AB-8 — the money writer (design 2026-10-08-ads-one-brain/DESIGN.md §2.5, §2.6, §3, §5, §8 row AB-8, §10 N1):
 * what one product's money plan (brain/budget-plan.ts) does at Amazon, lever by lever, by the level the Owner set.
 *
 *   OBSERVE   shadow only: the plan is logged (AB-7), nothing is asked or written (this module is not called)
 *   PROPOSE   the day's base moves of the campaigns, and the portfolio caps, as requests a person approves in Nexus
 *             (set-campaign-budget's list form, set-portfolio), through the normal approval gate as auto-undo asks
 *             (runOrQueueTool, forceAsk): one request per product a budget day, one per cap amount a month — never asked
 *             twice, whatever became of it. An approved request runs as the person who approved it. The intraday
 *             ladder is never proposed: an approval would come too late in the day.
 *   AUTO      written as the brain: each campaign's budget through the one path every budget takes
 *             (updateCampaignWithSync with askGate: the gate before Nexus's copy, the 5-minute queue, the gate again at
 *             dispatch, then the channel gateway), as MONEY_BUDGETS_ACTOR; the portfolio cap through the Portfolios
 *             page's own push (updatePortfolioById: the gate, then the gateway), as MONEY_PORTFOLIO_ACTOR. Each write
 *             carries its evidence (run, layer, data day, the one-line why) so auto-undo can judge it later (AB-15).
 *
 *   ceiling   only under a live server switch (NEXUS_BID_BRAIN_MODE, bid-brain/live.ts brainLiveCeiling): the brain owns a
 *             lever only then (§3 point 3), and the gate refuses the money actors on any lever the brain does not own.
 *   per lever a campaign's own level decides its budget (a campaign override beats the product's); the product's
 *             portfolioCap level decides its caps. Owner overrides win: a lock or an exclusion is a hold in the plan (no
 *             write), his own min / max budget and cap amount bound the plan, and the gate refuses the brain on his lock.
 *   campaigns one base move a budget day (the day's first plan decides it; brain/budget-campaigns.ts), then the ladder's
 *             rungs on top, each written once; a budget another writer moved today (a person, a safety owner, an undo) is
 *             left until the next budget day; a shared campaign is never written (D2: the brain proposes a split first);
 *             Amazon's own budget rule on a campaign holds it (§2.12: two brains on one lever). A rung the gate would
 *             refuse is never asked, and none goes on a base that did not land.
 *   caps      monthly recurring (N1), only where the plan says `set`: never a cap below this month's spend in the
 *             portfolio (it would stop every campaign at once — the pace brakes act first), never a cap removed or its
 *             kind changed, never raised above a cap someone else set (the Owner's cap stands: the brain may only
 *             lower it), unless the Owner's own amount (portfolioCapCents) is what the plan applies.
 *   brakes    the account dial and the brain's own engine caps (ads-engine-actors.ts `brain-money`), asked once per
 *             campaign before its first write (never split); under SUGGEST nothing new is written and only an earlier
 *             day's ladder is given back (a restore, as the bid brain's give-backs).
 *   once      a rerun writes nothing: a budget already as planned is not asked (and the mutation layer queues no
 *             unchanged value), a base move or rung the brain asked today is not asked again, a cap already as planned
 *             is `keep` in the plan, a request already asked is not asked again.
 */
import type { AdWriteEvidence } from '../ads-evidence.js'
import { allowChange, nothingHeld, type ChangeKind, type EngineGuard } from '../ads-engine-guard.js'
import type { AdsActor } from '../ads-mutation.service.js'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { money } from './budget-envelope.js'
import { BASE_LAYER, CAP_LAYER, LADDER_LAYER, MONEY_BUDGETS_ACTOR, MONEY_PORTFOLIO_ACTOR, type CampaignTodayFacts } from './budget-ladder.js'
import type { CampaignMoneyFacts } from './budget-campaigns.js'
import type { ProductMoneyFacts, ProductMoneyPlan } from './budget-plan.js'

/** The approvals' agent run key: one per money request (its entityId the request's key, so it is asked once). */
export const MONEY_AGENT_KEY = 'ads-brain-money'
const ASK_PRINCIPAL = 'Nexus ads brain'
const WAITING = new Set(['pending', 'scheduled', 'executing'])

export type MoneyMode = 'SHADOW' | 'PROPOSE' | 'LIVE'

/** One campaign's step this run (pure: moneyStepsOf). */
export type CampaignStep =
  | { campaignId: string; name: string; level: string; do: 'write'; layer: typeof BASE_LAYER | typeof LADDER_LAYER; fromCents: number; toCents: number; kind: ChangeKind; restoreCents?: number; why: string }
  | { campaignId: string; name: string; level: string; do: 'ask'; fromCents: number; toCents: number; why: string }
  | { campaignId: string; name: string; level: string; do: 'hold'; why: string }

/** One portfolio's step this run (pure: moneyStepsOf). */
export type CapStep =
  | { portfolioId: string; name: string | null; level: string; do: 'write' | 'ask'; fromCents: number | null; toCents: number; why: string }
  | { portfolioId: string | null; name: string | null; level: string; do: 'hold'; why: string }

/** What became of one campaign step. */
export interface CampaignAction {
  campaignId: string
  name: string
  level: string
  layer: string | null
  fromCents: number | null
  toCents: number | null
  sent: 'queued' | 'unchanged' | 'refused' | 'deferred' | 'would-apply' | 'waiting' | 'asked' | 'held'
  why: string
  reason?: string
  actionLogId?: string | null
}

/** What became of one portfolio step. */
export interface CapAction {
  portfolioId: string | null
  name: string | null
  level: string
  fromCents: number | null
  toCents: number | null
  sent: 'written' | 'refused' | 'deferred' | 'would-apply' | 'waiting' | 'asked' | 'held'
  why: string
  reason?: string
}

/** A request the brain asked a person for (PROPOSE), or found already asked. */
export interface MoneyProposal { kind: 'budgets' | 'portfolioCap'; key: string; approvalId: string | null; status: string; fresh: boolean; why: string }

/** What the money writer did with one product's plan; it rides on the logged plan (outside its fingerprint). */
export interface MoneyActions {
  mode: MoneyMode
  why: string
  campaigns: CampaignAction[]
  portfolios: CapAction[]
  proposals: MoneyProposal[]
  counts: { queued: number; written: number; asked: number; held: number; refused: number; deferred: number; wouldApply: number }
}

const isOwnedLevel = (l: string) => l === 'AUTO' || l === 'PROPOSE'

/** A money lever of the product (its own, or one campaign's budgets) is PROPOSE or AUTO: the writer has something to say. Pure. */
export function moneyLeversOwned(f: Pick<ProductMoneyFacts, 'settings' | 'campaigns'>): boolean {
  return [f.settings.levers.budgets.effective, f.settings.levers.portfolioCap.effective, ...f.campaigns.map((c) => c.budgets.effective)].some((l) => isOwnedLevel(String(l)))
}

/**
 * The product's mode for this run: LIVE when a money lever (the product's, or one campaign's budgets) is AUTO under a live
 * switch, PROPOSE when one is PROPOSE there, else SHADOW. Pure.
 */
export function moneyModeOf(f: Pick<ProductMoneyFacts, 'settings' | 'campaigns'>, live: boolean): MoneyMode {
  if (!live) return 'SHADOW'
  const levels = [f.settings.levers.budgets.effective, f.settings.levers.portfolioCap.effective, ...f.campaigns.map((c) => c.budgets.effective)]
  if (levels.includes('AUTO')) return 'LIVE'
  if (levels.includes('PROPOSE')) return 'PROPOSE'
  return 'SHADOW'
}

const NOT_LIVE = 'the server switch NEXUS_BID_BRAIN_MODE is not live: the brain owns no lever, so it only plans (shadow)'

/**
 * Each campaign's and each portfolio's step this run, from the plan and its facts. `native`: per campaign, the lines of
 * Amazon's own budget rules acting on it (brain/native-rules.ts nativeRuleLines). Pure.
 */
export function moneyStepsOf(plan: ProductMoneyPlan, facts: Pick<ProductMoneyFacts, 'campaigns' | 'today' | 'currency'>, ctx: { live: boolean; native?: ReadonlyMap<string, readonly string[]> }): { campaigns: CampaignStep[]; portfolios: CapStep[] } {
  const w = (c: number) => money(c, facts.currency)
  const byId = new Map(facts.campaigns.map((c) => [c.campaignId, c]))
  const campaigns: CampaignStep[] = []
  for (const c of plan.campaigns) {
    const f: CampaignMoneyFacts | undefined = byId.get(c.campaignId)
    if (!f) continue
    const baseMove = c.action === 'raise' || c.action === 'lower'
    const ladder = c.ladder
    if (!baseMove && !ladder) continue
    const level = String(f.budgets.effective)
    const head = { campaignId: c.campaignId, name: c.name, level }
    const hold = (why: string) => campaigns.push({ ...head, do: 'hold', why })
    if (c.owner !== 'product') { hold('a shared campaign: no product\'s brain owns its budget (D2 — the brain proposes a split first); not written'); continue }
    if (!isOwnedLevel(level)) { hold(`${level}: the brain plans it in shadow, writes nothing`); continue }
    if (!ctx.live) { hold(NOT_LIVE); continue }
    const t: CampaignTodayFacts = facts.today?.[c.campaignId] ?? { baseAsked: false, ladderAskedCents: null, others: [] }
    if (t.others.length) { hold(`another writer moved this budget today (${t.others.join(', ')}): the brain leaves it until the next budget day`); continue }
    const rules = ctx.native?.get(c.campaignId) ?? []
    if (rules.length) { hold(`Amazon's own rule acts on its budget (${rules.slice(0, 2).join('; ')}): two brains on one lever — not written (design §2.12)`); continue }

    let baseWritten = false
    if (baseMove) {
      if (t.baseAsked) hold('the day\'s base move was asked already today: one base move a day')
      else if (level === 'PROPOSE') campaigns.push({ ...head, do: 'ask', fromCents: c.todayCents, toCents: c.stepCents, why: c.why })
      else {
        // An earlier day's ladder still under the budget: going back to its base is a give-back (a restore) on its own.
        const owed = f.ladderNow?.fromDay === 'before' && c.stepCents <= c.todayCents ? f.ladderNow.baseCents : null
        const kind: ChangeKind = owed != null && c.stepCents === owed ? 'restore' : 'forward'
        campaigns.push({ ...head, do: 'write', layer: BASE_LAYER, fromCents: c.todayCents, toCents: c.stepCents, kind, ...(owed != null && kind === 'forward' ? { restoreCents: owed } : {}), why: c.why })
        baseWritten = true
      }
    }
    if (ladder) {
      if (level === 'PROPOSE') { hold('the intraday ladder runs only at AUTO: a person\'s approval would come too late in the day'); continue }
      if (!ladder.allowed) { hold(`the rung +${ladder.pct} % is not written: ${ladder.why}`); continue }
      const baseNow = f.ladderNow?.fromDay === 'today' ? f.ladderNow.baseCents : c.todayCents
      if (!baseWritten && baseNow !== c.stepCents) { hold(`the day's base ${w(c.stepCents)} has not landed (the budget's base is ${w(baseNow)}): no rung on it`); continue }
      const to = c.stepCents + ladder.cents
      if (t.ladderAskedCents != null && to <= t.ladderAskedCents) { hold(`the rung to ${w(to)} was asked already today`); continue }
      if (to <= c.todayCents) continue
      campaigns.push({ ...head, do: 'write', layer: LADDER_LAYER, fromCents: baseWritten ? c.stepCents : c.todayCents, toCents: to, kind: 'forward', why: ladder.why })
    }
  }

  const portfolios: CapStep[] = []
  const level = String(plan.levers.portfolioCap.effective)
  for (const e of plan.portfolioCap.portfolios) {
    if (e.action !== 'set' || e.capCents == null) continue
    const head = { portfolioId: e.portfolioId, name: e.name, level }
    const hold = (why: string) => portfolios.push({ ...head, do: 'hold', why })
    if (!e.portfolioId) { hold('in no portfolio: Amazon caps only portfolios'); continue }
    if (!isOwnedLevel(level)) { hold(`${level}: the brain plans the cap in shadow, writes nothing`); continue }
    if (!ctx.live) { hold(NOT_LIVE); continue }
    if (e.belowSpend) { hold(`a cap of ${w(e.capCents)} is not above this month's spend in it plus one day: it would stop every campaign in it at once — not written; the pace brakes act first`); continue }
    const owner = plan.portfolioCap.source === 'owner-amount'
    if (e.todaySetBy === 'other' && !owner) {
      if (e.todayPolicy !== 'MONTHLY_RECURRING') { hold(`a ${String(e.todayPolicy ?? 'unknown').toLowerCase().replace(/_/g, ' ')} cap someone else set stands: the brain never changes a cap's kind or removes one`); continue }
      if (e.todayCapCents == null || e.capCents > e.todayCapCents) { hold(`the cap${e.todayCapCents != null ? ` ${w(e.todayCapCents)}` : ''} someone else set stands: the brain may lower it, never raise it (it would plan ${w(e.capCents)})`); continue }
    }
    portfolios.push({ ...head, portfolioId: e.portfolioId, do: level === 'PROPOSE' ? 'ask' : 'write', fromCents: e.todayCapCents, toCents: e.capCents, why: `${plan.portfolioCap.why}; ${e.why}` })
  }
  return { campaigns, portfolios }
}

/** The evidence of one money write: the run, the layer, the data day and the why — what auto-undo judges later. */
export function moneyEvidence(plan: Pick<ProductMoneyPlan, 'pace' | 'day'>, runId: string, layer: string, why: string, observed: number | null, threshold: number | null): AdWriteEvidence {
  return {
    metric: layer === CAP_LAYER ? 'portfolioBudgetCap' : 'dailyBudget',
    observed, threshold,
    note: why.slice(0, 1_000),
    source: { kind: 'ads-brain', id: runId },
    brain: { runId, layer, dataDay: plan.pace.dataThrough ?? plan.day, goalBidCents: null },
  }
}

const emptyActions = (mode: MoneyMode, why: string): MoneyActions => ({ mode, why, campaigns: [], portfolios: [], proposals: [], counts: { queued: 0, written: 0, asked: 0, held: 0, refused: 0, deferred: 0, wouldApply: 0 } })

/**
 * One request a person approves (PROPOSE), asked once per key: an earlier request with this key — waiting, decided or
 * expired — is the answer, never a second one. Through the normal approval gate (runOrQueueTool, forceAsk), as auto-undo
 * asks; the request's dry run is the tool's own (where it lands, the gate as the approver).
 */
export async function askOnce(kind: MoneyProposal['kind'], key: string, tool: 'set-campaign-budget' | 'set-portfolio', args: Record<string, unknown>, why: string): Promise<MoneyProposal> {
  const earlier = await prisma.agentApproval.findFirst({
    where: { toolName: tool, agentRun: { agentKey: MONEY_AGENT_KEY, entityId: key } },
    orderBy: { requestedAt: 'desc' },
    select: { id: true, status: true },
  })
  if (earlier) return { kind, key, approvalId: earlier.id, status: earlier.status, fresh: false, why: WAITING.has(earlier.status) ? 'asked already: it waits for a person' : `asked already: ${earlier.status}` }
  const { runOrQueueTool } = await import('../../agents/approval-gate.service.js')
  const { systemPrincipal } = await import('../../agents/call-tool.js')
  const run = await prisma.agentRun.create({ data: { agentKey: MONEY_AGENT_KEY, trigger: 'schedule', status: 'running', entityType: kind, entityId: key, input: { tool, args } as never } })
  const asked = await runOrQueueTool(tool, args, systemPrincipal(ASK_PRINCIPAL), run.id, { forceAsk: true })
  const queued = asked.mode === 'queued' && !!asked.approvalId
  await prisma.agentRun.update({
    where: { id: run.id },
    data: queued ? { status: 'done', ok: true, output: { mode: 'queued', approvalId: asked.approvalId ?? null } } : { status: 'failed', ok: false, errorMessage: (asked.error ?? 'not queued').slice(0, 500) },
  })
  return queued
    ? { kind, key, approvalId: asked.approvalId!, status: 'pending', fresh: true, why }
    : { kind, key, approvalId: null, status: 'refused', fresh: true, why: `not asked: ${asked.error ?? 'the request was not queued'}` }
}

/** The why a tool request carries: at most 300 characters (the tools' `why`). */
const askWhy = (text: string) => (text.length <= 300 ? text : `${text.slice(0, 297)}...`)

/**
 * Carry one product's money plan out at its levels (see the header). `guard` opens the brain's engine guard on the first
 * write it asks (none when nothing is written). Never throws for one write: each outcome is recorded with its reason.
 */
export async function runMoneyActions(plan: ProductMoneyPlan, facts: ProductMoneyFacts, ctx: { runId: string; live: boolean; guard: () => Promise<EngineGuard>; /** The 15-minute ticks carry campaign budgets only: caps and requests wait for a full slot. */ budgetsOnly?: boolean }): Promise<MoneyActions> {
  const mode = moneyModeOf(facts, ctx.live)
  if (!moneyLeversOwned(facts)) return emptyActions('SHADOW', 'every money lever is OBSERVE or OFF here: shadow only')
  if (mode === 'SHADOW') {
    // PROPOSE or AUTO under a switch that is not live: what it would do, each held with the reason.
    const shadow = emptyActions(mode, NOT_LIVE)
    const s = moneyStepsOf(plan, facts, { live: false })
    for (const c of s.campaigns) if (c.do === 'hold') { shadow.campaigns.push({ campaignId: c.campaignId, name: c.name, level: c.level, layer: null, fromCents: null, toCents: null, sent: 'held', why: c.why }); shadow.counts.held++ }
    for (const p of s.portfolios) if (p.do === 'hold') { shadow.portfolios.push({ portfolioId: p.portfolioId, name: p.name, level: p.level, fromCents: null, toCents: null, sent: 'held', why: p.why }); shadow.counts.held++ }
    return shadow
  }
  const out = emptyActions(mode, mode === 'LIVE' ? 'AUTO: the brain writes inside the pace' : 'PROPOSE: the brain asks a person')
  const w = (c: number) => money(c, facts.currency)

  // Amazon's own budget rules on the campaigns the brain would write (two brains on one lever).
  const candidates = plan.campaigns.filter((c) => (c.action === 'raise' || c.action === 'lower' || c.ladder) && c.owner === 'product').map((c) => c.campaignId)
  let native = new Map<string, string[]>()
  if (candidates.length) {
    const { loadNativeRules, nativeRuleLines } = await import('./native-rules.js')
    const readings = await loadNativeRules(candidates)
    native = new Map(candidates.map((id) => [id, nativeRuleLines(readings.get(id), 'budgets')]))
  }
  const steps = moneyStepsOf(plan, facts, { live: ctx.live, native })
  const byCampaign = new Map<string, CampaignStep[]>()
  for (const s of steps.campaigns) byCampaign.set(s.campaignId, [...(byCampaign.get(s.campaignId) ?? []), s])
  const decision = new Map(plan.campaigns.map((c) => [c.campaignId, c]))
  let guard: EngineGuard | null = null
  const openGuard = async () => (guard ??= await ctx.guard())
  const note = (a: CampaignAction) => {
    out.campaigns.push(a)
    if (a.sent === 'queued') out.counts.queued++
    else if (a.sent === 'refused') out.counts.refused++
    else if (a.sent === 'deferred' || a.sent === 'waiting') out.counts.deferred++
    else if (a.sent === 'would-apply') out.counts.wouldApply++
    else if (a.sent === 'held') out.counts.held++
  }

  // ── Campaign budgets: AUTO writes, campaign by campaign (never split), base before its rung ─────────────────────────
  const asks: Array<{ campaignId: string; name: string; fromCents: number; toCents: number }> = []
  const { updateCampaignWithSync } = await import('../ads-mutation.service.js')
  for (const [campaignId, list] of byCampaign) {
    const writes = list.filter((s): s is Extract<CampaignStep, { do: 'write' }> => s.do === 'write')
    for (const s of list) {
      if (s.do === 'hold') note({ campaignId, name: s.name, level: s.level, layer: null, fromCents: null, toCents: null, sent: 'held', why: s.why })
      else if (s.do === 'ask') asks.push({ campaignId, name: s.name, fromCents: s.fromCents, toCents: s.toCents })
    }
    if (!writes.length) continue
    const g = await openGuard()
    const permit = g.permit({ market: plan.market })
    const held = nothingHeld()
    let changes = 0
    for (const s of writes) {
      let to = s.toCents
      let layer: string = s.layer
      if (!allowChange(true, permit, held, s.kind)) {
        // Under SUGGEST an earlier day's ladder is still given back on its own (a restore), never the new base move.
        if (s.restoreCents != null && allowChange(true, permit, held, 'restore')) { to = s.restoreCents; layer = 'giveback' }
        else {
          const sent = g.posture === 'suggest' ? 'would-apply' as const : g.posture === 'stopped' ? 'waiting' as const : 'deferred' as const
          note({ campaignId, name: s.name, level: s.level, layer: s.layer, fromCents: s.fromCents, toCents: s.toCents, sent, why: s.why, reason: g.posture === 'auto' ? 'the brain\'s money caps for this run are used: it goes next run' : `the account ads automation is ${g.posture.toUpperCase()}` })
          if (s.layer === BASE_LAYER) break // no rung on a base that was not written
          continue
        }
      }
      const c = decision.get(campaignId)!
      const why = layer === 'giveback' ? `gives back an earlier day's ladder to its base ${w(to)} (the day's base move waits for AUTO)` : s.why
      try {
        const r = await updateCampaignWithSync({
          campaignId,
          patch: { dailyBudget: to / 100 },
          actor: MONEY_BUDGETS_ACTOR as AdsActor,
          reason: `ads brain — ${why}`.slice(0, 480),
          evidence: moneyEvidence(plan, ctx.runId, layer === 'giveback' ? BASE_LAYER : layer, why, c.expectedSpendCents, layer === LADDER_LAYER ? to : c.targetCents),
          askGate: true,
        })
        if (r.ok && r.outboundQueueId) { changes++; note({ campaignId, name: s.name, level: s.level, layer, fromCents: s.fromCents, toCents: to, sent: 'queued', why, actionLogId: r.actionLogId }) }
        else if (r.ok) note({ campaignId, name: s.name, level: s.level, layer, fromCents: s.fromCents, toCents: to, sent: 'unchanged', why })
        else {
          note({ campaignId, name: s.name, level: s.level, layer, fromCents: s.fromCents, toCents: to, sent: 'refused', why, reason: r.error ?? 'refused by the budget write' })
          if (s.layer === BASE_LAYER) break
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        note({ campaignId, name: s.name, level: s.level, layer, fromCents: s.fromCents, toCents: to, sent: 'refused', why, reason })
        logger.warn('[brain-money] a budget write failed', { campaignId, error: reason })
        if (s.layer === BASE_LAYER) break
      }
    }
    g.settle(permit, changes, held)
  }

  // ── Campaign budgets: PROPOSE asks, one request per product a budget day ────────────────────────────────────────
  if (asks.length && ctx.budgetsOnly) for (const a of asks) note({ campaignId: a.campaignId, name: a.name, level: 'PROPOSE', layer: BASE_LAYER, fromCents: a.fromCents, toCents: a.toCents, sent: 'held', why: 'asked at the next full slot' })
  else if (asks.length) {
    const label = plan.name ?? plan.productId
    const why = askWhy(`ads brain — ${label} (${plan.market}) ${plan.day}: the day's budget moves inside the pace (${plan.brake.level === 'none' ? 'no brake' : `brake ${plan.brake.level}`}); ${asks.map((a) => `${a.name} ${w(a.fromCents)} → ${w(a.toCents)}`).join(', ')}`)
    const p = await askOnce('budgets', `budgets:${plan.productId}:${plan.market}:${plan.day}`, 'set-campaign-budget', { campaigns: asks.map((a) => ({ campaignId: a.campaignId, dailyBudgetCents: a.toCents })), why }, why)
    out.proposals.push(p)
    for (const a of asks) {
      const s = byCampaign.get(a.campaignId)!.find((x) => x.do === 'ask')!
      note({ campaignId: a.campaignId, name: a.name, level: s.level, layer: BASE_LAYER, fromCents: a.fromCents, toCents: a.toCents, sent: p.approvalId ? 'asked' : 'refused', why: s.why, reason: p.why })
    }
    if (p.fresh && p.approvalId) out.counts.asked++
  }

  // ── Portfolio caps (at the full slots only: a cap changes rarely) ─────────────────────────────────────────────────
  for (const s of ctx.budgetsOnly ? [] : steps.portfolios) {
    if (s.do === 'hold') { out.portfolios.push({ portfolioId: s.portfolioId, name: s.name, level: s.level, fromCents: null, toCents: null, sent: 'held', why: s.why }); out.counts.held++; continue }
    if (s.do === 'ask') {
      const p = await askOnce('portfolioCap', `cap:${plan.productId}:${plan.market}:${s.portfolioId}:${plan.month}:${s.toCents}`, 'set-portfolio',
        { op: 'update', portfolioId: s.portfolioId, cap: { amountCents: s.toCents, policy: 'monthly' }, why: askWhy(`ads brain — ${s.why}`) }, s.why)
      out.proposals.push(p)
      if (p.fresh && p.approvalId) out.counts.asked++
      out.portfolios.push({ portfolioId: s.portfolioId, name: s.name, level: s.level, fromCents: s.fromCents, toCents: s.toCents, sent: p.approvalId ? 'asked' : 'refused', why: s.why, reason: p.why })
      continue
    }
    const g = await openGuard()
    const permit = g.permit({ market: plan.market })
    const held = nothingHeld()
    if (!allowChange(true, permit, held, 'forward')) {
      const sent = g.posture === 'suggest' ? 'would-apply' as const : g.posture === 'stopped' ? 'waiting' as const : 'deferred' as const
      out.portfolios.push({ portfolioId: s.portfolioId, name: s.name, level: s.level, fromCents: s.fromCents, toCents: s.toCents, sent, why: s.why, reason: g.posture === 'auto' ? 'the brain\'s money caps for this run are used: it goes next run' : `the account ads automation is ${g.posture.toUpperCase()}` })
      if (sent === 'would-apply') out.counts.wouldApply++
      else out.counts.deferred++
      g.settle(permit, 0, held)
      continue
    }
    try {
      const { updatePortfolioById } = await import('../ads-portfolio.service.js')
      const r = await updatePortfolioById({
        portfolioId: s.portfolioId,
        budget: { amount: s.toCents / 100, currencyCode: facts.currency, policy: 'monthlyRecurring' },
        actor: MONEY_PORTFOLIO_ACTOR as AdsActor,
        audit: { actor: MONEY_PORTFOLIO_ACTOR, changeSetId: null, evidence: moneyEvidence(plan, ctx.runId, CAP_LAYER, s.why, plan.pace.projectedCents, s.toCents) },
      })
      if (r.ok) { out.counts.written++; out.portfolios.push({ portfolioId: s.portfolioId, name: s.name, level: s.level, fromCents: s.fromCents, toCents: s.toCents, sent: 'written', why: s.why, reason: `mode ${r.mode}` }) }
      else { out.counts.refused++; out.portfolios.push({ portfolioId: s.portfolioId, name: s.name, level: s.level, fromCents: s.fromCents, toCents: s.toCents, sent: 'refused', why: s.why, reason: r.error ?? 'refused' }) }
      g.settle(permit, r.ok ? 1 : 0, held)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      out.counts.refused++
      out.portfolios.push({ portfolioId: s.portfolioId, name: s.name, level: s.level, fromCents: s.fromCents, toCents: s.toCents, sent: 'refused', why: s.why, reason })
      logger.warn('[brain-money] a portfolio cap write failed', { portfolioId: s.portfolioId, error: reason })
      g.settle(permit, 0, held)
    }
  }
  return out
}

/** "queued=2 asked=1 refused=1 held=3" — a product's part of the run line; '' when the writer did nothing. */
export function moneyActionsWords(a: MoneyActions | null | undefined): string {
  if (!a || a.mode === 'SHADOW') return ''
  const c = a.counts
  return [
    c.queued ? `queued=${c.queued}` : '', c.written ? `caps=${c.written}` : '', c.asked ? `asked=${c.asked}` : '',
    c.wouldApply ? `would-apply=${c.wouldApply}` : '', c.deferred ? `deferred=${c.deferred}` : '',
    c.refused ? `refused=${c.refused}` : '', c.held ? `held=${c.held}` : '',
  ].filter(Boolean).join(' ')
}
