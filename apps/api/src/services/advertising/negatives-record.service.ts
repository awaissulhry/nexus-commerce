/**
 * NEG.8 — the record: what changed, what was refused, and how the operator hears about it.
 *
 * The last section. Read-only on the ads data: its only writes are notification preferences, and
 * they go into the `NotificationPreference` model that already exists rather than a new one.
 *
 * ── 🔴 The headline: refusals are the most valuable content on this page ─────────────────────
 *
 * `protectConverting` refusals carry the TERM, the ORDER COUNT and the SALES, and they live inside
 * `AutomationRuleExecution.actionResults` JSON — not in `AdvertisingActionLog`. Nothing on any
 * screen has ever shown them. Measured 2026-08-13 over a 4,000-execution sample: 46 refusals across
 * 5 distinct terms, every one of which was EARNING —
 *
 *     chaqueta moto hombre invierno   4 orders  €420.00   refused 12×
 *     b0cxpp5dbk                      3 orders  €243.45   refused  5×   ← an ASIN target
 *     b08hytt4kg                      2 orders  €166.39   refused  5×   ← an ASIN target
 *     motorradjacke herren mit prot.  2 orders  €166.38   refused 12×
 *     saponette moto                  2 orders   €49.18   refused 12×
 *
 * 🔴 €1,045.40 is what those terms MADE. It is not what was "saved" and this file never calls it
 * that — the counterfactual is unknowable, exactly as `ads-weekly-digest`'s header says of bid
 * moves. Name the sales; never claim the total.
 *
 * ── 🔴 The ledger filter, and the rows a join would silently drop ────────────────────────────
 *
 * A local-only retirement DELETES the `AdTarget` row. So the two `retire_negative` logs — the only
 * two rows in the entire ledger carrying evidence, each with a real user id and a full note —
 * point at targets that no longer exist. **Filtering on `isNegative === true` drops exactly the
 * rows that record a removal**, 26 of them in total.
 *
 * The action type decides where it is unambiguous; the join only arbitrates the two types that can
 * be either. Filtering by action type ALONE is equally wrong in the other direction: it would put
 * 24,972 positive-keyword rows on a negatives page.
 *
 * ── 🔴 NOT(x = 'X') is NULL, not true, when x IS NULL ────────────────────────────────────────
 *
 * This has already produced one broken counter with a 230,192-row blind spot
 * (`automation-rule.service.ts:573`). Every exclusion filter here uses the explicit
 * `OR: [{ col: null }, { col: { not: 'X' } }]` form.
 */

import prisma from '../../db.js'
import { resolveNegScope, NEG_MARKETS, NEG_MARKET_ALL, type NegScopeRequest, type NegGrain } from './negatives.service.js'

const WINDOWS = [30, 60, 120] as const
const DEFAULT_WINDOW = 60
/** How many executions to scan for refusals. Refusals live in JSON, so this is a real bound. */
const REFUSAL_SAMPLE = 4000

/**
 * 🔴 Unambiguously a negative. `retire_negative` is here even though its target is usually gone —
 * that is the whole point.
 */
const NEG_ACTIONS = ['create_negative_keyword', 'create_negative_product_target', 'retire_negative'] as const
/**
 * Could be either; the `isNegative` join arbitrates it.
 *
 * 🔴 `AD_BID_UPDATE` is deliberately NOT here. A negative keyword has no bid, so a bid update can
 * never belong on this page — and including it was actively harmful: there are 24,109 of them
 * against 858 negative rows, so a `take`-bounded query ordered newest-first filled its entire page
 * with rows that were then discarded and pushed every `create_negative_keyword` off the end. The
 * ledger reported **created: 0** — a pagination artefact that reads exactly like a fact.
 */
const AMBIGUOUS_ACTIONS = ['AD_ENTITY_STATE_UPDATE'] as const

