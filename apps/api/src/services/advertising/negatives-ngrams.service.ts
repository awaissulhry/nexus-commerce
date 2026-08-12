/**
 * NEG.6 — wasteful words: which words waste money across the whole account, and what negating one
 * would actually catch.
 *
 * The n-gram surface has existed and worked since AX.11. It was orphaned on `/marketing/advertising/ngrams`
 * with two tables, no scope, and no action. This service is the difference between a report and
 * something an operator can act on without hurting themselves.
 *
 * ── 🔴 The measurement that changed the design ───────────────────────────────────────────────
 *
 * `NgramRow.terms` IS NOT what a phrase negation would block. The tokenizer strips stop words
 * BEFORE building 2-grams, so "giacca moto con protezioni" produces the gram `moto protezioni`
 * even though those two words are not adjacent in the query. Measured 2026-08-12, 60 days:
 *
 *     moto protezioni   NgramRow.terms 61   ·   queries actually containing the phrase 13
 *
 * A 4.7× overstatement, on the exact number the confirm dialog quotes to justify the write. Every
 * row here therefore carries `catches`, counted by **contiguous token match** — Amazon's own
 * negative-phrase semantics — and `terms` is not exposed to the UI at all.
 *
 * ── 🔴 The safety rail that is tautological at one strictness and load-bearing at the other ──
 *
 * "Wasteful" is DEFINED as aggregate orders = 0, so a **token-matched** converting term cannot
 * exist for a wasteful gram: at that strictness the check is a tautology and its zero proves
 * nothing. It is therefore run on the **loose** (substring) set, which is the only reading that can
 * ever fire — and it does. Measured 2026-08-13:
 *
 *     alpinestar   31 token / 65 loose   →  "veste moto alpinestars"        1 order, €87.50
 *     aa           30 token / 53 loose   →  "motorrad jacke herren sommer aaa" + 1 more, €91.09 each
 *
 * Both are also caught by the collision rail, but only this one carries the money, which is the
 * number that actually persuades. What proves the join RAN, rather than returned nothing, is
 * `catches` being non-zero — which is why it is on the row and why a zero there blocks the action.
 *
 * ── The four rails ───────────────────────────────────────────────────────────────────────────
 *
 *   1. winning-gram collision — 2 today (`alpinestar` ⊂ `moto alpinestars` ROAS 15.9, `aa` ⊂ `aaa`
 *      ROAS 13.1). BLOCKS the action, with the reason, rather than warning.
 *   2. converting terms — listed with their sales; blocks if any. Structurally zero, stated as such.
 *   3. protected-term collision — `xavia` is both the top winning gram AND protected. BLOCKS.
 *   4. the gram floor — min length 3, min 5 catching terms, and not ASIN-shaped. `aa` (2 chars,
 *      30 terms) fails on length; `b0cy2s7zgy` and `b092qrxwzn` fail as ASINs.
 *
 * Read-only apart from `negateGram`, which routes through `createNegative` — the same gate, the
 * same idempotency probe, the same evidence stamp NEG.3 and HV.4 established. Nothing new.
 */

import prisma from '../../db.js'
import { analyzeNgrams, type NgramRow } from './ads-ngram.service.js'
import { normaliseNegTerm, resolveNegScope, NEG_MARKETS, NEG_MARKET_ALL, type NegScopeRequest, type NegGrain } from './negatives.service.js'

const WINDOWS = [30, 60, 120] as const
const DEFAULT_WINDOW = 60
/** €3. The floor `analyzeNgrams` has always used; on screen because it decides what an operator sees. */
const MIN_COST_CENTS = 300

/** §6.4 — the floor an actionable gram must clear. Every value is stated on screen. */
export const GRAM_FLOOR = {
  /** `aa` is 2 characters and reaches 30 terms — a term count alone would not have caught it. */
  minChars: 3,
  /** two grams below this today are ASIN strings the tokenizer treated as words. */
  minCatches: 5,
}
/** B0-prefixed 10-char alphanumerics: a product id, not a word. Negating one as a keyword is nonsense. */
const ASIN_RE = /^b0[a-z0-9]{8}$/i
/** §5 — a catalogue gap, not waste. Labelled, never ranked as waste. */
const SIZE_RE = /^(\d+(xl|xs)|x{2,}l|taglia|talla|size|grande|grosse|große)$/i

