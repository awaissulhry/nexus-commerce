/**
 * E4 (eBay Ads) — CSV round-trip: export current campaign/ad/keyword state;
 * import rate/bid/status/add/remove ops with validation + dry-run diff +
 * per-row results. Parsing/diffing are pure (unit-tested); applying routes
 * through the audited write service (gate + guardrails + audit).
 */

import prisma from '../../db.js'
import * as writes from './ebay-ads-write.service.js'

// ── Export ───────────────────────────────────────────────────────────────────
const HEADERS = [
  'entity', 'campaign_id', 'campaign_name', 'marketplace', 'strategy', 'status',
  'listing_id', 'title', 'ad_rate_pct', 'break_even_pct',
  'keyword_id', 'keyword_text', 'match_type', 'bid_eur', 'daily_budget_eur', 'action',
] as const

const esc = (v: unknown): string => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function exportAdsCsv(): Promise<string> {
  const campaigns = await prisma.ebayCampaign.findMany({
    include: { ads: true, keywords: true, adGroups: true },
    orderBy: { startDate: 'desc' },
  })
  const itemIds = campaigns.flatMap((c) => c.ads.map((a) => a.listingId)).filter((x): x is string => !!x)
  const [index, eco] = await Promise.all([
    prisma.ebayListingIndex.findMany({ where: { itemId: { in: itemIds.length ? itemIds : ['−'] } }, select: { itemId: true, title: true } }),
    prisma.ebayListingEconomics.findMany({ where: { itemId: { in: itemIds.length ? itemIds : ['−'] } }, select: { itemId: true, breakEvenAdRatePct: true } }),
  ])
  const titleBy = new Map(index.map((i) => [i.itemId, i.title]))
  const beBy = new Map(eco.map((e) => [e.itemId, e.breakEvenAdRatePct != null ? Number(e.breakEvenAdRatePct.toString()) : null]))

  const lines: string[] = [HEADERS.join(',')]
  for (const c of campaigns) {
    const strategy = c.channels.includes('OFF_SITE') ? 'OFFSITE' : (c.fundingModel ?? 'COST_PER_SALE') === 'COST_PER_CLICK' ? 'PRIORITY' : 'GENERAL'
    lines.push([
      'CAMPAIGN', c.externalCampaignId, esc(c.name), c.marketplace, strategy, c.status,
      '', '', c.bidPercentage?.toString() ?? '', '', '', '', '', '',
      c.dailyBudget?.toString() ?? '', '',
    ].join(','))
    for (const a of c.ads) {
      lines.push([
        'AD', c.externalCampaignId, esc(c.name), c.marketplace, strategy, a.status,
        a.listingId ?? '', esc(titleBy.get(a.listingId ?? '') ?? ''),
        a.bidPercentage?.toString() ?? '', a.listingId != null ? String(beBy.get(a.listingId) ?? '') : '',
        '', '', '', '', '', '',
      ].join(','))
    }
    const groupsById = new Map(c.adGroups.map((g) => [g.id, g]))
    for (const k of c.keywords) {
      lines.push([
        'KEYWORD', c.externalCampaignId, esc(c.name), c.marketplace, strategy, k.status,
        '', esc(groupsById.get(k.adGroupId)?.name ?? ''), '', '',
        k.externalKeywordId, esc(k.text), k.matchType,
        k.bidCents != null ? (k.bidCents / 100).toFixed(2) : '', '', '',
      ].join(','))
    }
  }
  return lines.join('\n')
}

// ── Import: parse (pure) ─────────────────────────────────────────────────────
export type CsvOp =
  | { kind: 'AD_RATE'; campaignExternalId: string; listingId: string; ratePct: number; row: number }
  | { kind: 'AD_ADD'; campaignExternalId: string; listingId: string; ratePct: number; row: number }
  | { kind: 'AD_REMOVE'; campaignExternalId: string; listingId: string; row: number }
  | { kind: 'KEYWORD_BID'; campaignExternalId: string; keywordExternalId: string; bidCents: number; row: number }
  | { kind: 'KEYWORD_STATUS'; campaignExternalId: string; keywordExternalId: string; status: 'ACTIVE' | 'PAUSED'; row: number }
  | { kind: 'CAMPAIGN_ACTION'; campaignExternalId: string; action: 'pause' | 'resume' | 'end'; row: number }
  | { kind: 'CAMPAIGN_BUDGET'; campaignExternalId: string; dailyBudgetCents: number; row: number }

export interface CsvParseResult { ops: CsvOp[]; errors: Array<{ row: number; error: string }> }

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQ = false
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