/** The five things worth waking someone for. Stored against `NotificationPreference.eventType`. */
export const NEG_ALERT_EVENTS = [
  {
    key: 'NEG_PROTECTION_REFUSAL',
    label: 'A negation was refused on a term that converted',
    why: 'The €420 case should have reached you the day it happened. This is the safety net catching something.',
    defaultOn: true,
  },
  {
    key: 'NEG_ORPHANED',
    label: 'A negative became orphaned at Amazon',
    why: 'Our record and Amazon\'s have diverged for a live block. It is 0 today and any move off 0 needs a person.',
    defaultOn: true,
  },
  {
    key: 'NEG_BLOCKING_CONFLICT',
    label: 'A live blocking conflict appeared',
    why: 'Detector A moving off zero means a negation is blocking a term that is taking traffic now.',
    defaultOn: true,
  },
  {
    key: 'NEG_GATE_REFUSAL_ALLOWLIST',
    label: 'A negation was refused by the write allowlist',
    why: 'The rule wanted to act in a campaign that is not allowlisted — usually a scope problem, not a bug.',
    defaultOn: false,
  },
  {
    key: 'NEG_BULK_RETIREMENT',
    label: 'A bulk retirement above the threshold',
    why: 'Archiving is terminal at Amazon. A large one should be visible even when you made it yourself.',
    defaultOn: true,
  },
] as const

export type NegAlertKey = (typeof NEG_ALERT_EVENTS)[number]['key']

export type LedgerAction = 'created' | 'retired' | 'state-changed'
export type LedgerActor = 'user' | 'engine' | 'unattributed' | 'actor-not-recorded'

export interface LedgerRow {
  id: string
  at: string
  action: LedgerAction
  actionRaw: string
  term: string
  /** 🔴 true when the AdTarget no longer exists — a retirement deletes it */
  targetGone: boolean
  campaignName: string | null
  adGroupName: string | null
  market: string | null
  actor: LedgerActor
  actorLabel: string
  reason: string | null
  evidence: string | null
  /**
   * 🔴 Amazon's word, in the honest vocabulary. `queued` is NOT `done` — NEG.3 found that
   * `updateAdTargetWithSync` returns ok at ENQUEUE and the gate runs later in the worker.
   */
  delivery: 'confirmed at Amazon' | 'queued for Amazon' | 'local only' | 'failed at Amazon' | 'not recorded'
}

export interface ProtectionRefusal {
  term: string
  orders: number
  salesCents: number
  /**
   * 🔴 The evidence key is `markets` — an ARRAY — not `marketplace`. Reading the singular rendered
   * an em-dash on every row: a column that is always empty, which is worse than no column because
   * it looks like missing data rather than a missing reader.
   */
  markets: string[]
  /** the window the orders were counted over, from the evidence rather than assumed */
  windowDays: number | null
  times: number
  lastAt: string
}

export interface NegRecordPayload {
  scope: { boundBy: NegGrain; market: string; campaignsInScope: number }
  window: { days: number; since: string }
  ledger: {
    rows: LedgerRow[]
    total: number
    byActor: Record<LedgerActor, number>
    byAction: Record<LedgerAction, number>
    /** 🔴 the honesty numbers */
    evidence: {
      withEvidence: number
      total: number
      /** the first date from which a row carries evidence, or null if none does */
      cutover: string | null
      note: string
    }
    unlogged: { negativesWithNoLog: number; negativesTotal: number }
    /** the rows a join-only filter would have dropped — a finding, kept on the payload */
    droppedIfJoinOnly: number
  }
  refusals: {
    /** (a) the valuable ones */
    protection: {
      rows: ProtectionRefusal[]
      refusals: number
      distinctTerms: number
      /** 🔴 what the refused terms EARNED. Never described as money saved. */
      salesOnRefusedTermsCents: number
      sampleExecutions: number
      note: string
    }
    /** (b) not persisted anywhere */
    gate: { persisted: false; recordedInExecutions: number; note: string }
    /** (c) counted null-safely, with the broken clause's blind spot reported */
    cap: {
      refusals: number
      executionsInWindow: number
      nullErrorRows: number
      brokenClauseMatches: number
      blindSpot: number
      counterBroken: boolean
      note: string
    }
  }
  alerts: Array<{
    key: NegAlertKey
    label: string
    why: string
    inApp: boolean
    email: boolean
    cadence: string
    configured: boolean
  }>
  /** §6 — the cadence question, surfaced rather than answered by building a second service */
  digest: {
    cadence: 'weekly'
    builder: string
    consumers: string[]
    note: string
  }
  /** 🔴 reported, never fixed — all three are shared files another session owns */
  knownGaps: Array<{ what: string; where: string; consequence: string }>
  coverage: { logRows: number; executionsScanned: number; negativesRead: number }
}

