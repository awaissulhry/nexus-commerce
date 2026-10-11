/**
 * Negative Targeting page (2026-10-11) — POST /advertising/waste/rules/preview: what a waste rule would stop NOW, for a
 * body that is saved or not. Nothing is written: no rule, no run row, no counter, no suggestion, no pause, no negative.
 *
 *   · a stop-waste rule (a page body, or a saved rule whose action carries `stopWaste`): the contexts the tick gives it
 *     (waste-rules/contexts.ts: late-order safe, stock-out days left out, only rows that pass the test), its scope as the
 *     evaluator reads it (market, portfolio, campaign, ONE ad group, product), its conditions, then D1's gate as if it
 *     were on Auto (ads-graduation-stopwaste.ts): a row on the never-list, or past its product's day cap, would ask
 *     instead of acting alone (`alone: false` and why);
 *   · any other saved waste rule (a Bid rule with THEN Pause, a Negative Targeting builder rule, an engine rule): its
 *     Simulate (the evaluator's simulateOneRule — every handler in a dry run), each would-be change read back. Its unsaved
 *     edits cannot be previewed: refused.
 *
 * Every row says its why in words without an amount; the test's numbers ride `test` (money in money keys).
 */
import prisma from '../../../db.js'
import { openStopWasteGate, stopWasteParamsOf, type StopWasteParams } from '../ads-graduation-stopwaste.js'
import { ruleSentence } from '../bid-rules/pure.js'
import { RefBook, type Ref } from '../bid-rules/read.js'
import { adGroupIdentity, adGroupOfContext, buildStopWasteContexts } from './contexts.js'
import { bodyProblems, ruleOfBody, wasteSentence, type StopWasteEvidence, type WasteRuleBody, type WasteScope } from './pure.js'
import { findWasteRule, PSEUDO_ROWS } from './read.js'

export type PreviewAction = 'PAUSE' | 'NEGATE_EXACT' | 'NEGATE_PHRASE' | 'NEGATE_ASIN' | 'TURN_ON'

export interface PreviewRow {
  row: Ref
  campaign: Ref | null
  adGroup: Ref | null
  action: PreviewAction
  /** The test it passed, in words (no amount). */
  why: string
  /** On Auto it would act alone; false: it would ask (the never-list, or its product's day cap) — `asks` says why. */
  alone: boolean
  asks: string | null
  /** The test's numbers (stop-waste rules only); money in money keys. */
  test: StopWasteEvidence | null
}

export interface WastePreview {
  ruleId: string | null
  saved: boolean
  sentence: string
  engine: 'stop-waste' | 'simulate'
  windowDays: number | null
  /** Changes it would make now (alone or asking). */
  wouldChange: number
  /** Of those, the ones that would ask even on Auto. */
  wouldAsk: number
  sample: PreviewRow[]
  /** Matched rows it would not change, each with why (a handler's refusal, a protected term, already done). */
  refused: Array<{ row: Ref; why: string }>
  note: string | null
}

export type PreviewAnswer = { data: WastePreview } | { error: string; status: 400 | 404 }

const ACTION_OF: Record<string, PreviewAction> = { pause_target: 'PAUSE', enable_target: 'TURN_ON', add_negative_exact: 'NEGATE_EXACT', add_negative_phrase: 'NEGATE_PHRASE' }

export async function previewWasteRule(body: { ruleId?: string; rule?: Partial<WasteRuleBody>; limit?: number }): Promise<PreviewAnswer> {
  const limit = Math.min(100, Math.max(1, Math.round(Number(body.limit ?? 20)) || 20))
  if (body.ruleId && PSEUDO_ROWS.has(body.ruleId)) return { error: 'The brain and Harvest have no rule body to preview: their own pages show what they would do.', status: 400 }
  const saved = body.ruleId ? await findWasteRule(body.ruleId) : null
  if (body.ruleId && !saved) return { error: `No waste rule ${body.ruleId} in this business.`, status: 404 }
  const savedScope: WasteScope | null = saved ? {
    marketplace: saved.scopeMarketplace, portfolioId: saved.scopePortfolioId, campaignId: saved.scopeCampaignId, adGroupId: saved.scopeAdGroupId, productId: saved.scopeProductId,
  } : null
  const savedParams = saved ? stopWasteParamsOf(saved.actions) : null

  if (body.rule || savedParams) {
    // A body (new, or an edit of a saved stop-waste rule over its own settings), or a saved stop-waste rule as stored.
    let rule: { actions: unknown; conditions: unknown; trigger: string }
    let scope: WasteScope
    if (body.rule) {
      const from = saved && savedParams ? { kind: savedParams.kind, scope: savedScope ?? {}, windowDays: savedParams.windowDays, minClicks: savedParams.minClicks, cpaMultiple: savedParams.cpaMultiple, spendFloorCents: savedParams.spendFloorCents } : {}
      if (saved && !savedParams) return { error: 'Only a stop-waste rule previews unsaved changes here; save this rule, then preview it.', status: 400 }
      const merged = { ...from, ...body.rule } as WasteRuleBody
      const problems = bodyProblems(merged)
      if (problems.length) return { error: problems.join('; '), status: 400 }
      const r = ruleOfBody(merged)
      rule = { actions: r.actions, conditions: r.conditions, trigger: r.trigger }
      scope = merged.scope ?? {}
    } else {
      rule = { actions: saved!.actions, conditions: saved!.conditions, trigger: saved!.trigger }
      scope = savedScope!
    }
    return { data: await stopWastePreview(saved?.id ?? null, !!saved && !body.rule, rule, scope, limit) }
  }
  if (!saved) return { error: 'Send a rule body (kind, scope, test) or a saved ruleId.', status: 400 }
  return { data: await simulatePreview(saved.id, { actions: saved.actions, conditions: saved.conditions, trigger: saved.trigger }, limit) }
}

