/**
 * Negative Targeting page (NREAD) — GET /api/advertising/waste/row/:id: one row (a keyword `kw:`, a search term `term:`
 * or a standing negative `neg:`) with where its words run and where they are blocked in the row's market, and its
 * history. The record modal reads this. Read only.
 *
 *   reads      a focused load (read.ts loadWasteFacts focus): the row's words across the market and its own ad group —
 *              never the whole market's terms (each J/K step in the modal reads one row)
 *   runsIn     every place of the market that runs where the words served as a search term in the window and nothing
 *              blocks them, and every keyword of ours with the same words that runs — each with its owner and numbers
 *   blockedIn  every standing negative of the market (in campaigns that run) that blocks the words, with who made it
 *   history    the row's own history (history.ts), 90 days
 *   effect     a standing negative's "Did it work?" (step 4: stopped.ts withEffects), as on its Stopped row
 * A row in a place that does not run is still answered (its detail), but its runsIn reads only places that run.
 */
import prisma from '../../../db.js'
import { historyItems, type HistoryItem } from './history.js'
import { NO_OWNER } from './owner.js'
import { negativeMatch, parseRowId, termKeyOf, type Match, type Owner, type Ref, type RowNumbers, type WasteRow } from './pure.js'
import { blockersOf, blocksNow, buildWasteRows, loadWasteFacts, marketCode, ownerOfNegative, placeRefs, type WasteFacts } from './read.js'
import { buildStoppedRows, withEffects, type StoppedRow } from './stopped.js'

export interface Place {
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref | null
  match: Match
  state: 'RUNNING' | 'PAUSED' | 'KEPT_PAUSED' | 'TURNED_ON_ELSEWHERE' | 'PROTECTED' | 'NEGATED' | 'NOT_AT_AMAZON'
  owner: Owner
  /** The words' numbers there (a search term's, or our keyword's); null where none are held. */
  d: RowNumbers | null
  /** The row there, when it is one (kw:/term:). */
  rowId: string | null
}

export type RowDetailAnswer =
  | { ok: true; row: WasteRow | StoppedRow; runsIn: Place[]; blockedIn: Place[]; history: HistoryItem[] }
  | { ok: false; status: 400 | 404; error: string }

/** The market and the place a row id names, or why not. */
async function locate(id: string): Promise<{ market: string; adGroupId: string; key: string; kind: 'kw' | 'term' | 'neg'; targetId: string | null } | { status: 400 | 404; error: string }> {
  const parsed = parseRowId(id)
  if (!parsed) return { status: 400, error: `${id} is not a row id (kw:<id>, term:<market>|<ad group>|<words>, neg:<id>).` }
  if (parsed.kind === 'term') {
    const market = marketCode(parsed.market)
    const groups = await prisma.adGroup.findMany({ where: { externalAdGroupId: parsed.externalAdGroupId }, select: { id: true, campaign: { select: { marketplace: true } } } })
    const g = groups.find((x) => marketCode(x.campaign.marketplace) === market) ?? (await prisma.adGroup.findUnique({ where: { id: parsed.externalAdGroupId }, select: { id: true, campaign: { select: { marketplace: true } } } }))
    if (!market || !g) return { status: 404, error: `No ad group ${parsed.externalAdGroupId} in ${parsed.market} in this business.` }
    return { market, adGroupId: g.id, key: parsed.termKey, kind: 'term', targetId: null }
  }
  const t = await prisma.adTarget.findUnique({ where: { id: parsed.targetId }, select: { id: true, adGroupId: true, isNegative: true, expressionValue: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } } })
  if (!t || t.isNegative !== (parsed.kind === 'neg')) return { status: 404, error: `No ${parsed.kind === 'neg' ? 'negative' : 'keyword or target'} ${parsed.targetId} in this business.` }
  const market = marketCode(t.adGroup.campaign.marketplace)
  if (!market) return { status: 404, error: `${parsed.targetId}'s campaign names no market.` }
  return { market, adGroupId: t.adGroupId, key: termKeyOf(t.expressionValue), kind: parsed.kind, targetId: t.id }
}