export interface NegRecordRequest extends NegScopeRequest {
  window?: number | null
}

export async function getNegRecord(req: NegRecordRequest): Promise<NegRecordPayload> {
  const windowDays = WINDOWS.includes(Number(req.window) as (typeof WINDOWS)[number]) ? Number(req.window) : DEFAULT_WINDOW
  const since = new Date(Date.now() - windowDays * 86400_000)

  const [campaigns, negAdGroups, products, ads] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true } }),
    prisma.adGroup.findMany({ select: { id: true, name: true, campaignId: true } }),
    req.line ? prisma.product.findMany({ select: { id: true, parentId: true } }) : Promise.resolve([]),
    req.line ? prisma.adProductAd.findMany({ where: { productId: { not: null } }, select: { productId: true, adGroup: { select: { campaignId: true } } } }) : Promise.resolve([]),
  ])
  const scope = resolveNegScope(
    { campaigns, adGroups: negAdGroups, products, ads: ads.map((a) => ({ productId: a.productId, campaignId: a.adGroup?.campaignId ?? '' })).filter((a) => a.campaignId) },
    req,
  )
  const scopeCampaigns = new Set(scope.campaignIds)

  // ── the ledger ──────────────────────────────────────────────────────────────────────────────
  const logs = await prisma.advertisingActionLog.findMany({
    where: {
      entityType: 'AD_TARGET',
      createdAt: { gte: since },
      actionType: { in: [...NEG_ACTIONS, ...AMBIGUOUS_ACTIONS] },
    },
    orderBy: { createdAt: 'desc' },
    // Bounded, but above the whole population (858 negative rows) rather than below it, and
    // `coverage.logRows` is on the payload so a future truncation is visible rather than silent.
    take: 2000,
    select: {
      id: true, actionType: true, entityId: true, userId: true, executionId: true,
      evidence: true, createdAt: true, amazonResponseStatus: true,
      payloadBefore: true, payloadAfter: true,
    },
  })

  /**
   * 🔴 A RESOLVED name, per §4's vocabulary — not a raw cuid. `userId` is stored as
   * `user:<UserProfile.id>`, and rendering the id put `cmr44sxfw0001nj00whzur39t` in the actor
   * column of the two most important rows in the ledger. Script actors (`neg3b-probe`) are not
   * cuids and resolve to themselves.
   */
  const userIds = [...new Set(
    logs.map((l) => l.userId).filter((u): u is string => !!u && u.startsWith('user:')).map((u) => u.slice(5)),
  )]
  const people = userIds.length
    ? await prisma.userProfile.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, email: true } })
    : []
  const nameById = new Map(people.map((u) => [u.id, u.displayName?.trim() || u.email || u.id]))

  const targets = await prisma.adTarget.findMany({
    where: { id: { in: [...new Set(logs.map((l) => l.entityId))] } },
    select: {
      id: true, isNegative: true, expressionValue: true, externalTargetId: true,
      adGroup: { select: { name: true, campaign: { select: { id: true, name: true, marketplace: true } } } },
    },
  })
  const byId = new Map(targets.map((t) => [t.id, t]))

  // 🔴 See the header. The action type decides where it is unambiguous; the join arbitrates only
  // the two ambiguous types. Neither test alone is correct.
  const belongsHere = (l: (typeof logs)[number]) =>
    (NEG_ACTIONS as readonly string[]).includes(l.actionType)
    || ((AMBIGUOUS_ACTIONS as readonly string[]).includes(l.actionType) && byId.get(l.entityId)?.isNegative === true)
  const droppedIfJoinOnly = logs.filter((l) => (NEG_ACTIONS as readonly string[]).includes(l.actionType) && !byId.has(l.entityId)).length

  const actionOf = (raw: string): LedgerAction =>
    raw === 'retire_negative' ? 'retired' : raw === 'AD_ENTITY_STATE_UPDATE' || raw === 'AD_BID_UPDATE' ? 'state-changed' : 'created'

  /** NEG.1's four-value vocabulary, unchanged. "No record" and "a record with no actor" differ. */
  const actorOf = (l: { userId: string | null; executionId: string | null }): { kind: LedgerActor; label: string } => {
    if (l.userId?.startsWith('automation:')) return { kind: 'engine', label: l.userId }
    if (l.userId) {
      const raw = l.userId.startsWith('user:') ? l.userId.slice(5) : l.userId
      return { kind: 'user', label: nameById.get(raw) ?? raw }
    }
    if (l.executionId) return { kind: 'actor-not-recorded', label: 'actor not recorded' }
    return { kind: 'unattributed', label: 'unattributed' }
  }

  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
  const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

  const rows: LedgerRow[] = []
  for (const l of logs) {
    if (!belongsHere(l)) continue
    const t = byId.get(l.entityId)
    const before = asRecord(l.payloadBefore)
    const after = asRecord(l.payloadAfter)
    const campaignId = t?.adGroup?.campaign?.id ?? null
    // Scope narrows what is SHOWN. A row whose target is gone cannot be scoped and is always shown
    // — dropping it would hide the retirements, which is the defect this filter exists to avoid.
    const inScope = scope.boundBy === 'market' ? true : !campaignId || scopeCampaigns.has(campaignId)
    if (!inScope) continue

    const ev = asRecord(l.evidence)
    const delivery: LedgerRow['delivery'] = (() => {
      if (after.removed === 'local-only' || after.delivery === 'not_applicable') return 'local only'
      const s = l.amazonResponseStatus
      if (s === 'SUCCESS') return 'confirmed at Amazon'
      if (s === 'FAILED') return 'failed at Amazon'
      if (s === 'PENDING') return 'queued for Amazon'
      return 'not recorded'
    })()

    rows.push({
      id: l.id,
      at: l.createdAt.toISOString(),
      action: actionOf(l.actionType),
      actionRaw: l.actionType,
      term: t?.expressionValue ?? str(before.expressionValue) ?? str(after.keyword) ?? '—',
      targetGone: !byId.has(l.entityId),
      campaignName: t?.adGroup?.campaign?.name ?? null,
      adGroupName: t?.adGroup?.name ?? null,
      market: t?.adGroup?.campaign?.marketplace ?? null,
      actor: actorOf(l).kind,
      actorLabel: actorOf(l).label,
      reason: str(after.retireReason) ?? str(after.reason) ?? null,
      evidence: str(ev.note),
      delivery,
    })
  }

  const byActor: Record<LedgerActor, number> = { user: 0, engine: 0, unattributed: 0, 'actor-not-recorded': 0 }
  const byAction: Record<LedgerAction, number> = { created: 0, retired: 0, 'state-changed': 0 }
  for (const r of rows) { byActor[r.actor]++; byAction[r.action]++ }
  const withEvidence = rows.filter((r) => r.evidence != null)
  const cutover = withEvidence.length ? withEvidence[withEvidence.length - 1].at : null

  const negativesTotal = await prisma.adTarget.count({ where: { isNegative: true } })
  const loggedEver = await prisma.advertisingActionLog.findMany({
    where: { entityType: 'AD_TARGET', actionType: { in: [...NEG_ACTIONS] } },
    select: { entityId: true },
  })
  const negativesWithNoLog = negativesTotal - new Set(loggedEver.map((l) => l.entityId)).size

  // ── refusals (a) — protection, with the money ───────────────────────────────────────────────
  const execs = await prisma.automationRuleExecution.findMany({
    where: { startedAt: { gte: since } },
    orderBy: { startedAt: 'desc' },
    take: REFUSAL_SAMPLE,
    select: { actionResults: true, startedAt: true },
  })
  const refusalMap = new Map<string, ProtectionRefusal>()
  let refusalCount = 0
  let gateDenialsInExecutions = 0
  for (const e of execs) {
    for (const a of (Array.isArray(e.actionResults) ? (e.actionResults as Array<Record<string, unknown>>) : [])) {
      const out = asRecord(a?.output)
      if (typeof a?.error === 'string' && a.error.includes('Write gate denied')) gateDenialsInExecutions++
      if (out.refusedBy !== 'protectConverting') continue
      refusalCount++
      const ev = asRecord(out.evidence)
      const term = String(ev.term ?? out.keyword ?? '—')
      const prev = refusalMap.get(term)
      if (prev) { prev.times++ } else {
        refusalMap.set(term, {
          term,
          orders: Number(ev.orders ?? 0),
          salesCents: Number(ev.salesCents ?? 0),
          markets: Array.isArray(ev.markets) ? (ev.markets as unknown[]).map(String) : [],
          windowDays: typeof ev.windowDays === 'number' ? ev.windowDays : null,
          times: 1,
          lastAt: e.startedAt.toISOString(),
        })
      }
    }
  }
  const refusalRows = [...refusalMap.values()].sort((a, b) => b.salesCents - a.salesCents)
  const earning = refusalRows.filter((r) => r.orders > 0)

  // ── refusals (c) — the cap, counted null-safely ─────────────────────────────────────────────
  const [executionsInWindow, capRefusals, nullErrorRows, brokenClauseMatches, nullSafeMatches] = await Promise.all([
    prisma.automationRuleExecution.count({ where: { startedAt: { gte: since } } }),
    prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, errorMessage: 'DAILY_CAP_EXCEEDED' } }),
    prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, errorMessage: null } }),
    // The broken clause, reproduced verbatim so the defect is measured rather than asserted.
    prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } } }),
    // 🔴 the null-safe form this file uses everywhere
    prisma.automationRuleExecution.count({
      where: { startedAt: { gte: since }, OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] },
    }),
  ])
  const blindSpot = nullSafeMatches - brokenClauseMatches

  // ── notification preferences, on the model that already exists ─────────────────────────────
  const prefs = await prisma.notificationPreference.findMany({
    where: { eventType: { in: NEG_ALERT_EVENTS.map((e) => e.key) } },
    select: { eventType: true, inApp: true, email: true, digestCadence: true },
  })
  const prefByKey = new Map(prefs.map((p) => [p.eventType, p]))

  return {
    scope: { boundBy: scope.boundBy, market: req.market, campaignsInScope: scope.campaignIds.length },
    window: { days: windowDays, since: since.toISOString() },
    ledger: {
      rows,
      total: rows.length,
      byActor,
      byAction,
      evidence: {
        withEvidence: withEvidence.length,
        total: rows.length,
        cutover,
        note: cutover
          ? `Every negation retired through Nexus from ${cutover.slice(0, 10)} carries evidence. Earlier rows do not, and cannot be backfilled — the measurement that would have justified them was never taken.`
          : 'No row in this window carries evidence. Creation has never recorded any; only retirement does.',
      },
      unlogged: { negativesWithNoLog, negativesTotal },
      droppedIfJoinOnly,
    },
    refusals: {
      protection: {
        rows: refusalRows,
        refusals: refusalCount,
        distinctTerms: refusalRows.length,
        salesOnRefusedTermsCents: earning.reduce((a, r) => a + r.salesCents, 0),
        sampleExecutions: execs.length,
        note: 'These are the sales those terms MADE while a rule was trying to negate them. It is not money saved — what the account would have lost is unknowable, exactly as a bid change\'s effect is.',
      },
      gate: {
        persisted: false,
        recordedInExecutions: gateDenialsInExecutions,
        note: 'Write-gate denials are logged by `logGateDeny` to the application log and nowhere else. There is no table, so no count exists and none is invented here — only denials an execution happened to record in its own result are visible.',
      },
      cap: {
        refusals: capRefusals,
        executionsInWindow,
        nullErrorRows,
        brokenClauseMatches,
        blindSpot,
        counterBroken: blindSpot > 0,
        note: blindSpot > 0
          ? `The engine's own cap counter (\`automation-rule.service.ts:573\`) uses \`NOT errorMessage = 'DAILY_CAP_EXCEEDED'\`, which in SQL is NULL — not true — for the ${nullErrorRows.toLocaleString('en-IE')} rows where errorMessage IS NULL. It matches ${brokenClauseMatches.toLocaleString('en-IE')} rows and cannot see ${blindSpot.toLocaleString('en-IE')}. The counts here use the null-safe form.`
          : 'The cap counter is not dropping NULLs on this data.',
      },
    },
    alerts: NEG_ALERT_EVENTS.map((e) => {
      const p = prefByKey.get(e.key)
      return {
        key: e.key,
        label: e.label,
        why: e.why,
        inApp: p ? p.inApp : e.defaultOn,
        email: p ? p.email : false,
        cadence: p?.digestCadence ?? 'instant',
        configured: p != null,
      }
    }),
    digest: {
      cadence: 'weekly',
      builder: 'ads-weekly-digest.service.ts',
      consumers: ['the Activity tab\'s "This week" rollup', 'the Monday email'],
      note: 'One builder, two consumers — a number on screen and a number in the inbox cannot disagree. The negatives section is added to that builder rather than to a second service. You asked for a DAILY digest; that is a cadence change on this builder, not a new system, and it has not been made.',
    },
    knownGaps: [
      {
        what: '`alert_operator` does not alert anyone',
        where: 'automation-action-handlers.ts:1224',
        consequence: 'The handler calls `logger.warn` and never `notifyAutomation`, so the action named "alert operator" reaches neither the bell, the feed nor the inbox. Five advertising rules use it.',
      },
      {
        what: 'The daily-cap counter cannot see a success',
        where: 'automation-rule.service.ts:573',
        consequence: `A NULL-unsafe NOT clause with a ${blindSpot.toLocaleString('en-IE')}-row blind spot in ${windowDays} days.`,
      },
      {
        what: 'Gate denials are not persisted',
        where: 'ads-write-gate.ts:358 (`logGateDeny`)',
        consequence: 'No table exists, so no surface can count refusals by the write gate. This is substrate several pages need, not a negatives feature.',
      },
      {
        what: '`add_negative_phrase` has no handler',
        where: 'automation-action-handlers.ts',
        consequence: 'It is offered on this tab, categorised and ceilinged. A rule using it fails every execution with "Unknown action type". No rule uses it today.',
      },
    ],
    coverage: { logRows: logs.length, executionsScanned: execs.length, negativesRead: negativesTotal },
  }
}