/** A stop-waste rule's preview: its own contexts, its scope, its conditions, then D1's gate as if on Auto. */
async function stopWastePreview(ruleId: string | null, saved: boolean, rule: { actions: unknown; conditions: unknown; trigger: string }, scope: WasteScope, limit: number): Promise<WastePreview> {
  const params = stopWasteParamsOf(rule.actions) as StopWasteParams
  const contexts = await buildStopWasteContexts(params)
  const inScope = await scopeFilter(contexts, scope)
  const { evaluateConditions } = await import('../../automation/conditions-tree.js')
  const matched = inScope.filter((ctx) => evaluateConditions((rule.conditions ?? null) as never, ctx))
  const gate = await openStopWasteGate([{ id: 'preview', actions: rule.actions, conditions: rule.conditions }], { asIfAuto: true })
  const a0 = (Array.isArray(rule.actions) ? rule.actions[0] : {}) as { type?: string }
  const book = new RefBook()
  const ids = await adGroupIdentity(matched)
  await book.load({ adGroups: matched.map((c) => adGroupOfContext(c, ids) ?? ''), targets: matched.map((c) => String((c as { adTarget?: { id?: string } }).adTarget?.id ?? '')) })
  const rows: PreviewRow[] = []
  for (const ctx of matched) {
    const c = ctx as { adTarget?: { id: string; expressionValue?: string }; searchTerm?: { query: string }; stopWaste: StopWasteEvidence }
    const groupId = adGroupOfContext(ctx, ids)
    const group = groupId ? book.adGroupRef(groupId) : null
    const campaignId = groupId ? book.campaignOfAdGroup(groupId) : null
    // As if on Auto: the never-list, and the product's day cap reserved change by change (nothing is ever settled here).
    const split = gate ? await gate.split(['preview'], ctx) : { act: ['preview'], ask: [], product: null }
    const asks = split.ask[0]?.why ?? null
    const isAsin = /^b0[a-z0-9]{8}$/i.test((c.searchTerm?.query ?? '').trim())
    rows.push({
      row: c.adTarget ? book.targetRef(c.adTarget.id) : { id: `term:${(ctx as { marketplace?: string }).marketplace ?? ''}|${(ctx as { searchTerm?: { externalAdGroupId?: string } }).searchTerm?.externalAdGroupId ?? ''}|${c.searchTerm?.query ?? ''}`, name: c.searchTerm?.query ?? '', ...(group?.href ? { href: `${group.href}?tab=search-terms&focus=${encodeURIComponent(c.searchTerm?.query ?? '')}` } : {}) },
      campaign: campaignId ? book.campaignRef(campaignId) : null,
      adGroup: group,
      action: params.kind === 'PAUSE_KEYWORD' ? 'PAUSE' : isAsin ? 'NEGATE_ASIN' : ACTION_OF[String(a0.type)] ?? 'NEGATE_EXACT',
      why: c.stopWaste.sentence,
      alone: asks == null,
      asks,
      test: c.stopWaste,
    })
  }
  const asked = rows.filter((r) => !r.alone).length
  return {
    ruleId, saved, sentence: wasteSentence(rule, ruleSentence), engine: 'stop-waste', windowDays: params.windowDays,
    wouldChange: rows.length, wouldAsk: asked,
    // The rows that would act alone first, then the biggest spend.
    sample: rows.sort((a, b) => Number(!a.alone) - Number(!b.alone) || (b.test?.spendCents ?? 0) - (a.test?.spendCents ?? 0)).slice(0, limit),
    refused: [],
    note: contexts.length === 0 ? 'Nothing wastes by this test today' : matched.length === 0 ? 'Nothing in its scope' : null,
  }
}

