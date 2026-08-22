/**
 * ── SOV-P2 (2026-08-22) — an honest Share-of-Voice preview ────────────────────────────────────
 *
 * 🔴 What the old preview did, clicked on prod before this was written.
 *
 * The SOV builder shared the browser-side `isBidLike` preview with Bid and Keyword Tracker: fetch
 * `/advertising/targets?limit=1500`, keep the rows whose `campaignId` is in the picker, apply
 * `groups[0]`'s THEN op to each one's current bid, clamp, render. On campaign `DE_Auto_Close` with
 * `IF Share of Voice < 5% → Set Bid €0.75` it showed **four rows** — SEARCH_CLOSE_MATCH,
 * SEARCH_LOOSE_MATCH, PRODUCT_COMPLEMENTS, PRODUCT_SUBSTITUTES, each €0.40/0.49 → €0.75 — under
 * the sentence "the new bid each keyword/target in your selected campaigns would get when this
 * rule fires."
 *
 * Every one of those four is `kind: 'AUTO'`. `buildSovBidContexts` selects
 * `where: { kind: 'KEYWORD', isNegative: false }`, so a SOV rule **can never touch any of them**;
 * three were PAUSED as well. Meanwhile the campaign's two real KEYWORD targets were NOT shown,
 * because the endpoint has no `orderBy` and 1,655 of the account's 3,155 positive targets fall
 * outside an arbitrary 1,500. So the panel promised 4 impossible changes and hid 2 possible ones.
 *
 * Four defects, measured account-wide:
 *   1. **kind ignored** — 1,025 of 3,155 positive targets (32.5 %) are a kind the SOV engine can
 *      never select, and **71 of 217** campaigns with previewable targets have ZERO it can act on;
 *   2. **criteria ignored** — no IF condition was applied at all, so every listed target appeared
 *      to match;
 *   3. **multi-block ignored** — only `groups[0]`'s action was ever used, while the engine picks
 *      the first block whose conditions match THIS target;
 *   4. **an arbitrary population** — `limit=1500`, no `orderBy`, filtered client-side.
 *
 * The fix is not better arithmetic in the browser. It is the engine
 * ([[reference_preview_must_run_the_engine]]) — so this calls `runDraftPreview`, the same five
 * stages BUD-PP built and PLC-P2 generalised, with the SOV context builder and `bid_apply`:
 *
 *   real contexts (`buildSovBidContexts` — keyword targets that carry a real market share)
 *     → real scope (`ruleMatchesScope` + the picker list `bid_apply` itself enforces)
 *       → real translation (`maybeTranslateAdsRule`)
 *         → real conditions (`evaluateConditions`, first matching block)
 *           → real action (`ACTION_HANDLERS.bid_apply` with `dryRun`, which clamps and writes nothing)
 *
 * 🔴 And one thing Budget and Placement do not need: **the census states what was never eligible.**
 * A SOV rule can only see ENABLED keyword targets whose query Amazon reported a market total for,
 * on a complete week — 793 of the account's 1,777 enabled positive keyword targets (44.6 %),
 * measured 2026-08-22. A preview that silently showed only the matches would leave the operator
 * believing the other 55 % were considered and rejected, when most were never offered at all.
 * `eligible`, `notEnabled` and `periods` say so on the panel.
 */

import prisma from '../../db.js'
import { runDraftPreview, type BudgetPreviewDraft } from './ads-rule-preview.service.js'
// The ONE definition of "this bid is a suppression". Imported, never re-typed: KT-P2 and this file
// must agree or two previews describe the same 2¢ target differently.
import { KT6_SUPPRESSION_CENTS } from './kt6-bid-action.js'
import { keywordMarketShares, type SovMarketPeriod } from './ads-sov-keyword-share.service.js'

export interface SovPreviewRow {
  adTargetId: string
  /** The keyword text. Never blank — a SOV context is always a KEYWORD target. */
  keyword: string
  matchType: string | null
  campaign: string
  marketplace: string | null
  status: string | null
  /** The number that made this row match, as a fraction 0..1. */
  sovPct: number
  /** Our biggest campaign's share of the impressions we took on this query; null where we ran none. */
  concentrationPct: number | null
  currentEur: number
  proposedEur: number
  deltaEur: number
  /** True when the guardrail floor/ceiling absorbed the whole move — an honest "this does nothing". */
  clamped: boolean
  /** Set when the handler REFUSED, naming which signal was missing (the computed ops). */
  refused?: string
  /**
   * 🔴 'flag' = carries `suppressedFromBidCents`; 'bid' = at or under 3¢ with no flag.
   *
   * `bid_apply`'s floor is `max(0.05, minEur)`, so it CANNOT write ≤3¢: every op on a suppressed
   * target switches delivery back on for traffic somebody deliberately switched off. Counted in
   * two and never merged — the flag is evidence, ≤3¢ is a convention, and merging them hides the
   * ones the flag does not know about ([[reference_ads_suppression_by_low_bid]]).
   */
  suppressed: 'flag' | 'bid' | null
  /** The whole campaign is bid-suppressed right now, so the next resume overwrites this write. */
  campaignSuppressed: boolean
}