const num = (s: string | undefined): number | null => {
  if (s == null || s.trim() === '') return null
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

export function parseAdsOpsCsv(csv: string): CsvParseResult {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const result: CsvParseResult = { ops: [], errors: [] }
  if (lines.length < 2) { result.errors.push({ row: 0, error: 'no data rows (need a header + at least one row)' }); return result }
  const headers = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase())
  const col = (name: string, cells: string[]): string | undefined => {
    const i = headers.indexOf(name)
    return i >= 0 ? cells[i]?.trim() : undefined
  }
  for (let r = 1; r < lines.length; r++) {
    const cells = splitCsvLine(lines[r]!)
    const entity = (col('entity', cells) ?? '').toUpperCase()
    const campaignExternalId = col('campaign_id', cells) ?? ''
    const action = (col('action', cells) ?? '').toLowerCase()
    if (!campaignExternalId) { result.errors.push({ row: r + 1, error: 'campaign_id is required' }); continue }

    if (entity === 'AD') {
      const listingId = col('listing_id', cells) ?? ''
      if (!listingId) { result.errors.push({ row: r + 1, error: 'AD row needs listing_id' }); continue }
      if (action === 'remove') { result.ops.push({ kind: 'AD_REMOVE', campaignExternalId, listingId, row: r + 1 }); continue }
      const rate = num(col('ad_rate_pct', cells) ?? col('new_ad_rate_pct', cells))
      if (rate == null) { result.errors.push({ row: r + 1, error: 'AD row needs ad_rate_pct (or action=remove)' }); continue }
      result.ops.push({ kind: action === 'add' ? 'AD_ADD' : 'AD_RATE', campaignExternalId, listingId, ratePct: rate, row: r + 1 })
    } else if (entity === 'KEYWORD') {
      const keywordExternalId = col('keyword_id', cells) ?? ''
      if (!keywordExternalId) { result.errors.push({ row: r + 1, error: 'KEYWORD row needs keyword_id' }); continue }
      if (action === 'pause' || action === 'resume') {
        result.ops.push({ kind: 'KEYWORD_STATUS', campaignExternalId, keywordExternalId, status: action === 'pause' ? 'PAUSED' : 'ACTIVE', row: r + 1 })
        continue
      }
      const bid = num(col('bid_eur', cells) ?? col('new_bid_eur', cells))
      if (bid == null) { result.errors.push({ row: r + 1, error: 'KEYWORD row needs bid_eur (or action=pause|resume)' }); continue }
      result.ops.push({ kind: 'KEYWORD_BID', campaignExternalId, keywordExternalId, bidCents: Math.round(bid * 100), row: r + 1 })
    } else if (entity === 'CAMPAIGN') {
      if (action === 'pause' || action === 'resume' || action === 'end') {
        result.ops.push({ kind: 'CAMPAIGN_ACTION', campaignExternalId, action, row: r + 1 })
        continue
      }
      const budget = num(col('daily_budget_eur', cells) ?? col('new_daily_budget_eur', cells))
      if (budget != null) { result.ops.push({ kind: 'CAMPAIGN_BUDGET', campaignExternalId, dailyBudgetCents: Math.round(budget * 100), row: r + 1 }); continue }
      result.errors.push({ row: r + 1, error: 'CAMPAIGN row needs action=pause|resume|end or daily_budget_eur' })
    } else {
      result.errors.push({ row: r + 1, error: `unknown entity "${entity}" (AD | KEYWORD | CAMPAIGN)` })
    }
  }
  return result
}

// ── Import: diff + apply ─────────────────────────────────────────────────────
export interface CsvDiffRow { row: number; kind: string; target: string; from: string; to: string; note: string | null; error: string | null }

export async function diffOps(ops: CsvOp[]): Promise<CsvDiffRow[]> {
  const extIds = [...new Set(ops.map((o) => o.campaignExternalId))]
  const campaigns = await prisma.ebayCampaign.findMany({ where: { externalCampaignId: { in: extIds } }, include: { ads: true, keywords: true } })
  const byExt = new Map(campaigns.map((c) => [c.externalCampaignId, c]))
  const out: CsvDiffRow[] = []
  for (const op of ops) {
    const c = byExt.get(op.campaignExternalId)
    if (!c) { out.push({ row: op.row, kind: op.kind, target: op.campaignExternalId, from: '', to: '', note: null, error: 'unknown campaign_id' }); continue }
    if (op.kind === 'AD_RATE' || op.kind === 'AD_ADD') {
      const ad = c.ads.find((a) => a.listingId === op.listingId)
      if (op.kind === 'AD_RATE' && !ad) { out.push({ row: op.row, kind: op.kind, target: op.listingId, from: '', to: '', note: null, error: 'no ad for this listing in this campaign (use action=add)' }); continue }
      if (op.kind === 'AD_ADD' && ad) { out.push({ row: op.row, kind: op.kind, target: op.listingId, from: ad.bidPercentage?.toString() ?? '—', to: `${op.ratePct}%`, note: 'already in campaign — will update rate', error: null }); continue }
      const invalid = writes.validateRatePct(op.ratePct)
      out.push({ row: op.row, kind: op.kind, target: op.listingId, from: ad?.bidPercentage != null ? `${ad.bidPercentage}%` : '—', to: `${op.ratePct}%`, note: null, error: invalid })
    } else if (op.kind === 'AD_REMOVE') {
      const ad = c.ads.find((a) => a.listingId === op.listingId)
      out.push({ row: op.row, kind: op.kind, target: op.listingId, from: ad ? 'in campaign' : 'not in campaign', to: 'removed', note: null, error: ad ? null : 'no ad for this listing' })
    } else if (op.kind === 'KEYWORD_BID' || op.kind === 'KEYWORD_STATUS') {
      const kw = c.keywords.find((k) => k.externalKeywordId === op.keywordExternalId)
      if (!kw) { out.push({ row: op.row, kind: op.kind, target: op.keywordExternalId, from: '', to: '', note: null, error: 'unknown keyword_id in this campaign' }); continue }
      if (op.kind === 'KEYWORD_BID') out.push({ row: op.row, kind: op.kind, target: kw.text, from: kw.bidCents != null ? `€${(kw.bidCents / 100).toFixed(2)}` : '—', to: `€${(op.bidCents / 100).toFixed(2)}`, note: null, error: op.bidCents < 2 || op.bidCents > 10000 ? 'bid must be €0.02–€100' : null })
      else out.push({ row: op.row, kind: op.kind, target: kw.text, from: kw.status, to: op.status, note: null, error: null })
    } else if (op.kind === 'CAMPAIGN_ACTION') {
      out.push({ row: op.row, kind: op.kind, target: c.name, from: c.status, to: op.action.toUpperCase(), note: null, error: null })
    } else if (op.kind === 'CAMPAIGN_BUDGET') {
      out.push({ row: op.row, kind: op.kind, target: c.name, from: c.dailyBudget != null ? `€${c.dailyBudget}/day` : '—', to: `€${(op.dailyBudgetCents / 100).toFixed(2)}/day`, note: (c.fundingModel ?? '') !== 'COST_PER_CLICK' ? 'not a CPC campaign — will fail' : null, error: null })
    }
  }
  return out
}

