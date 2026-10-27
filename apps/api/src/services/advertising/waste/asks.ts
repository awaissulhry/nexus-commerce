/**
 * Negative Targeting page — NFIX (2026-10-11): every ask waiting on this page is LISTED, so the "Waiting for you" tile,
 * the Rules view's Waiting (the Brain's asks too) and the list they open are one truth: no count without a list.
 *
 * The fault it fixes: an ask was counted only when a Wasting row carried it — a search term with clicks in that very ad
 * group, in a place that runs, not negated yet. The Brain's asks are mostly not that: a phrase piece across many terms, a
 * funnel or isolation negative where the term never served, a negative's removal (a revive), a place that is paused. So
 * the tile read 0 while the Brain row read its own count of asked negatives.
 *
 * For each change an ask holds (read.ts WaitItem), in the scope (a paused place included: what waits there is real):
 *   carried       a row of the page with the same id already carries this ask → nothing to do
 *   put on a row  the row it lands on is listed and carries no ask → it carries this one (a negated term, a held one)
 *   its own row   no row of the page is that place → a row of its own (`askOnly`), listed under Waiting only: our keyword
 *                 (`kw:`), the term in its ad group (`term:`, the id a term row has; the campaign's first ad group for a
 *                 campaign negative), the negative to remove (`neg:`); its numbers where Nexus holds them
 * A row carries one ask; a second ask on the very same row stays with the first (it is decided with it on the Approvals
 * page) — never counted here without its row.
 * HONEST 10 / 11 / 15 — the `waiting` a row carries is the ask's own change there (waitAskOf: action, match, level, words)
 * and how many changes the ask holds; a row of its own is not judged by the page's test (`test.judged: false`).
 */
import { labelFor } from '../bid-grid.service.js'
import {
  keywordRowId, negativeMatch, negRowId, SPARK_WEEKS, targetMatch, termKeyOf, termRowId, WASTE_WINDOW_DAYS,
  type Match, type RowNumbers, type RowState, type RowKind, type VerbAction, type WasteRow,
} from './pure.js'
import { idIn } from '../ads-scope-lists.js'
import { blockersNow, inScope, numbersOf, placeRefs, waitingOfFact, type ResolvedScope, type TargetFact, type WaitingAsk, type WaitItem, type WasteFacts, type WasteScope } from './read.js'

const NO_NUMBERS: RowNumbers = Object.freeze({ impressions: 0, clicks: 0, orders: 0, spendCents: 0, salesCents: 0, acosPct: null, cpcCents: null, xCpa: null })

interface ItemPlace {
  /** The ad group the row sits in (a campaign negative: the scope's ad group, else the campaign's first one). */
  adGroupId: string
  campaignId: string
  level: 'AD_GROUP' | 'CAMPAIGN'
  /** The words' key (the focus check, the term row's id). */
  key: string
  /** The rows this change lands on: one id, or every listed term row of its words in the campaign. */
  ids: string[]
}

/** Where one change lands in this market's facts; null when it is not this market's (or its place is archived). */
function placeOf(f: WasteFacts, it: WaitItem, s: WasteScope & { adGroupId?: string | null }, listed: ReadonlyMap<string, WasteRow>): ItemPlace | null {
  if (it.action === 'PAUSE' || it.action === 'REMOVE_NEGATIVE') {
    const t = it.targetId ? f.targetById.get(it.targetId) : undefined
    if (!t || t.status === 'ARCHIVED' || t.isNegative !== (it.action === 'REMOVE_NEGATIVE')) return null
    const g = f.adGroups.get(t.adGroupId)
    if (!g) return null
    const level = t.isNegative && t.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP'
    return { adGroupId: g.id, campaignId: g.campaignId, level, key: termKeyOf(t.expressionValue), ids: [t.isNegative ? negRowId(t.id) : keywordRowId(t.id)] }
  }
  const key = termKeyOf(it.text ?? '')
  if (!key) return null
  if (it.adGroupId) {
    const g = f.adGroups.get(it.adGroupId)
    if (!g) return null
    const c = f.campaigns.get(g.campaignId)!
    return { adGroupId: g.id, campaignId: g.campaignId, level: 'AD_GROUP', key, ids: [termRowId(c.market, g.externalAdGroupId ?? g.id, key)] }
  }
  const c = it.campaignId ? f.campaigns.get(it.campaignId) : undefined
  if (!c) return null
  // Its home: an ad group the scope names (the first, running ones first), else the campaign's first running one.
  const groups = [...f.adGroups.values()].filter((g) => g.campaignId === c.id)
    .sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const home = groups.find((g) => idIn(g.id, s.adGroupId, s.adGroupIds)) ?? groups[0]
  if (!home) return null
  const ids = [...listed.values()].filter((r) => r.kind === 'TERM' && r.campaign.id === c.id && !r.id.startsWith('neg:') && termKeyOf(r.text) === key).map((r) => r.id)
  return { adGroupId: home.id, campaignId: c.id, level: 'CAMPAIGN', key, ids: ids.length ? ids : [termRowId(c.market, home.externalAdGroupId ?? home.id, key)] }
}