/**
 * Amazon negative-PHRASE semantics: the gram's tokens must appear as a contiguous run.
 *
 * Deliberately stricter than `includes()`, which also matches inside words — `includes` counts
 * `alpinestars` as a hit for `alpinestar`. Using the strict form for the ACTION's count and the
 * loose form for the WARNINGS means we never understate a risk and never overstate a reach.
 */
export function tokenPhraseMatch(query: string, gram: string): boolean {
  const q = normaliseNegTerm(query).split(' ').filter(Boolean)
  const g = normaliseNegTerm(gram).split(' ').filter(Boolean)
  if (!g.length || g.length > q.length) return false
  for (let i = 0; i + g.length <= q.length; i++) {
    let ok = true
    for (let j = 0; j < g.length; j++) if (q[i + j] !== g[j]) { ok = false; break }
    if (ok) return true
  }
  return false
}

export type BlockReason = 'winning-collision' | 'converting-terms' | 'protected-term' | 'below-floor' | 'no-ad-groups' | 'not-allowlisted'

export interface GramCollision { gram: string; roas: number; salesCents: number }
export interface GramConvertingTerm { term: string; orders: number; salesCents: number }

export interface WastefulGram {
  gram: string
  n: 1 | 2
  costCents: number
  clicks: number
  impressions: number
  /** 🔴 contiguous-token matches — what a phrase negation actually blocks. NOT `NgramRow.terms`. */
  catches: number
  /** the loose count, for comparison. Larger than `catches` whenever a longer word contains the gram. */
  catchesLoose: number
  /** distinct ad groups the catching queries ran in — one write per ad group */
  adGroups: number
  /** of those, how many sit in a campaign on the live-write allowlist */
  adGroupsWritable: number
  /** ad groups that already carry this exact phrase as a negative — the write would skip them */
  adGroupsAlreadyNegated: number
  /** negated phrases anywhere in the account that CONTAIN this gram — context, not coverage */
  inNegatedPhrases: number
  /** true when the whole gram is itself already a negated term somewhere */
  negatedAsWholeTerm: boolean
  /** §5 — a size token is a catalogue gap; labelled, and sorted below real waste */
  isSizeToken: boolean
  isAsinShaped: boolean
  marketSplit: Array<{ market: string; costCents: number }>
  /**
   * The highest-spending queries this gram actually catches — capped at 8, with `catches` as the
   * true total beside it. These are real search terms, so each one can open NEG.2's drawer; the
   * GRAM cannot, because a gram is not a term and `?focus=protezioni` would open an empty drawer
   * for a term that was never negated.
   */
  sampleTerms: Array<{ term: string; clicks: number; costCents: number; orders: number }>
  /** the four rails, resolved */
  blockedBy: BlockReason[]
  collisions: GramCollision[]
  convertingTerms: GramConvertingTerm[]
  protectedBy: Array<{ term: string; matchType: string }>
  actionable: boolean
}

export interface WinningGram {
  gram: string
  n: 1 | 2
  roas: number | null
  acos: number | null
  costCents: number
  salesCents: number
  orders: number
  clicks: number
  /** true when this gram is also a protected term — `xavia` is both, and that agreement is the point */
  isProtected: boolean
}

export interface WastefulWordsPayload {
  scope: {
    boundBy: NegGrain
    market: string
    /** 🔴 whether the n-gram numbers below are actually narrowed, and by what */
    filtered: boolean
    filterLabel: string | null
    campaignsInScope: number
  }
  window: { days: number; since: string; minCostCents: number }
  floor: { minChars: number; minCatches: number }
  wasteful: WastefulGram[]
  winning: WinningGram[]
  totals: {
    wastefulShown: number
    winningShown: number
    /** 🔴 NOT a sum of the spend column — grams overlap and their spend double-counts. */
    actionable: number
    blocked: number
    sizeTokens: number
    alreadyNegated: number
  }
  /**
   * 🔴 Real counts of what was read. An empty wasteful list would read as "no waste", the most
   * reassuring possible lie, and a failed query produces exactly that.
   */
  coverage: { searchTermRows: number; distinctQueries: number; negationRows: number }
}