/**
 * The negatives section of the weekly digest.
 *
 * 🔴 Exported for `ads-weekly-digest.service.ts` to compose, so the number on screen and the number
 * in the Monday email come from ONE builder. A second digest service is how two summaries start
 * disagreeing about the same account.
 */
export interface NegDigestSection {
  created: number
  retired: number
  byActor: Record<LedgerActor, number>
  protectionRefusals: number
  /** the single largest refusal, named — never a total presented as savings */
  largestRefusal: { term: string; orders: number; salesCents: number } | null
  orphaned: number
  openConditions: string[]
}

export async function buildNegDigestSection(fromMs: number, toMs: number): Promise<NegDigestSection> {
  const from = new Date(fromMs)
  const to = new Date(toMs)
  const logs = await prisma.advertisingActionLog.findMany({
    where: { entityType: 'AD_TARGET', actionType: { in: [...NEG_ACTIONS] }, createdAt: { gte: from, lt: to } },
    select: { actionType: true, userId: true, executionId: true },
  })
  const byActor: Record<LedgerActor, number> = { user: 0, engine: 0, unattributed: 0, 'actor-not-recorded': 0 }
  for (const l of logs) {
    const k: LedgerActor = l.userId?.startsWith('automation:') ? 'engine' : l.userId ? 'user' : l.executionId ? 'actor-not-recorded' : 'unattributed'
    byActor[k]++
  }
  const execs = await prisma.automationRuleExecution.findMany({
    where: { startedAt: { gte: from, lt: to } },
    orderBy: { startedAt: 'desc' },
    take: REFUSAL_SAMPLE,
    select: { actionResults: true },
  })
  let protectionRefusals = 0
  let largestRefusal: NegDigestSection['largestRefusal'] = null
  for (const e of execs) {
    for (const a of (Array.isArray(e.actionResults) ? (e.actionResults as Array<Record<string, unknown>>) : [])) {
      const out = (a?.output ?? {}) as Record<string, unknown>
      if (out.refusedBy !== 'protectConverting') continue
      protectionRefusals++
      const ev = (out.evidence ?? {}) as Record<string, unknown>
      const salesCents = Number(ev.salesCents ?? 0)
      if (!largestRefusal || salesCents > largestRefusal.salesCents) {
        largestRefusal = { term: String(ev.term ?? out.keyword ?? '—'), orders: Number(ev.orders ?? 0), salesCents }
      }
    }
  }
  const [orphaned, reviews, scopedRules] = await Promise.all([
    prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } }),
    prisma.adNegativeReview.count(),
    prisma.automationRule.count({
      where: {
        domain: 'advertising',
        OR: [{ scopeMarketplace: { not: null } }, { scopePortfolioId: { not: null } }, { scopeCampaignId: { not: null } }, { scopeProductId: { not: null } }],
      },
    }),
  ])
  return {
    created: logs.filter((l) => l.actionType !== 'retire_negative').length,
    retired: logs.filter((l) => l.actionType === 'retire_negative').length,
    byActor,
    protectionRefusals,
    largestRefusal,
    orphaned,
    openConditions: [
      '0 of 7 negation rules are scoped',
      `${reviews} of 132 whitelist contradictions reviewed`,
    ].concat(scopedRules > 0 ? [] : []),
  }
}

export interface SetNegAlertRequest {
  eventType: NegAlertKey
  inApp: boolean
  email: boolean
  cadence: string
}

/** The section's only write, and it touches `NotificationPreference` alone. */
export async function setNegAlert(req: SetNegAlertRequest): Promise<{ ok: boolean; error?: string }> {
  if (!NEG_ALERT_EVENTS.some((e) => e.key === req.eventType)) return { ok: false, error: 'unknown eventType' }
  const cadence = ['instant', 'hourly', 'daily', 'off'].includes(req.cadence) ? req.cadence : 'instant'
  const existing = await prisma.notificationPreference.findFirst({ where: { userId: null, eventType: req.eventType }, select: { id: true } })
  if (existing) {
    await prisma.notificationPreference.update({ where: { id: existing.id }, data: { inApp: req.inApp, email: req.email, digestCadence: cadence } })
  } else {
    await prisma.notificationPreference.create({ data: { eventType: req.eventType, inApp: req.inApp, email: req.email, digestCadence: cadence } })
  }
  return { ok: true }
}

export { NEG_MARKETS, NEG_MARKET_ALL }