const VERB_MATCH: Readonly<Record<string, Match>> = { NEGATE_EXACT: 'EXACT', NEGATE_PHRASE: 'PHRASE', NEGATE_ASIN: 'ASIN' }

/**
 * HONEST 10 — one change of an ask as the row it lands on carries it (`waiting`): its own action, the negative's match
 * (our keyword's own for a pause), where it lands (a negative's ad group or whole campaign, the removed negative's own;
 * null for a pause) and its own words — never the row's verb. A pause says whether it keeps the keyword paused (the
 * request's `keepPaused`, a rule card's unless it opts out). A target Nexus no longer holds: what is not known is null.
 */
export function waitAskOf(it: Pick<WaitItem, 'action' | 'targetId' | 'adGroupId' | 'campaignId' | 'text'>, targetById: ReadonlyMap<string, TargetFact>, keepPaused?: boolean): WaitingAsk {
  const keep = it.action === 'PAUSE' && keepPaused !== undefined ? { keepPaused } : {}
  if (it.action === 'PAUSE' || it.action === 'REMOVE_NEGATIVE') {
    const t = it.targetId ? targetById.get(it.targetId) : undefined
    if (!t) return { action: it.action, match: null, level: null, text: null, ...keep }
    if (it.action === 'PAUSE') return { action: 'PAUSE', match: targetMatch(t.kind, t.expressionType)?.match ?? null, level: null, text: labelFor(t.expressionValue, t.kind || 'UNKNOWN', t.expressionType).label, ...keep }
    const m = negativeMatch(t.kind, t.expressionType)
    // HONEST 18d — Amazon never had it (no id): removing it changes Nexus only, nothing is archived at Amazon.
    return { action: 'REMOVE_NEGATIVE', match: m, level: t.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP', text: m === 'ASIN' ? t.expressionValue.toUpperCase() : t.expressionValue, atAmazon: !!t.externalTargetId }
  }
  const text = it.text ?? null
  return { action: it.action, match: VERB_MATCH[it.action] ?? null, level: it.adGroupId ? 'AD_GROUP' : 'CAMPAIGN', text: text && it.action === 'NEGATE_ASIN' ? text.toUpperCase() : text }
}

/** A row of its own for a change no row of the page carries. */
function askRow(f: WasteFacts, it: WaitItem, p: ItemPlace, id: string): WasteRow | null {
  const waiting = waitingOfFact(it.fact)
  let kind: RowKind = 'TERM'
  let text = it.text ?? ''
  let match: Match = VERB_MATCH[it.action] ?? 'EXACT'
  let state: RowState = 'RUNNING'
  let d: RowNumbers | null = { ...NO_NUMBERS }
  let d90: WasteRow['d90'] = null
  let spark = new Array<number>(SPARK_WEEKS).fill(0)
  let stockOutDays = 0
  let tab: 'targets' | 'search-terms' | 'ad-group-negative-keywords' = 'search-terms'
  let focusValue = text
  if (it.action === 'PAUSE') {
    const t = f.targetById.get(it.targetId!)!
    const tm = targetMatch(t.kind, t.expressionType)
    if (!tm) return null
    kind = tm.rowKind
    match = tm.match
    text = labelFor(t.expressionValue, t.kind || 'UNKNOWN', t.expressionType).label
    const hold = f.holds.get(t.id)
    state = hold ? (t.status === 'PAUSED' ? 'KEPT_PAUSED' : 'TURNED_ON_ELSEWHERE') : t.status === 'PAUSED' ? 'PAUSED' : 'RUNNING'
    const agg = f.keywords.get(t.id)
    const win = agg ? numbersOf(f, agg.win, p.adGroupId, WASTE_WINDOW_DAYS) : null
    d = win ? { ...win.n, xCpa: null } : null
    d90 = agg?.d90 ?? null
    spark = agg?.spark ?? spark
    stockOutDays = win?.stockOutDays ?? 0
    tab = 'targets'
    focusValue = t.id
  } else if (it.action === 'REMOVE_NEGATIVE') {
    const n = f.targetById.get(it.targetId!)!
    const m = negativeMatch(n.kind, n.expressionType)
    if (!m) return null
    text = m === 'ASIN' ? n.expressionValue.toUpperCase() : n.expressionValue
    match = m
    state = 'NEGATED'
    tab = 'ad-group-negative-keywords'
    focusValue = n.expressionValue
  } else {
    // The words in this place: their numbers where the search-term report has them (none: no search there in 90 days).
    const tp = f.termPlaces.get(`${p.adGroupId}|${p.key}`)
    if (tp) {
      const win = numbersOf(f, tp.win[60], p.adGroupId, WASTE_WINDOW_DAYS)
      d = { ...win.n, xCpa: null }
      d90 = tp.d90
      spark = tp.spark
      stockOutDays = win.stockOutDays
    }
    if (it.action === 'NEGATE_ASIN') text = text.toUpperCase()
    // HONEST 6 — NEGATED only by a negative that blocks now.
    state = blockersNow(f, p.adGroupId, p.key).length ? 'NEGATED' : 'RUNNING'
  }
  const refs = placeRefs(f, p.adGroupId, { tab, value: focusValue })
  const action: VerbAction = it.action
  return {
    id, kind, text, match, channel: 'AMAZON', market: refs.market, currency: refs.currency,
    portfolio: refs.portfolio, campaign: refs.campaign, adGroup: refs.adGroup, product: refs.product, productCount: refs.productCount, via: null,
    state, owner: { ...it.fact.by },
    verb: { action, where: p.level === 'CAMPAIGN' ? 'campaign' : 'adGroup', held: null, ...(action === 'REMOVE_NEGATIVE' ? { targetRowId: id } : {}) },
    // HONEST 15 — listed for its ask only: the page's test never ran on it (no checks are drawn), `judged: false`.
    test: {
      met: false, judged: false, by: null, windowDays: WASTE_WINDOW_DAYS, clicksNeeded: 0, spendBarCents: null, xCpaBar: null,
      sentence: it.why ? `Asked by ${it.fact.by.name}: ${it.why}` : `Asked by ${it.fact.by.name}: it waits for your answer`,
    },
    d, d90, spark, stockOutDays,
    waiting,
    skipped: null, stillServesIn: 0, lastChange: null, clash: null,
    askOnly: true,
  }
}

/** The page's rows with every waiting change listed (see the file's note). The rows given are fresh: carried asks are set on them. */
export function withAskRows(f: WasteFacts, s: ResolvedScope, rows: WasteRow[]): WasteRow[] {
  if (!f.waitItems.length) return rows
  const out = [...rows]
  const at = new Map(out.map((r, i) => [r.id, i]))
  const listed = new Map(out.map((r) => [r.id, r]))
  for (const it of f.waitItems) {
    const p = placeOf(f, it, s, listed)
    if (!p || !inScope(f, p.adGroupId, { ...s, idle: true })) continue
    // A focused load (one row's detail) holds only its words and its own ad group.
    if (f.focus && p.key !== f.focus.key && p.adGroupId !== f.focus.adGroupId) continue
    const here = p.ids.map((id) => out[at.get(id) ?? -1]).filter((r): r is WasteRow => !!r)
    if (here.some((r) => r.waiting?.approvalId === it.fact.approvalId)) continue
    const free = here.filter((r) => !r.waiting)
    if (free.length) {
      const waiting = waitingOfFact(it.fact)
      for (const r of free) out[at.get(r.id)!] = { ...r, waiting }
      continue
    }
    if (here.length) continue
    const row = askRow(f, it, p, p.ids[0])
    if (!row) continue
    at.set(row.id, out.length)
    listed.set(row.id, row)
    out.push(row)
  }
  return out
}