export interface WastefulWordsRequest extends NegScopeRequest {
  window?: number | null
}

export async function getWastefulWords(req: WastefulWordsRequest): Promise<WastefulWordsPayload> {
  const windowDays = WINDOWS.includes(Number(req.window) as (typeof WINDOWS)[number]) ? Number(req.window) : DEFAULT_WINDOW
  const since = new Date(Date.now() - windowDays * 86400_000)

  const [campaigns, negAdGroups, products, ads] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, externalCampaignId: true, liveBidWritesEnabled: true }, orderBy: { name: 'asc' } }),
    prisma.adGroup.findMany({ where: { targets: { some: { isNegative: true } } }, select: { id: true, name: true, campaignId: true } }),
    req.line ? prisma.product.findMany({ select: { id: true, parentId: true } }) : Promise.resolve([]),
    req.line ? prisma.adProductAd.findMany({ where: { productId: { not: null } }, select: { productId: true, adGroup: { select: { campaignId: true } } } }) : Promise.resolve([]),
  ])
  const scope = resolveNegScope(
    { campaigns, adGroups: negAdGroups, products, ads: ads.map((a) => ({ productId: a.productId, campaignId: a.adGroup?.campaignId ?? '' })).filter((a) => a.campaignId) },
    req,
  )

  // 🔴 local → EXTERNAL. `AmazonAdsSearchTerm` stores Amazon's ids; passing local ones returns zero
  // rows forever and is indistinguishable from a quiet account.
  const byLocalId = new Map(campaigns.map((c) => [c.id, c]))
  const scopeExternalCampaigns = scope.boundBy === 'market'
    ? null
    : scope.campaignIds.map((id) => byLocalId.get(id)?.externalCampaignId).filter((x): x is string => !!x)

  const marketFilter = req.market && req.market !== NEG_MARKET_ALL ? req.market : null
  const filterLabel = [
    marketFilter,
    scope.boundBy !== 'market' ? `${scope.campaignIds.length} campaign${scope.campaignIds.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ') || null

  const ng = await analyzeNgrams({
    windowDays,
    minCostCents: MIN_COST_CENTS,
    marketplace: marketFilter,
    campaignIds: scopeExternalCampaigns,
  })

  // The rows behind the grams, at the grain a write needs: (query × ad group).
  const st = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'adGroupId', 'campaignId', 'marketplace'],
    where: {
      date: { gte: since },
      ...(marketFilter ? { marketplace: marketFilter } : {}),
      ...(scopeExternalCampaigns ? { campaignId: { in: scopeExternalCampaigns } } : {}),
    },
    _sum: { clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })

  const negs = await prisma.adTarget.findMany({
    where: { isNegative: true },
    select: { expressionValue: true, adGroup: { select: { externalAdGroupId: true } } },
  })
  const negTermSet = new Set(negs.map((n) => normaliseNegTerm(n.expressionValue ?? '')).filter(Boolean))
  const negByTerm = new Map<string, Set<string>>()
  for (const n of negs) {
    const k = normaliseNegTerm(n.expressionValue ?? '')
    const ag = n.adGroup?.externalAdGroupId
    if (!k || !ag) continue
    const s = negByTerm.get(k) ?? new Set<string>()
    s.add(ag)
    negByTerm.set(k, s)
  }

  const protections = await prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' } })
  const protectionHits = (text: string) => {
    const t = normaliseNegTerm(text)
    return protections.filter((p) => {
      const pt = normaliseNegTerm(p.term)
      const mode = p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')
      if (mode === 'CONTAINS') return t.includes(pt)
      if (mode === 'PREFIX') return t.startsWith(pt)
      return t === pt
    }).map((p) => ({ term: p.term, matchType: p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT') }))
  }

  const extCampaign = new Map(campaigns.filter((c) => c.externalCampaignId).map((c) => [c.externalCampaignId as string, c]))
  const distinctQueries = new Set(st.map((r) => r.query)).size

  const winning: WinningGram[] = ng.winning.map((w) => ({
    gram: w.gram, n: w.n, roas: w.roas, acos: w.acos,
    costCents: w.costCents, salesCents: w.salesCents, orders: w.orders, clicks: w.clicks,
    isProtected: protectionHits(w.gram).length > 0,
  }))

  const buildWasteful = (w: NgramRow): WastefulGram => {
    const key = normaliseNegTerm(w.gram)
    const hits = st.filter((r) => tokenPhraseMatch(r.query, w.gram))
    const looseHits = st.filter((r) => normaliseNegTerm(r.query).includes(key))
    const catches = new Set(hits.map((r) => r.query)).size
    const catchesLoose = new Set(looseHits.map((r) => r.query)).size

    const ags = new Map<string, string>()
    for (const r of hits) ags.set(r.adGroupId, r.campaignId)
    let writable = 0
    for (const [, cid] of ags) if (extCampaign.get(cid)?.liveBidWritesEnabled) writable++
    const alreadyIn = negByTerm.get(key) ?? new Set<string>()
    let alreadyNegated = 0
    for (const ag of ags.keys()) if (alreadyIn.has(ag)) alreadyNegated++

    // 🔴 The converting check, run on the LOOSE set on purpose. On the strict set it is a tautology
    // (wasteful ⇒ 0 orders), so only the loose set can ever surface anything, and it is the loose
    // set that a plural or a compounded word would hide in.
    const convertingTerms: GramConvertingTerm[] = []
    const seen = new Set<string>()
    for (const r of looseHits) {
      const o = r._sum.orders7d ?? 0
      if (o <= 0 || seen.has(r.query)) continue
      seen.add(r.query)
      convertingTerms.push({ term: r.query, orders: o, salesCents: r._sum.sales7dCents ?? 0 })
    }
    convertingTerms.sort((a, b) => b.salesCents - a.salesCents)

    // Rail 1 — a wasteful gram contained in a winning gram.
    const collisions: GramCollision[] = ng.winning
      .filter((win) => {
        const wg = normaliseNegTerm(win.gram)
        return wg !== key && wg.includes(key)
      })
      .map((win) => ({ gram: win.gram, roas: win.roas ?? 0, salesCents: win.salesCents }))

    const protectedBy = protectionHits(w.gram)
    const bare = w.gram.replace(/\s+/g, '')
    const isAsin = w.gram.split(/\s+/).some((t) => ASIN_RE.test(t))
    const isSize = w.gram.split(/\s+/).some((t) => SIZE_RE.test(t))

    const marketMap = new Map<string, number>()
    for (const r of hits) marketMap.set(r.marketplace, (marketMap.get(r.marketplace) ?? 0) + Math.round(Number(r._sum.costMicros ?? 0n) / 10000))

    // The terms behind the gram, folded from (query × ad group) to one row per query.
    const perQuery = new Map<string, { term: string; clicks: number; costCents: number; orders: number }>()
    for (const r of hits) {
      const prev = perQuery.get(r.query) ?? { term: r.query, clicks: 0, costCents: 0, orders: 0 }
      prev.clicks += r._sum.clicks ?? 0
      prev.costCents += Math.round(Number(r._sum.costMicros ?? 0n) / 10000)
      prev.orders += r._sum.orders7d ?? 0
      perQuery.set(r.query, prev)
    }
    const sampleTerms = [...perQuery.values()].sort((a, b) => b.costCents - a.costCents).slice(0, 8)

    const blockedBy: BlockReason[] = []
    if (bare.length < GRAM_FLOOR.minChars || isAsin || catches < GRAM_FLOOR.minCatches) blockedBy.push('below-floor')
    if (collisions.length > 0) blockedBy.push('winning-collision')
    if (convertingTerms.length > 0) blockedBy.push('converting-terms')
    if (protectedBy.length > 0) blockedBy.push('protected-term')
    if (ags.size === 0) blockedBy.push('no-ad-groups')
    else if (writable === 0) blockedBy.push('not-allowlisted')

    return {
      gram: w.gram, n: w.n,
      costCents: w.costCents, clicks: w.clicks, impressions: w.impressions,
      catches, catchesLoose,
      adGroups: ags.size, adGroupsWritable: writable, adGroupsAlreadyNegated: alreadyNegated,
      inNegatedPhrases: [...negTermSet].filter((t) => t.includes(key)).length,
      negatedAsWholeTerm: negTermSet.has(key),
      isSizeToken: isSize, isAsinShaped: isAsin,
      marketSplit: [...marketMap].map(([market, costCents]) => ({ market, costCents })).sort((a, b) => b.costCents - a.costCents),
      sampleTerms,
      blockedBy, collisions, convertingTerms, protectedBy,
      actionable: blockedBy.length === 0,
    }
  }

  const wasteful = ng.wasteful.map(buildWasteful)
  // Real waste first, size tokens last — they are a catalogue gap and ranking them as waste
  // invites exactly the wrong action (§5).
  wasteful.sort((a, b) => (a.isSizeToken ? 1 : 0) - (b.isSizeToken ? 1 : 0) || b.costCents - a.costCents)

  return {
    scope: {
      boundBy: scope.boundBy,
      market: req.market,
      filtered: !!(marketFilter || scopeExternalCampaigns),
      filterLabel,
      campaignsInScope: scope.campaignIds.length,
    },
    window: { days: windowDays, since: since.toISOString(), minCostCents: MIN_COST_CENTS },
    floor: { minChars: GRAM_FLOOR.minChars, minCatches: GRAM_FLOOR.minCatches },
    wasteful,
    winning,
    totals: {
      wastefulShown: wasteful.length,
      winningShown: winning.length,
      actionable: wasteful.filter((w) => w.actionable).length,
      blocked: wasteful.filter((w) => !w.actionable).length,
      sizeTokens: wasteful.filter((w) => w.isSizeToken).length,
      alreadyNegated: wasteful.filter((w) => w.negatedAsWholeTerm).length,
    },
    coverage: { searchTermRows: st.length, distinctQueries, negationRows: negs.length },
  }
}

// ── The one write ─────────────────────────────────────────────────────────────────────────────

export interface NegateGramRequest extends NegScopeRequest {
  gram: string
  window?: number | null
  actor: string
}

export interface NegateGramOutcome {
  externalAdGroupId: string
  adGroupName: string
  campaignName: string
  /** 'created' · 'already_existed' · 'refused' · 'failed' — never a bare boolean */
  outcome: 'created' | 'already_existed' | 'refused' | 'failed'
  reason: string | null
  externalNegativeKeywordId: string | null
}

export interface NegateGramResult {
  ok: boolean
  gram: string
  /** refused BEFORE any Amazon call, with the rail that refused it */
  blockedBy: BlockReason[] | null
  error: string | null
  code: string | null
  outcomes: NegateGramOutcome[]
  summary: { created: number; alreadyExisted: number; refused: number; failed: number }
}

/**
 * One gram, as a NEGATIVE PHRASE, in every in-scope ad group it was measured in.
 *
 * 🔴 Re-runs the whole rail set server-side before writing anything. The UI blocking the button is
 * a courtesy; this is the enforcement. A stale page, a hand-made request or a gram that became
 * unsafe between render and click all land here.
 *
 * AD_GROUP scope, never CAMPAIGN: measured 2026-08-12, campaign-scoped negatives are 0-for-20 at
 * reaching Amazon while ad-group-scoped are 2,017-of-2,037 (see `ads-harvest.service.ts`).
 */
export async function negateGram(req: NegateGramRequest): Promise<NegateGramResult> {
  const gram = req.gram.trim()
  const empty = { outcomes: [], summary: { created: 0, alreadyExisted: 0, refused: 0, failed: 0 } }
  if (!gram) return { ok: false, gram, blockedBy: null, error: 'gram is required', code: 'gram_required', ...empty }

  const page = await getWastefulWords({ ...req, window: req.window })
  const row = page.wasteful.find((w) => normaliseNegTerm(w.gram) === normaliseNegTerm(gram))
  if (!row) {
    return {
      ok: false, gram, blockedBy: null,
      error: `“${gram}” is not a wasteful gram in this window and scope, so there is nothing measured to act on`,
      code: 'gram_not_found', ...empty,
    }
  }
  if (!row.actionable) {
    return { ok: false, gram, blockedBy: row.blockedBy, error: `“${gram}” is blocked by ${row.blockedBy.join(', ')}`, code: 'blocked', ...empty }
  }

  const since = new Date(Date.now() - page.window.days * 86400_000)
  const st = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'adGroupId', 'campaignId'],
    where: { date: { gte: since } },
    _sum: { clicks: true },
  })
  const targets = new Map<string, string>()
  for (const r of st) if (tokenPhraseMatch(r.query, gram)) targets.set(r.adGroupId, r.campaignId)

  const [campaigns, adGroups, connections] = await Promise.all([
    prisma.campaign.findMany({ where: { externalCampaignId: { in: [...new Set(targets.values())] } }, select: { name: true, externalCampaignId: true, marketplace: true, liveBidWritesEnabled: true } }),
    prisma.adGroup.findMany({ where: { externalAdGroupId: { in: [...targets.keys()] } }, select: { name: true, externalAdGroupId: true } }),
    // Per MARKETPLACE, exactly as `ads-harvest.service.ts:213` resolves it. One profile per market.
    prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { profileId: true, marketplace: true } }),
  ])
  const cByExt = new Map(campaigns.map((c) => [c.externalCampaignId as string, c]))
  const agName = new Map(adGroups.map((a) => [a.externalAdGroupId as string, a.name]))
  const connByMarket = new Map(connections.map((c) => [c.marketplace, c.profileId]))

  if (connections.length === 0) {
    return { ok: false, gram, blockedBy: null, error: 'no active Amazon Ads connection — nothing can be written', code: 'no_connection', ...empty }
  }

  const { createNegative } = await import('./ads-negative-kw.service.js')
  const outcomes: NegateGramOutcome[] = []

  for (const [extAdGroupId, extCampaignId] of targets) {
    const c = cByExt.get(extCampaignId)
    const base = { externalAdGroupId: extAdGroupId, adGroupName: agName.get(extAdGroupId) ?? extAdGroupId, campaignName: c?.name ?? extCampaignId }
    if (!c) { outcomes.push({ ...base, outcome: 'failed', reason: 'campaign not found locally', externalNegativeKeywordId: null }); continue }
    // Excluded from the count and stated once, per §7 — never a disabled row.
    if (!c.liveBidWritesEnabled) { outcomes.push({ ...base, outcome: 'refused', reason: `${c.name} is not on the live-write allowlist`, externalNegativeKeywordId: null }); continue }
    const profileId = c.marketplace ? connByMarket.get(c.marketplace) : undefined
    if (!profileId) { outcomes.push({ ...base, outcome: 'refused', reason: `no active Ads connection for ${c.marketplace ?? 'this campaign\'s marketplace'}`, externalNegativeKeywordId: null }); continue }
    try {
      const res = await createNegative({
        profileId,
        externalAdGroupId: extAdGroupId,
        externalCampaignId: extCampaignId,
        keywordText: gram,
        matchType: 'NEGATIVE_PHRASE',
        scope: 'AD_GROUP',
        // 🔴 NEG.0 fixed three callers that hid this behind `as never` and were denied at
        // `connection` before ever reaching the whitelist. It is passed, always.
        marketplace: c.marketplace as string,
      })
      if (res.denied) outcomes.push({ ...base, outcome: 'refused', reason: res.denied.reason, externalNegativeKeywordId: null })
      else if (res.alreadyExisted) outcomes.push({ ...base, outcome: 'already_existed', reason: null, externalNegativeKeywordId: null })
      else outcomes.push({ ...base, outcome: 'created', reason: null, externalNegativeKeywordId: res.externalNegativeKeywordId })
    } catch (e) {
      outcomes.push({ ...base, outcome: 'failed', reason: (e as Error).message, externalNegativeKeywordId: null })
    }
  }

  const summary = {
    created: outcomes.filter((o) => o.outcome === 'created').length,
    alreadyExisted: outcomes.filter((o) => o.outcome === 'already_existed').length,
    refused: outcomes.filter((o) => o.outcome === 'refused').length,
    failed: outcomes.filter((o) => o.outcome === 'failed').length,
  }
  return { ok: true, gram, blockedBy: null, error: null, code: null, outcomes, summary }
}

export { NEG_MARKETS, NEG_MARKET_ALL }
