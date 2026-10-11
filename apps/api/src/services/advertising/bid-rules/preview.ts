/**
 * Bid page (2026-10-10) — POST /advertising/bid-rules/preview: what a bid rule would change NOW, for a rule body that is
 * saved or not. Nothing is written: no rule, no run row, no counter, no suggestion, no brain input, no bid.
 *
 *   · a builder Bid rule (actions[0].type 'bid'), saved or not, edited or not: the builder preview's own pipeline
 *     (ads-rule-preview.service.ts runDraftPreview: the real TARGET_PERFORMANCE contexts over the rule's lookback, its
 *     scope as the evaluator reads it — its picked campaigns, or with none picked its whole market, as
 *     `builderScopeCampaignIds` and bid_apply's empty picker do — the adapter's translation, the first matching block, and
 *     that block's OWN handler in a dry run: bid_apply, or pause_target / enable_target for Pause / Unpause);
 *   · a saved engine rule (bid_down, bid_up, lower_bid_to_floor, raise_bids_for_rank_defense, bid_to_target_acos, …) as
 *     stored: its Simulate (simulateOneRule — every context its trigger builds, through evaluateRule with noPersist, so
 *     the bid brain's input and the lever skips are the engine's own). Its unsaved edits cannot be previewed: refused.
 *
 * Each handler's dry run is read by its own shape (pure.ts actionOutcome). Each would-be change says what would really
 * happen to it (read.ts campaignGate): on a campaign the bid brain owns it is a brain input (`held: 'brain'`; 'brainStopped'
 * when the Owner's kill switch stops the brain's bids there); the write gate refuses it off the live-write allowlist, with
 * pinned bids or a connection that takes no writes (`'locked'`), and in a market without Amazon's checked limits
 * (`'market'`). Each held change carries its words too (`heldBy`: { kind, label, reason }, pure.ts HOLDS — audit §2:
 * Brain decides · Brain off · Locked · Market not set up), and `holds` counts them per word. `wouldChange` counts what the
 * rule itself would change, plus what a handler counted without listing (`unsampled`). Bids are money keys (fromCents,
 * toCents).
 *
 * `sentence` is the body in one line — the same function, so the same words, as the rules list (pure.ts ruleSentence) — so
 * the builder can show what it will save while it is edited. Each hold also names the campaigns its changes land on
 * (`holds[].campaigns`), from the changes already judged here; the split of the rule's whole scope is the list's (read.ts),
 * not read again here.
 */
import prisma from '../../../db.js'
import { campaignsReachedBy, type ReachRule } from '../ads-rule-reach.service.js'
import { actionOutcome, ARCHIVED_ADS_DOMAIN, HOLDS, isBidRule, ruleSentence, type ActionOutcome, type Hold, type PreviewMove } from './pure.js'
import { BRAIN_ROW_ID, campaignGate, gateFacts, RefBook, type CampaignGate, type Ref } from './read.js'

export interface PreviewBody {
  /** A saved rule to preview; its stored body unless the fields below replace parts of it. */
  ruleId?: string
  actions?: unknown
  conditions?: unknown
  scopeMarketplace?: string | null
  scopePortfolioId?: string | null
  /** Rows in `sample` (default 20, max 100). */
  limit?: number
}

export interface PreviewSample {
  target: Ref | null
  adGroup: Ref | null
  campaign: Ref | null
  /** A bid (fromCents → toCents) or a keyword's state (from → to: ENABLED, PAUSED). */
  field: 'bid' | 'state'
  fromCents?: number | null
  toCents?: number | null
  from?: string | null
  to?: string | null
  /** What would stop the rule's own change there; null when it would go through. */
  held: PreviewHeld | null
  /** The same in the page's words: a chip `label` and a one-line `reason`; null when it would go through. */
  heldBy: Hold | null
}

export type PreviewHeld = Exclude<CampaignGate, 'open'>

/** The words of each `held`, in the order the page lists them. */
export const PREVIEW_HOLDS: Readonly<Record<PreviewHeld, () => Hold>> = {
  brain: HOLDS.previewBrain,
  brainStopped: HOLDS.previewBrainOff,
  locked: HOLDS.previewLocked,
  market: HOLDS.previewMarket,
}

export interface PreviewResult {
  ruleId: string | null
  saved: boolean
  /** The body in one line, as the rules list says it: "If ACoS > 20 % over 14 d → bid toward 20 %". */
  sentence: string
  /** Which engine answered: the builder's draft pipeline or the saved rule's Simulate. */
  engine: 'draft' | 'simulate'
  /** Changes the rule itself would make now: the listed ones that would go through, plus `unsampled`. */
  wouldChange: number
  /** Changes a handler counted without listing them (rank defense's keywords, target ACoS beyond its sample of 5). */
  unsampled: number
  /** Changes on campaigns the bid brain owns: inputs to the brain, not writes. */
  brainInputs: number
  /** Changes the write gate would refuse (locked campaigns, markets without Amazon's limits, a stopped brain). */
  locked: number
  /**
   * The held changes counted per hold, only those with any ("Brain decides 2 · Locked 1"): the `brain` count is
   * `brainInputs`, the others add up to `locked`.
   */
  holds: Array<Hold & { held: PreviewHeld; count: number; campaigns: Ref[] }>
  matched: number
  noChange: number
  refused: number
  /** The rule's daily match cap is used today: a Simulate stops there (no change shown past it). */
  capped: boolean
  windowDays: number | null
  sample: PreviewSample[]
  /** One short word when nothing could be judged. */
  note: string | null
}