const placeOf = (f: WasteFacts, r: WasteRow): Place => ({ portfolio: r.portfolio, campaign: r.campaign, adGroup: r.adGroup, match: r.match, state: r.state, owner: r.owner, d: r.d, rowId: r.id })

export async function readRowDetail(id: string, now: Date = new Date()): Promise<RowDetailAnswer> {
  const at = await locate(id)
  if ('error' in at) return { ok: false, ...at }
  // Only this row's words (market-wide: where they run and where they are blocked) and its own ad group are read.
  const f = await loadWasteFacts(at.market, now, { key: at.key, adGroupId: at.adGroupId })
  if (!f.adGroups.has(at.adGroupId)) return { ok: false, status: 404, error: `${id} is in a place that is archived: nothing to show.` }

  let row: WasteRow | StoppedRow | undefined
  if (at.kind === 'neg') row = buildStoppedRows(f, { adGroupId: at.adGroupId, idle: true }).rows.find((r) => r.id === id)
    ?? buildStoppedRows(f, { campaignId: f.adGroups.get(at.adGroupId)!.campaignId, idle: true }).rows.find((r) => r.id === id)
  else row = buildWasteRows(f, { adGroupId: at.adGroupId, idle: true }).find((r) => r.id === id)
  if (!row) return { ok: false, status: 404, error: at.kind === 'term' ? `No search term "${at.key}" with clicks in that ad group in 90 days.` : `${id} is not a row this page judges here.` }
  // Step 4 — a standing negative's record says what it saved, as its Stopped row does.
  if ('actions' in row) row = (await withEffects([row], [f], now))[0]

  // Where the words run and where they are blocked, across the market's places that run.
  const market = buildWasteRows(f, {})
  const runsIn = market.filter((r) => !r.askOnly && (r.state === 'RUNNING' || r.state === 'PROTECTED' || r.state === 'TURNED_ON_ELSEWHERE') && (r.kind === 'TERM' ? termKeyOf(r.text) === at.key : termKeyOf(r.text) === at.key))
    .map((r) => placeOf(f, r))
  const blockedIn: Place[] = []
  const seen = new Set<string>()
  for (const g of f.adGroups.values()) {
    if (!g.live) continue
    for (const n of blockersOf(f, g.id, at.key)) {
      if (seen.has(n.id)) continue
      seen.add(n.id)
      const refs = placeRefs(f, n.adGroupId, { tab: 'ad-group-negative-keywords', value: n.expressionValue })
      const termHere = market.find((r) => !r.askOnly && r.kind === 'TERM' && r.adGroup.id === g.id && termKeyOf(r.text) === at.key)
      const m = negativeMatch(n.kind, n.expressionType)
      blockedIn.push({
        portfolio: refs.portfolio, campaign: refs.campaign, adGroup: n.negativeLevel === 'CAMPAIGN' ? null : refs.adGroup,
        match: m === 'ASIN' ? 'ASIN' : m ?? 'EXACT',
        state: blocksNow(f, n) ? 'NEGATED' : 'NOT_AT_AMAZON', owner: ownerOfNegative(f, n) ?? NO_OWNER, d: termHere?.d ?? null, rowId: `neg:${n.id}`,
      })
    }
  }

  const g = f.adGroups.get(at.adGroupId)!
  const history = await historyItems(f, { market: at.market, campaignId: g.campaignId }, 90, 'all', at.kind === 'term'
    ? { termKey: at.key, adGroupIds: new Set([at.adGroupId]), campaignIds: new Set([g.campaignId]) }
    : { targetIds: new Set([at.targetId!]) })
  return { ok: true, row, runsIn, blockedIn, history: history.rows }
}