export interface SovPreviewResult {
  ok: boolean
  error?: string
  windowDays: number
  /** Campaigns the operator picked. */
  selected: number
  /**
   * Of the picked campaigns' keyword targets, how many produced a context at all — i.e. carry a
   * market share Amazon reported on a complete week. The rest were never offered to the rule.
   */
  measurable: number
  /** Of the measurable, how many the rule's marketplace scope admits. */
  inScope: number
  /** Of those, how many match the criteria right now. */
  matched: number
  /** Matched targets whose proposed bid equals the current one. */
  noChange: number
  /** Of the matched, how many are deliberately suppressed — and how many only a ≤3¢ bid says so. */
  suppressedMatched: number
  suppressedUnflaggedMatched: number
  campaignSuppressedMatched: number
  /**
   * ENABLED positive KEYWORD targets in the picked campaigns — the population the engine may
   * consider at all, before any question of whether Amazon reported a share for them.
   */
  eligible: number
  /**
   * KEYWORD targets in the picked campaigns that are PAUSED or ARCHIVED. The engine skips them
   * (an archived target cannot serve), and saying so is the difference between "112 keywords had
   * no market share" and "most of them were archived" — two very different sentences.
   */
  notEnabled: number
  /** Every positive target in the picked campaigns, including the kinds a SOV rule can never touch. */
  selectedTargets: number
  /** The SQP week each market was read from, and its age — the freshness the rows inherit. */
  periods: Array<{ marketplace: string; week: string | null; ageDays: number | null; refused: boolean; reason: string }>
  rows: SovPreviewRow[]
  untranslatable?: string[]
}

/** `"49¢ → 75¢"` → `[49, 75]`. The handler's own sentence is the only source of the pair. */
function parseWouldChange(s: unknown): [number, number] | null {
  const m = typeof s === 'string' ? s.match(/^(-?\d+)¢\s*→\s*(-?\d+)¢$/) : null
  return m ? [Number(m[1]), Number(m[2])] : null
}

interface SovCtx {
  marketplace: string | null
  campaign: { id: string; name: string; [k: string]: unknown }
  adTarget: { id: string; sovPct: number; topSharePct: number | null; [k: string]: unknown }
}

