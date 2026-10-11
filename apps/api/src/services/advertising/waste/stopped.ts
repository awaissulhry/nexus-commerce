/**
 * Negative Targeting page (NREAD) — GET /api/advertising/waste/stopped: everything that is stopped, in one list — our
 * keywords paused (kept paused or not) and the standing negatives — each with who stopped it, since when, what it spent
 * before, whether it still serves elsewhere, and what may be done with it (each action with why). Read only.
 *
 *   places      stops in places that run (campaign and ad group ENABLED); stops in places that do not are counted
 *               (`totals.inactive`, under the same owner and text filters), not listed: a negative in a paused campaign
 *               blocks nothing now (4-neg-live.md §5.1)
 *   states      KEPT_PAUSED (NWRITE's hold, paused) · PAUSED · TURNED_ON_ELSEWHERE (held, but ENABLED: someone turned it
 *               on outside Nexus) · NEGATED (Amazon holds it, on, campaign running) · NOT_AT_AMAZON (Amazon never gave
 *               it an id) · a negative switched off reads PAUSED
 *   show        kept · negated · turned-on · still-bought (a paused EXACT keyword whose words still spend in another
 *               place of the market, not blocked there: "Still bought elsewhere") · all (default)
 *   since       a keyword: the hold's time, else the pause on record, else unknown; a negative: when it was added
 *               (since.ts — its create record, the Brain's write, Harvest's landing, else the day Nexus's sync first saw
 *               it, unknown when that sync stored a crowd at once); `sinceSource` says which, `sinceWhy` says it in words
 *               (always when unknown: "—" on the page with its why)
 *   spendBefore the 30 days before `since` (null when those days are older than Nexus keeps)
 */
import { labelFor } from '../bid-grid.service.js'
import { negativeKeptBy, NO_OWNER, ownerOfActor, refOfOwner } from './owner.js'
import { NO_PAUSE_RECORD, type SinceSource } from './since.js'
import {
  DAY_MS, keywordRowId, plainWords, romeDay, negativeMatch, negRowId, ownerMatches, pageOf, targetMatch, termKeyOf,
  type Match, type Owner, type Ref,
} from './pure.js'
import {
  blocksNow, inScope, negativesInScope, ownerOfNegative, placeRefs, scopedFacts, servingPlaces,
  type TargetFact, type WasteFacts, type WasteScope,
} from './read.js'

export type StoppedState = 'KEPT_PAUSED' | 'PAUSED' | 'NEGATED' | 'TURNED_ON_ELSEWHERE' | 'NOT_AT_AMAZON'
export type StoppedShow = 'kept' | 'negated' | 'turned-on' | 'still-bought' | 'all'
export interface ActionGate { allowed: boolean; why: string }

export interface StoppedRow {
  id: string
  kind: 'KEYWORD' | 'TARGET' | 'TERM'
  text: string
  match: Match
  level: 'AD_GROUP' | 'CAMPAIGN' | null
  market: string
  currency: string
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref | null
  product: Ref | null
  owner: Owner
  since: string | null
  sinceSource: SinceSource | null
  /** NFIX — how "Since" is known, or why it is not (null since): the page's hover. */
  sinceWhy: string | null
  keptPaused: null | { by: Ref; at: string; until: string | null; reason: string | null }
  spendBeforeCents: number | null
  state: StoppedState
  stillServesIn: number
  /** Standing negatives of the same words and match in the scope (one term in many places reads as one chip). */
  places: number
  actions: { turnOn: ActionGate; removeNegative: ActionGate; release: ActionGate }
}

export interface StoppedTotals { all: number; kept: number; paused: number; negated: number; turnedOn: number; stillBought: number; notAtAmazon: number; inactive: number }

export interface StoppedQuery extends WasteScope {
  kind?: 'keyword' | 'term' | 'all'
  owner?: string | null
  show?: StoppedShow
  q?: string | null
  page?: number | null
  pageSize?: number | null
}

export type StoppedAnswer = { ok: true; rows: StoppedRow[]; total: number; page: number; pageSize: number; totals: StoppedTotals } | { ok: false; status: 400 | 404; error: string }

const FINAL = 'Final: Amazon archives a removed negative; it can only be added again as a new one.'

/**
 * The stops of the scope: `rows` in places that run, `idle` in places that do not (a paused campaign or ad group: a
 * negative there blocks nothing now). With `s.idle` (one row's detail) every stop is a row.
 */