/** The evaluator's scope for a stop-waste preview: market, portfolio, campaign, ONE ad group, product (its line). */
async function scopeFilter(contexts: unknown[], scope: WasteScope): Promise<unknown[]> {
  if (!scope.marketplace && !scope.portfolioId && !scope.campaignId && !scope.adGroupId && !scope.productId) return contexts
  const ids = await adGroupIdentity(contexts)
  const groupIds = [...new Set(contexts.map((c) => adGroupOfContext(c, ids)).filter((g): g is string => !!g))]
  const groups = groupIds.length ? await prisma.adGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, campaignId: true, campaign: { select: { portfolioId: true } } } }) : []
  const groupOf = new Map(groups.map((g) => [g.id, g]))
  let products: Set<string> | null = null
  const productsOf = new Map<string, string[]>()
  if (scope.productId) {
    const { expandProductScope } = await import('../ads-scope-reach.js')
    products = new Set(await expandProductScope(scope.productId))
    const ads = await prisma.adProductAd.findMany({ where: { adGroupId: { in: groupIds }, productId: { in: [...products] } }, select: { adGroupId: true, productId: true } })
    for (const a of ads) productsOf.set(a.adGroupId, [...(productsOf.get(a.adGroupId) ?? []), a.productId as string])
  }
  return contexts.filter((ctx) => {
    const market = (ctx as { marketplace?: string | null }).marketplace ?? null
    if (scope.marketplace && market !== scope.marketplace) return false
    const groupId = adGroupOfContext(ctx, ids)
    const g = groupId ? groupOf.get(groupId) : undefined
    if (scope.adGroupId && groupId !== scope.adGroupId) return false
    if (scope.campaignId && g?.campaignId !== scope.campaignId) return false
    if (scope.portfolioId && g?.campaign?.portfolioId !== scope.portfolioId) return false
    if (products && !(groupId && productsOf.get(groupId)?.length)) return false
    return true
  })
}

/** Any other saved waste rule: its Simulate (every handler in a dry run), each would-be change read back. */
async function simulatePreview(ruleId: string, rule: { actions: unknown; conditions: unknown; trigger: string }, limit: number): Promise<WastePreview> {
  const { simulateOneRule } = await import('../../../jobs/advertising-rule-evaluator.job.js')
  const out = await simulateOneRule(ruleId)
  const sentence = wasteSentence(rule, ruleSentence)
  const base = { ruleId, saved: true, sentence, engine: 'simulate' as const, windowDays: null }
  if (!out.ok) return { ...base, wouldChange: 0, wouldAsk: 0, sample: [], refused: [], note: `It could not be simulated (${out.error ?? 'unknown'})` }
  const book = new RefBook()
  const targets = (out.results ?? []).flatMap((r) => r.actions.map((a) => String(((a.output ?? {}) as { adTargetId?: unknown }).adTargetId ?? '')))
  await book.load({ targets })
  const sample: PreviewRow[] = []
  const refused: WastePreview['refused'] = []
  for (const r of out.results ?? []) {
    if (!r.matched) continue
    for (const a of r.actions) {
      const o = (a.output ?? {}) as Record<string, unknown>
      const action = ACTION_OF[String(a.type ?? '')]
      if (!action) continue
      const row: Ref = typeof o.adTargetId === 'string' ? book.targetRef(o.adTargetId) : { id: String(o.keyword ?? o.adTargetId ?? ''), name: String(o.keyword ?? '') }
      if (a.ok === false) { refused.push({ row, why: String(a.error ?? 'refused') }); continue }
      if (o.skipped || o.noChange) { refused.push({ row, why: typeof o.skipped === 'string' ? o.skipped : 'Already done' }); continue }
      const negWould = Array.isArray(o.outcomes) ? (o.outcomes as Array<{ wouldCreate?: unknown }>).filter((x) => x.wouldCreate).length : null
      if (negWould === 0) { refused.push({ row, why: 'Nothing to add (already negated there, or filtered)' }); continue }
      const groupId = typeof o.adTargetId === 'string' ? book.targets.get(o.adTargetId)?.adGroupId ?? null : null
      sample.push({
        row, adGroup: groupId ? book.adGroupRef(groupId) : null, campaign: groupId ? (() => { const c = book.campaignOfAdGroup(groupId); return c ? book.campaignRef(c) : null })() : null,
        action, why: 'Its trigger and conditions match now (its own window)', alone: false, asks: null, test: null,
      })
    }
  }
  return { ...base, wouldChange: sample.length, wouldAsk: 0, sample: sample.slice(0, limit), refused: refused.slice(0, limit), note: (out.results ?? []).length === 0 ? 'Nothing matches today' : null }
}