export async function applyOps(ctx: writes.OpContext, ops: CsvOp[]): Promise<Array<{ row: number; ok: boolean; mode: string; detail: string }>> {
  const extIds = [...new Set(ops.map((o) => o.campaignExternalId))]
  const campaigns = await prisma.ebayCampaign.findMany({ where: { externalCampaignId: { in: extIds } }, include: { keywords: true } })
  const byExt = new Map(campaigns.map((c) => [c.externalCampaignId, c]))
  const results: Array<{ row: number; ok: boolean; mode: string; detail: string }> = []
  for (const op of ops) {
    const c = byExt.get(op.campaignExternalId)
    if (!c) { results.push({ row: op.row, ok: false, mode: '-', detail: 'unknown campaign_id' }); continue }
    try {
      if (op.kind === 'AD_RATE') {
        const r = await writes.setAdRates(ctx, c.id, [{ listingId: op.listingId, ratePct: op.ratePct }])
        const item = r.results[0]
        results.push({ row: op.row, ok: !!item?.ok, mode: r.mode, detail: item?.blocked ?? item?.error ?? item?.warning ?? `rate → ${op.ratePct}%` })
      } else if (op.kind === 'AD_ADD') {
        const r = await writes.promoteListings(ctx, { campaignId: c.id, items: [{ listingId: op.listingId, ratePct: op.ratePct }] })
        const item = r.results[0]
        results.push({ row: op.row, ok: !!item?.ok, mode: r.mode, detail: item?.blocked ?? item?.error ?? item?.warning ?? 'added' })
      } else if (op.kind === 'AD_REMOVE') {
        const r = await writes.removeAds(ctx, c.id, [op.listingId])
        results.push({ row: op.row, ok: !!r.results[0]?.ok, mode: r.mode, detail: r.results[0]?.error ?? 'removed' })
      } else if (op.kind === 'KEYWORD_BID' || op.kind === 'KEYWORD_STATUS') {
        const kw = c.keywords.find((k) => k.externalKeywordId === op.keywordExternalId)
        if (!kw) { results.push({ row: op.row, ok: false, mode: '-', detail: 'unknown keyword_id' }); continue }
        const r = await writes.updateKeywords(ctx, c.id, [op.kind === 'KEYWORD_BID' ? { keywordId: kw.id, bidCents: op.bidCents } : { keywordId: kw.id, status: op.status }])
        results.push({ row: op.row, ok: !!r.results[0]?.ok, mode: r.mode, detail: r.results[0]?.error ?? 'updated' })
      } else if (op.kind === 'CAMPAIGN_ACTION') {
        const r = await writes.campaignLifecycle(ctx, c.id, op.action)
        results.push({ row: op.row, ok: true, mode: r.mode, detail: `status → ${r.status}` })
      } else if (op.kind === 'CAMPAIGN_BUDGET') {
        const r = await writes.updateBudget(ctx, c.id, op.dailyBudgetCents)
        results.push({ row: op.row, ok: true, mode: r.mode, detail: `budget → €${(op.dailyBudgetCents / 100).toFixed(2)}/day (${r.budgetUpdatesToday}/15 today)` })
      }
    } catch (e) {
      results.push({ row: op.row, ok: false, mode: '-', detail: (e as Error).message })
    }
  }
  return results
}