export function buildStoppedRows(f: WasteFacts, s: WasteScope & { root?: string | null; idle?: boolean }): { rows: StoppedRow[]; idle: StoppedRow[] } {
  const rows: StoppedRow[] = []
  const idle: StoppedRow[] = []
  const holdRef = (by: string | null): Ref => (by ? refOfOwner(ownerOfActor(by, f.names)) : { id: 'person', name: 'You' })

  // Our keywords and targets that are stopped.
  for (const t of f.targets) {
    if (t.isNegative || t.status === 'ARCHIVED') continue
    const hold = f.holds.get(t.id) ?? null
    if (t.status !== 'PAUSED' && !hold) continue
    const tm = targetMatch(t.kind, t.expressionType)
    if (!tm) continue
    if (!inScope(f, t.adGroupId, { ...s, idle: true })) continue
    const into = f.adGroups.get(t.adGroupId)!.live || s.idle ? rows : idle
    const pause = f.lastPause.get(t.id) ?? null
    const state: StoppedState = hold ? (t.status === 'PAUSED' ? 'KEPT_PAUSED' : 'TURNED_ON_ELSEWHERE') : 'PAUSED'
    const owner: Owner = hold ? (hold.by ? ownerOfActor(hold.by, f.names) : { kind: 'PERSON', name: 'You', id: null })
      : pause ? ownerOfActor(pause.actor, f.names, pause.executionId) : { kind: 'NONE', name: 'Unknown', id: null }
    const since = hold?.at ?? pause?.at ?? null
    const refs = placeRefs(f, t.adGroupId, { tab: 'targets', value: t.id })
    const text = labelFor(t.expressionValue, t.kind || 'UNKNOWN', t.expressionType).label
    const key = termKeyOf(t.expressionValue || text)
    into.push({
      id: keywordRowId(t.id), kind: tm.rowKind, text, match: tm.match, level: null, market: refs.market, currency: refs.currency,
      portfolio: refs.portfolio, campaign: refs.campaign, adGroup: refs.adGroup, product: refs.product, owner,
      since: since?.toISOString() ?? null, sinceSource: hold ? 'hold' : pause ? 'record' : null,
      sinceWhy: hold ? 'Kept paused on this day' : pause ? 'Paused on this day: the pause on record' : NO_PAUSE_RECORD,
      keptPaused: hold ? { by: holdRef(hold.by), at: hold.at.toISOString(), until: hold.until?.toISOString() ?? null, reason: plainWords(hold.reason) } : null,
      spendBeforeCents: f.keywords.get(t.id)?.spendBefore ?? null,
      state,
      stillServesIn: tm.rowKind === 'KEYWORD' ? servingPlaces(f, key, t.adGroupId).length : 0,
      places: 1,
      actions: {
        turnOn: state === 'TURNED_ON_ELSEWHERE'
          ? { allowed: false, why: 'It already runs at Amazon: someone turned it on outside Nexus.' }
          : state === 'KEPT_PAUSED'
            ? { allowed: true, why: `Kept paused by ${owner.name}${since ? ` since ${romeDay(since)}` : ''}: turning it on lets it spend again (a person's review).` }
            : { allowed: true, why: 'Turns it back on: it spends again.' },
        removeNegative: { allowed: false, why: 'Not a negative: turn it on instead.' },
        release: hold ? { allowed: true, why: 'Ends the lock: it stays as it is, but writers may turn it on again.' } : { allowed: false, why: 'Not kept paused.' },
      },
    })
  }

  // Standing negatives.
  const listed = negativesInScope(f, { ...s, idle: true })
  const runs = (n: TargetFact) => {
    const g = f.adGroups.get(n.adGroupId)!
    return !!f.campaigns.get(g.campaignId)?.live && (n.negativeLevel === 'CAMPAIGN' || g.live)
  }
  const key = (n: TargetFact) => `${termKeyOf(n.expressionValue)}|${negativeMatch(n.kind, n.expressionType)}`
  const placesOf = new Map<string, number>()
  for (const n of listed) if (runs(n)) placesOf.set(key(n), (placesOf.get(key(n)) ?? 0) + 1)
  for (const n of listed) {
    const g = f.adGroups.get(n.adGroupId)!
    const m = negativeMatch(n.kind, n.expressionType)
    if (!m) continue
    const into = runs(n) || s.idle ? rows : idle
    const state: StoppedState = blocksNow(f, n) ? 'NEGATED' : !n.externalTargetId ? 'NOT_AT_AMAZON' : 'PAUSED'
    const owner = ownerOfNegative(f, n)
    // NFIX — when it was added, from the records its writers keep (never the day Nexus stored the row: since.ts).
    const added = f.negativeAdded.get(n.id) ?? null
    const campaignLevel = n.negativeLevel === 'CAMPAIGN'
    const refs = placeRefs(f, n.adGroupId, { tab: 'ad-group-negative-keywords', value: n.expressionValue })
    const k = termKeyOf(n.expressionValue)
    const kept = negativeKeptBy(owner)
    into.push({
      id: negRowId(n.id), kind: 'TERM', text: m === 'ASIN' ? n.expressionValue.toUpperCase() : n.expressionValue, match: m === 'ASIN' ? 'ASIN' : m,
      level: campaignLevel ? 'CAMPAIGN' : 'AD_GROUP', market: refs.market, currency: refs.currency,
      portfolio: refs.portfolio, campaign: refs.campaign, adGroup: campaignLevel ? null : refs.adGroup, product: refs.product, owner,
      since: added?.at?.toISOString() ?? null, sinceSource: added?.source ?? null, sinceWhy: added?.why ?? null,
      keptPaused: null,
      spendBeforeCents: f.negativeSpendBefore.get(n.id) ?? null,
      state,
      stillServesIn: servingPlaces(f, k, campaignLevel ? null : n.adGroupId).filter((id) => !campaignLevel || f.adGroups.get(id)?.campaignId !== g.campaignId).length,
      places: placesOf.get(key(n)) ?? 1,
      actions: {
        turnOn: { allowed: false, why: 'A negative is not turned on: remove it instead.' },
        removeNegative: kept ? { allowed: false, why: kept } : !n.externalTargetId ? { allowed: true, why: 'Amazon never got it: removing it changes Nexus only.' } : { allowed: true, why: FINAL },
        release: { allowed: false, why: 'Not kept paused.' },
      },
    })
  }
  return { rows, idle }
}