export async function previewSovRule(draft: BudgetPreviewDraft): Promise<SovPreviewResult> {
  const empty = (extra: Partial<SovPreviewResult> = {}): SovPreviewResult => ({
    ok: true, windowDays: 30, selected: 0, measurable: 0, inScope: 0, matched: 0, noChange: 0,
    suppressedMatched: 0, suppressedUnflaggedMatched: 0, campaignSuppressedMatched: 0,
    eligible: 0, notEnabled: 0, selectedTargets: 0, periods: [], rows: [], ...extra,
  })

  const a0 = Array.isArray(draft.actions) ? (draft.actions[0] as Record<string, unknown> | undefined) : undefined
  const picked = Array.isArray(a0?.campaigns)
    ? (a0!.campaigns as Array<{ id?: unknown }>).map((c) => String(c?.id ?? '')).filter(Boolean)
    : []

  // The gate's per-market answer travels with the preview regardless of the outcome: "which week
  // is this?" is the first question a share number has to answer.
  const shares = await keywordMarketShares()
  const periods = shares.periods.map((p: SovMarketPeriod) => ({
    marketplace: p.marketplace,
    week: p.start ? p.start.toISOString().slice(0, 10) : null,
    ageDays: p.ageDays,
    refused: p.refused,
    reason: p.reason,
  }))
  if (!picked.length) return empty({ periods })

  /**
   * The two denominators the census needs, straight from the DB rather than from the contexts —
   * a context that was never built cannot count itself.
   */
  const [selectedTargets, eligible, notEnabled] = await Promise.all([
    prisma.adTarget.count({ where: { isNegative: false, adGroup: { campaignId: { in: picked } } } }),
    // Mirrors `buildSovBidContexts`'s own `where` exactly. If the two ever diverge the census
    // starts describing a population the engine does not read — the class this file exists to end.
    prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, status: 'ENABLED', adGroup: { campaignId: { in: picked } } } }),
    prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, status: { not: 'ENABLED' }, adGroup: { campaignId: { in: picked } } } }),
  ])

  const run = await runDraftPreview<SovCtx>(draft, {
    slug: 'sov',
    handler: 'bid_apply',
    defaultWindowDays: 30,
    /**
     * The engine's own emitter, with the display fields the panel needs bolted on afterwards.
     * Enriching here rather than widening the context keeps the tick's payload lean — the engine
     * has no use for a campaign name.
     */
    buildContexts: async () => {
      const { buildSovBidContexts } = await import('../../jobs/advertising-rule-evaluator.job.js')
      const ctxs = await buildSovBidContexts()
      const ids = ctxs.map((c) => c.adTarget.id)
      if (!ids.length) return []
      const meta = await prisma.adTarget.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, expressionValue: true, expressionType: true, bidCents: true, status: true,
          adGroup: { select: { campaign: { select: { id: true, name: true } } } },
        },
      })
      const byId = new Map(meta.map((m) => [m.id, m]))
      return ctxs.map((c) => {
        const m = byId.get(c.adTarget.id)
        return {
          ...c,
          campaign: { id: c.campaign?.id ?? m?.adGroup?.campaign?.id ?? '', name: m?.adGroup?.campaign?.name ?? '' },
          adTarget: {
            ...c.adTarget,
            keyword: m?.expressionValue ?? '',
            matchType: m?.expressionType ?? null,
            bidCents: m?.bidCents ?? 0,
            status: m?.status ?? null,
          },
        }
      })
    },
    // `bid_apply` acts on an ad target, not a campaign.
    entityId: (ctx) => ({ key: 'adTargetId', value: ctx.adTarget.id }),
  })

  if (!run.ok) {
    return empty({
      ok: false, error: run.error, untranslatable: run.untranslatable,
      windowDays: run.census.windowDays, selected: picked.length, eligible, notEnabled, selectedTargets, periods,
    })
  }

  const settledIds = run.settled.map((x) => x.ctx.adTarget.id)
  const [suppTargets, suppCampaigns] = settledIds.length
    ? await Promise.all([
      prisma.adTarget.findMany({ where: { id: { in: settledIds } }, select: { id: true, suppressedFromBidCents: true, bidCents: true } }),
      prisma.campaign.findMany({ where: { id: { in: [...new Set(run.settled.map((x) => x.ctx.campaign.id))] }, bidsSuppressedAt: { not: null } }, select: { id: true } }),
    ])
    : [[], []]
  const suppById = new Map(suppTargets.map((t) => [t.id, t]))
  const suppCampaignIds = new Set(suppCampaigns.map((c) => c.id))
  const suppressionOf = (id: string, currentCents: number): 'flag' | 'bid' | null =>
    suppById.get(id)?.suppressedFromBidCents != null ? 'flag' : currentCents <= KT6_SUPPRESSION_CENTS ? 'bid' : null

  let noChange = 0
  const rows: SovPreviewRow[] = []
  for (const s of run.settled) {
    const t = s.ctx.adTarget as SovCtx['adTarget'] & { keyword?: string; matchType?: string | null; bidCents?: number; status?: string | null }
    const out = s.res?.output ?? {}
    // A refusal is a ROW, not an omission: "this target has clicks but no attributed sales" is the
    // answer to "what would this rule do here", and hiding it would restore the old preview's lie
    // by a different route.
    if (s.res && s.res.ok === false) {
      rows.push({
        adTargetId: t.id, keyword: t.keyword ?? '', matchType: t.matchType ?? null,
        campaign: s.ctx.campaign.name, marketplace: s.ctx.marketplace, status: t.status ?? null,
        sovPct: t.sovPct, concentrationPct: t.topSharePct,
        currentEur: (t.bidCents ?? 0) / 100, proposedEur: (t.bidCents ?? 0) / 100, deltaEur: 0,
        clamped: false, refused: s.res.error ?? 'refused',
        suppressed: suppressionOf(t.id, t.bidCents ?? 0),
        campaignSuppressed: suppCampaignIds.has(s.ctx.campaign.id),
      })
      continue
    }
    if (typeof out.skipped === 'string') continue // campaign-not-selected — already excluded above
    const pair = parseWouldChange(out.wouldChange)
    if (!pair) continue
    const [curCents, nextCents] = pair
    if (curCents === nextCents) noChange++
    rows.push({
      adTargetId: t.id, keyword: t.keyword ?? '', matchType: t.matchType ?? null,
      campaign: s.ctx.campaign.name, marketplace: s.ctx.marketplace, status: t.status ?? null,
      sovPct: t.sovPct, concentrationPct: t.topSharePct,
      currentEur: curCents / 100,
      proposedEur: nextCents / 100,
      deltaEur: (nextCents - curCents) / 100,
      clamped: curCents === nextCents,
      suppressed: suppressionOf(t.id, curCents),
      campaignSuppressed: suppCampaignIds.has(s.ctx.campaign.id),
    })
  }

  // Biggest movers first; a preview is read from the top and the top should be what changes most.
  rows.sort((a, b) => Math.abs(b.deltaEur) - Math.abs(a.deltaEur))

  return {
    ok: true,
    windowDays: run.census.windowDays,
    selected: picked.length,
    measurable: run.census.measurable,
    inScope: run.census.inScope,
    matched: run.census.matched,
    noChange,
    suppressedMatched: rows.filter((r) => r.suppressed !== null).length,
    suppressedUnflaggedMatched: rows.filter((r) => r.suppressed === 'bid').length,
    campaignSuppressedMatched: rows.filter((r) => r.campaignSuppressed).length,
    eligible,
    notEnabled,
    selectedTargets,
    periods,
    rows,
  }
}