export type PreviewAnswer = { data: PreviewResult } | { error: string; status: 400 | 404 }

const DRAFT_KEYS = ['actions', 'conditions', 'scopeMarketplace', 'scopePortfolioId'] as const

interface Move extends PreviewMove { campaignId: string | null }

export async function previewBidRuleBody(body: PreviewBody): Promise<PreviewAnswer> {
  const limit = Math.min(100, Math.max(1, Math.round(Number(body.limit ?? 20)) || 20))
  if (body.ruleId === BRAIN_ROW_ID) return { error: 'The brain has no rule body to preview: its what-if view shows what it would set.', status: 400 }
  const edited = DRAFT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body, k))

  let rule: { id: string; trigger: string; actions: unknown; conditions: unknown; scopeMarketplace: string | null; scopePortfolioId: string | null; scopeCampaignId: string | null; scopeProductId: string | null } | null = null
  if (body.ruleId) {
    const found = await prisma.automationRule.findUnique({
      where: { id: body.ruleId },
      select: { id: true, domain: true, trigger: true, actions: true, conditions: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true },
    })
    if (!found || (found.domain !== 'advertising' && found.domain !== ARCHIVED_ADS_DOMAIN) || !isBidRule(found.actions)) return { error: `No bid rule ${body.ruleId} in this business.`, status: 404 }
    rule = found
  }
  const draft = {
    actions: body.actions !== undefined ? body.actions : rule?.actions,
    conditions: body.conditions !== undefined ? body.conditions : rule?.conditions,
    scopeMarketplace: body.scopeMarketplace !== undefined ? body.scopeMarketplace : rule?.scopeMarketplace ?? null,
    scopePortfolioId: body.scopePortfolioId !== undefined ? body.scopePortfolioId : rule?.scopePortfolioId ?? null,
  }
  if (!Array.isArray(draft.actions) || !draft.actions.length) return { error: 'Send the rule body (actions, conditions) or a saved ruleId.', status: 400 }
  if (!isBidRule(draft.actions)) return { error: 'Not a bid rule: its actions set no bid and pause or unpause no keyword.', status: 400 }
  const slug = String((draft.actions[0] as { type?: unknown } | undefined)?.type ?? '')

  const outcomes: ActionOutcome[] = []
  let matched = 0
  let capped = false
  let windowDays: number | null = null
  let engine: PreviewResult['engine'] = 'draft'
  let note: string | null = null

  if (slug === 'bid') {
    interface BidCtx { marketplace: string | null; campaign: { id: string; name: string }; adTarget: { id: string } }
    const { runDraftPreview } = await import('../ads-rule-preview.service.js')
    const { buildTargetPerformanceContexts } = await import('../../../jobs/advertising-rule-evaluator.job.js')
    const run = await runDraftPreview<BidCtx>(draft, {
      slug: 'bid',
      handler: 'bid_apply',
      handlerOf: (action) => String(action.type ?? 'bid_apply'),
      defaultWindowDays: 14,
      buildContexts: (days) => buildTargetPerformanceContexts(days) as unknown as Promise<unknown[]>,
      entityId: (ctx) => ({ key: 'adTargetId', value: ctx.adTarget.id }),
      // The evaluator's scope: a Bid rule with no campaign picked is not bound to a list (builderScopeCampaignIds → null)
      // and bid_apply reads an empty picker as every campaign — it runs on its whole market.
      emptyPickMeansScope: true,
    })
    if (!run.ok) {
      return { error: run.untranslatable?.length ? `The rule reads metrics the engine cannot: ${run.untranslatable.join(', ')}.` : `The rule could not be previewed (${run.error ?? 'unknown'}).`, status: 400 }
    }
    windowDays = run.census.windowDays
    matched = run.census.matched
    if (!Array.isArray(draft.conditions) || draft.conditions.length === 0) note = 'No criteria'
    for (const { action, res } of run.settled) outcomes.push(actionOutcome({ type: String(action.type ?? ''), ...(res ?? { ok: false, error: 'the handler threw' }) }))
  } else {
    if (!rule || edited) return { error: 'Only a rule from the bid builder previews unsaved changes; save this rule, then preview it.', status: 400 }
    engine = 'simulate'
    const { simulateOneRule } = await import('../../../jobs/advertising-rule-evaluator.job.js')
    const out = await simulateOneRule(rule.id)
    if (!out.ok) return { error: `The rule could not be simulated (${out.error ?? 'unknown'}).`, status: out.error === 'not_found' ? 404 : 400 }
    for (const r of out.results ?? []) {
      if (r.status === 'CAP_EXCEEDED') { capped = true; continue }
      if (!r.matched) continue
      matched++
      for (const a of r.actions) outcomes.push(actionOutcome(a))
    }
  }

  // Sum the outcomes: an account-wide answer repeated by every context is counted once; a keyword moved twice, once.
  const seen = new Set<string>()
  const once = new Set<string>()
  let moves: Move[] = []
  let unsampled = 0, brainAsked = 0, noChange = 0, refused = 0
  for (const o of outcomes) {
    if (o.onceKey) { if (once.has(o.onceKey)) continue; once.add(o.onceKey) }
    unsampled += o.counted
    brainAsked += o.brain
    noChange += o.noChange
    refused += o.refused
    for (const m of o.moves) {
      const key = `${m.targetId ?? ''}:${m.adGroupId ?? ''}:${m.field}`
      if (seen.has(key)) continue
      seen.add(key)
      moves.push({ ...m, campaignId: null })
    }
  }

  const book = new RefBook()
  await book.load({ targets: moves.map((m) => m.targetId ?? ''), adGroups: moves.map((m) => m.adGroupId ?? '') })
  for (const m of moves) {
    m.campaignId = m.targetId ? book.campaignOfTarget(m.targetId) : m.adGroupId ? book.campaignOfAdGroup(m.adGroupId) : null
    // lower_bid_to_floor says only the floor: the bid now is the keyword's.
    if (m.field === 'bid' && m.fromCents == null && m.targetId) m.fromCents = book.targets.get(m.targetId)?.bidCents ?? null
  }
  const before = moves.length
  moves = moves.filter((m) => m.field !== 'bid' || m.fromCents == null || m.fromCents !== m.toCents)
  noChange += before - moves.length

  // A saved rule's own scope below the market (one campaign, a product line) — the evaluator's matcher, as the tick runs it.
  if (rule && (rule.scopeCampaignId || rule.scopeProductId)) {
    const reached = await campaignsReachedBy([{ ...rule, ...draft } as unknown as ReachRule])
    const allowed = new Set((reached.byRule.get(rule.id) ?? []).map((c) => c.id))
    moves = moves.filter((m) => m.campaignId && allowed.has(m.campaignId))
  }

  const gate = await gateFacts(book)
  const samples: PreviewSample[] = moves.map((m) => {
    const where = m.campaignId ? campaignGate(m.campaignId, book, gate) : 'locked'
    return {
      target: m.targetId ? book.targetRef(m.targetId) : null,
      adGroup: m.targetId ? book.adGroupRef(book.targets.get(m.targetId)?.adGroupId ?? '') : m.adGroupId ? book.adGroupRef(m.adGroupId) : null,
      campaign: m.campaignId ? book.campaignRef(m.campaignId) : null,
      field: m.field,
      ...(m.field === 'bid' ? { fromCents: m.fromCents ?? null, toCents: m.toCents ?? null } : { from: m.from ?? null, to: m.to ?? null }),
      held: where === 'open' ? null : where,
      heldBy: where === 'open' ? null : PREVIEW_HOLDS[where](),
    }
  })
  const size = (s: PreviewSample) => (s.field === 'bid' ? Math.abs((s.toCents ?? 0) - (s.fromCents ?? 0)) : 0)
  // The rule's own changes first, then the biggest.
  samples.sort((a, b) => Number(a.held != null) - Number(b.held != null) || size(b) - size(a) || (a.target?.name ?? '').localeCompare(b.target?.name ?? ''))

  return {
    data: {
      ruleId: rule?.id ?? null,
      saved: !!rule && !edited,
      // A builder body reads its blocks; a saved engine rule its conditions or its trigger (an unsaved one is refused above).
      sentence: ruleSentence({ trigger: rule?.trigger ?? null, conditions: draft.conditions, actions: draft.actions }),
      engine,
      wouldChange: samples.filter((s) => s.held == null).length + unsampled,
      unsampled,
      brainInputs: samples.filter((s) => s.held === 'brain').length + brainAsked,
      locked: samples.filter((s) => s.held != null && s.held !== 'brain').length,
      holds: (Object.keys(PREVIEW_HOLDS) as PreviewHeld[])
        .map((held) => {
          const here = samples.filter((s) => s.held === held)
          const campaigns = [...new Map(here.flatMap((s) => (s.campaign ? [[s.campaign.id, s.campaign] as const] : []))).values()].sort((a, b) => a.name.localeCompare(b.name))
          return { ...PREVIEW_HOLDS[held](), held, count: here.length + (held === 'brain' ? brainAsked : 0), campaigns }
        })
        .filter((h) => h.count > 0),
      matched,
      noChange,
      refused,
      capped,
      windowDays,
      sample: samples.slice(0, limit),
      note,
    },
  }
}