/** The owner and text filters of the Stopped view (and of the Wasting view's "negated" tile: one predicate). */
export function filterStopped(rows: readonly StoppedRow[], owner: string | null | undefined, q: string | null | undefined): StoppedRow[] {
  const text = String(q ?? '').trim().toLowerCase()
  return rows.filter((r) => ownerMatches(r.owner, owner) && (!text || [r.text, r.campaign.name, r.adGroup?.name, r.portfolio?.name, r.product?.name].some((x) => (x ?? '').toLowerCase().includes(text))))
}

export const stillBought = (r: StoppedRow) => (r.state === 'PAUSED' || r.state === 'KEPT_PAUSED') && r.kind === 'KEYWORD' && r.match === 'EXACT' && r.stillServesIn > 0

function showMatches(r: StoppedRow, show: StoppedShow): boolean {
  if (show === 'kept') return r.state === 'KEPT_PAUSED'
  if (show === 'negated') return r.state === 'NEGATED'
  if (show === 'turned-on') return r.state === 'TURNED_ON_ELSEWHERE'
  if (show === 'still-bought') return stillBought(r)
  return true
}

/** GET /advertising/waste/stopped. Totals from the same rows (Bid audit M1); `show` and `kind` never change them. */
export async function readStopped(q: StoppedQuery, now: Date = new Date()): Promise<StoppedAnswer> {
  const out = await scopedFacts(q, now)
  if ('error' in out) return out
  const built = out.facts.map((f) => buildStoppedRows(f, { ...q, root: out.root }))
  const rows = built.flatMap((b) => b.rows)
  const idle = built.flatMap((b) => b.idle)
  const filtered = filterStopped(rows, q.owner, q.q)
  const inactive = filterStopped(idle, q.owner, q.q).length
  const totals: StoppedTotals = {
    all: filtered.length,
    kept: filtered.filter((r) => r.state === 'KEPT_PAUSED').length,
    paused: filtered.filter((r) => r.state === 'PAUSED' && r.kind !== 'TERM').length,
    negated: filtered.filter((r) => r.state === 'NEGATED').length,
    turnedOn: filtered.filter((r) => r.state === 'TURNED_ON_ELSEWHERE').length,
    stillBought: filtered.filter(stillBought).length,
    notAtAmazon: filtered.filter((r) => r.state === 'NOT_AT_AMAZON').length,
    inactive,
  }
  const kind = q.kind ?? 'all'
  const matching = filtered
    .filter((r) => showMatches(r, q.show ?? 'all') && (kind === 'all' || (kind === 'term' ? r.kind === 'TERM' : r.kind !== 'TERM')))
    .sort((a, b) => (b.since ?? '').localeCompare(a.since ?? '') || a.text.localeCompare(b.text) || a.id.localeCompare(b.id))
  const page = pageOf(matching, q.page, q.pageSize)
  return { ok: true, rows: page.rows, total: matching.length, page: page.page, pageSize: page.pageSize, totals }
}

export { NO_OWNER, DAY_MS }
