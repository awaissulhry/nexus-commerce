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
 *   effect      step 4 — "Did it work?": the money saved since the stop, TOO_EARLY for the first 14 days (effect.ts, pure);
 *               the spend before and after is read for the rows of the page (withEffects: one query per kind), for every
 *               matching row when the read is ordered by it; STILL_SPENDS from this view's own still-bought facts. null:
 *               when it stopped is not known, or the days before it are older than Nexus keeps
 *   sort        a key (STOPPED_SORT_KEYS), '-' in front for descending; default: the newest stop first. A person who does
 *               not see ad spend is never ordered by a money key (the route reads it as `where`)
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { labelFor } from '../bid-grid.service.js'
import { EFFECT_MIN_DAYS, effectWindows, stopEffect, type StopEffect } from './effect.js'
import { negativeKeptBy, NO_OWNER, ownerOfActor, refOfOwner } from './owner.js'
import { NO_PAUSE_RECORD, type SinceSource } from './since.js'
import {
  DAY_MS, keywordRowId, plainWords, romeDay, negativeBlocksTerm, negativeMatch, negRowId, ownerMatches, pageOf, targetMatch, termKeyOf,
  type Match, type Owner, type Ref,
} from './pure.js'
import {
  blocksNow, inScope, negativesInScope, ownerOfNegative, placeRefs, scopedFacts, servingPlaces,
  type ResolvedScope, type TargetFact, type WasteFacts, type WasteScope,
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
  /** Step 4 — "Did it work?" (effect.ts); set for the rows a read answers (withEffects), null until then or when unknown. */
  effect: StopEffect | null
}

export interface StoppedTotals { all: number; kept: number; paused: number; negated: number; turnedOn: number; stillBought: number; notAtAmazon: number; inactive: number }

export interface StoppedQuery extends WasteScope {
  kind?: 'keyword' | 'term' | 'all'
  owner?: string | null
  show?: StoppedShow
  q?: string | null
  /** A key of STOPPED_SORT_KEYS, '-' in front for descending; none: the newest stop first. */
  sort?: string | null
  page?: number | null
  pageSize?: number | null
}

/** The Stopped view's columns the server orders by. */
export const STOPPED_SORT_KEYS = ['text', 'where', 'product', 'owner', 'since', 'spendBefore', 'saved', 'state', 'stillServes'] as const
export type StoppedSortKey = (typeof STOPPED_SORT_KEYS)[number]
/** A money key of the Stopped view, for a person who may not order by it. */
export const isStoppedMoneySort = (sort: string | null | undefined) => ['spendbefore', 'saved'].includes(String(sort ?? '').replace(/^-/, '').toLowerCase())

/** The newest stop first, then the words (the view's own order, and every sort's tie-break). */
const byNewest = (a: StoppedRow, b: StoppedRow) => (b.since ?? '').localeCompare(a.since ?? '') || a.text.localeCompare(b.text) || a.id.localeCompare(b.id)

/** The Stopped view's order: a key, '-' in front for descending; an unknown or no key is the newest stop first. */
export function compareStopped(sort: string | null | undefined): (a: StoppedRow, b: StoppedRow) => number {
  const raw = String(sort ?? '').trim()
  const desc = raw.startsWith('-')
  const key = (desc ? raw.slice(1) : raw) as StoppedSortKey
  if (!(STOPPED_SORT_KEYS as readonly string[]).includes(key)) return byNewest
  const num = (f: (r: StoppedRow) => number | null | undefined) => (a: StoppedRow, b: StoppedRow) => {
    const x = f(a) ?? -Infinity
    const y = f(b) ?? -Infinity
    return x === y ? 0 : x < y ? -1 : 1
  }
  const str = (f: (r: StoppedRow) => string) => (a: StoppedRow, b: StoppedRow) => f(a).localeCompare(f(b))
  const base: Record<StoppedSortKey, (a: StoppedRow, b: StoppedRow) => number> = {
    text: str((r) => r.text),
    where: str((r) => `${r.portfolio?.name ?? ''} ${r.campaign.name} ${r.adGroup?.name ?? ''}`),
    product: str((r) => r.product?.name ?? '~'),
    owner: str((r) => r.owner.name),
    since: str((r) => r.since ?? ''),
    spendBefore: num((r) => r.spendBeforeCents),
    saved: num((r) => r.effect?.savedCents),
    state: str((r) => r.state),
    stillServes: num((r) => r.stillServesIn),
  }
  const cmp = base[key]
  // Too early or not known: no money claim, so last whichever way.
  const claim = (r: StoppedRow) => r.effect != null && r.effect.verdict !== 'TOO_EARLY' && typeof r.effect.savedCents === 'number'
  if (key === 'saved') return (a, b) => Number(claim(b)) - Number(claim(a)) || (desc ? -cmp(a, b) : cmp(a, b)) || byNewest(a, b)
  // No date known: last whichever way, like Saved.
  if (key === 'since') return (a, b) => Number(!!b.since) - Number(!!a.since) || (desc ? -cmp(a, b) : cmp(a, b)) || byNewest(a, b)
  return (a, b) => (desc ? -cmp(a, b) : cmp(a, b)) || byNewest(a, b)
}

export type StoppedAnswer = { ok: true; rows: StoppedRow[]; total: number; page: number; pageSize: number; totals: StoppedTotals } | { ok: false; status: 400 | 404; error: string }

const FINAL = 'Final: Amazon archives a removed negative; it can only be added again as a new one.'

/**
 * The stops of the scope: `rows` in places that run, `idle` in places that do not (a paused campaign or ad group: a
 * negative there blocks nothing now). With `s.idle` (one row's detail) every stop is a row.
 */
export function buildStoppedRows(f: WasteFacts, s: ResolvedScope): { rows: StoppedRow[]; idle: StoppedRow[] } {
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
      effect: null,
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
      effect: null,
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
  const built = out.facts.map((f) => buildStoppedRows(f, { ...q, roots: out.roots }))
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
  const shown = filtered.filter((r) => showMatches(r, q.show ?? 'all') && (kind === 'all' || (kind === 'term' ? r.kind === 'TERM' : r.kind !== 'TERM')))
  // Ordered by what each stop saved: every matching row's effect is read first; else only the page's.
  const bySaved = String(q.sort ?? '').replace(/^-/, '') === 'saved'
  const matching = (bySaved ? await withEffects(shown, out.facts, now) : shown).sort(compareStopped(q.sort))
  const page = pageOf(matching, q.page, q.pageSize)
  return { ok: true, rows: bySaved ? page.rows : await withEffects(page.rows, out.facts, now), total: matching.length, page: page.page, pageSize: page.pageSize, totals }
}

// ── Step 4 — "Did it work?" ────────────────────────────────────────────────────────────────────────────────────────

const centsOf = (micros: unknown) => Math.round(Number(micros ?? 0) / 10_000)

/** Its words still spend in another place, not blocked there: the view's own still-bought facts. */
const stillSpendsIn = (r: StoppedRow) => (r.kind === 'TERM' || stillBought(r) ? r.stillServesIn : 0)

/**
 * These stopped rows with their effect (effect.ts): our keyword's own spend (AmazonAdsDailyPerformance AD_TARGET), or the
 * spend of the words a negative blocks in its place (AmazonAdsSearchTerm, by the external ids of its campaign and ad
 * group), before and after the stop — one query per kind, summed in SQL per row and window (never shipped per day).
 */
export async function withEffects(rows: readonly StoppedRow[], facts: readonly WasteFacts[], now: Date = new Date()): Promise<StoppedRow[]> {
  type Ask = { row: StoppedRow; w: ReturnType<typeof effectWindows>; f: WasteFacts }
  const asks: Ask[] = []
  const done = new Map<string, StopEffect | null>()
  for (const row of rows) {
    if (!row.since) { done.set(row.id, null); continue }
    const w = effectWindows(row.since, now)
    const f = facts.find((x) => x.markets.includes(row.market))
    // Too early needs no spend; a row whose days before Nexus does not hold, or whose market was not read, has no effect.
    if (w.days < EFFECT_MIN_DAYS || !w.before || !f) { done.set(row.id, stopEffect({ since: row.since, now, spend: null, stillIn: stillSpendsIn(row) })); continue }
    asks.push({ row, w, f })
  }
  const kw = asks.filter((a) => a.row.id.startsWith('kw:'))
  const neg = asks.flatMap((a) => {
    if (!a.row.id.startsWith('neg:')) return []
    const n = a.f.targetById.get(a.row.id.slice(4))
    const g = n ? a.f.adGroups.get(n.adGroupId) : undefined
    const c = g ? a.f.campaigns.get(g.campaignId) : undefined
    const m = n ? negativeMatch(n.kind, n.expressionType) : null
    if (!n || !g || !c?.externalCampaignId || !m || (n.negativeLevel !== 'CAMPAIGN' && !g.externalAdGroupId)) return []
    return [{ ...a, c: c.externalCampaignId, g: n.negativeLevel === 'CAMPAIGN' ? '' : g.externalAdGroupId!, text: n.expressionValue, match: m }]
  })
  const spend = new Map<string, { before: number; after: number }>()
  const cols = (list: Ask[]) => ({
    bf: list.map((a) => a.w.before!.from), bt: list.map((a) => a.w.before!.to), af: list.map((a) => a.w.after.from), at: list.map((a) => a.w.after.to),
  })
  const [kwRows, negRows] = await Promise.all([
    kw.length ? (() => {
      const v = cols(kw)
      return prisma.$queryRaw<Array<{ id: string; b: bigint | number; a: bigint | number }>>(Prisma.sql`
        SELECT v.id,
               SUM(CASE WHEN (p.date - DATE '1970-01-01') BETWEEN v.bf AND v.bt THEN p."costMicros" ELSE 0 END)::bigint AS b,
               SUM(CASE WHEN (p.date - DATE '1970-01-01') BETWEEN v.af AND v.at THEN p."costMicros" ELSE 0 END)::bigint AS a
          FROM unnest(${kw.map((a) => a.row.id.slice(3))}::text[], ${v.bf}::int[], ${v.bt}::int[], ${v.af}::int[], ${v.at}::int[]) AS v(id, bf, bt, af, at)
          JOIN "AmazonAdsDailyPerformance" p ON p."entityType" = 'AD_TARGET' AND p."localEntityId" = v.id
                                            AND (p.date - DATE '1970-01-01') BETWEEN v.bf AND v.at
         GROUP BY v.id`)
    })() : Promise.resolve([]),
    neg.length ? (() => {
      const v = cols(neg)
      return prisma.$queryRaw<Array<{ id: string; q: string; b: bigint | number; a: bigint | number }>>(Prisma.sql`
        SELECT v.id, s.query AS q,
               SUM(CASE WHEN (s.date - DATE '1970-01-01') BETWEEN v.bf AND v.bt THEN s."costMicros" ELSE 0 END)::bigint AS b,
               SUM(CASE WHEN (s.date - DATE '1970-01-01') BETWEEN v.af AND v.at THEN s."costMicros" ELSE 0 END)::bigint AS a
          FROM unnest(${neg.map((a) => a.row.id.slice(4))}::text[], ${neg.map((a) => a.c)}::text[], ${neg.map((a) => a.g)}::text[], ${v.bf}::int[], ${v.bt}::int[], ${v.af}::int[], ${v.at}::int[]) AS v(id, c, g, bf, bt, af, at)
          JOIN "AmazonAdsSearchTerm" s ON s."campaignId" = v.c AND (v.g = '' OR s."adGroupId" = v.g)
                                      AND (s.date - DATE '1970-01-01') BETWEEN v.bf AND v.at
         GROUP BY v.id, s.query`)
    })() : Promise.resolve([]),
  ])
  // A place with no spend on record in those days spent nothing.
  for (const a of [...kw, ...neg]) spend.set(a.row.id, { before: 0, after: 0 })
  for (const r of kwRows) spend.set(`kw:${r.id}`, { before: centsOf(r.b), after: centsOf(r.a) })
  const negOf = new Map(neg.map((a) => [a.row.id, a]))
  for (const r of negRows) {
    const a = negOf.get(`neg:${r.id}`)
    // Only the words this negative blocks (its match), as its spend before is counted (read.ts).
    if (!a || !negativeBlocksTerm(termKeyOf(r.q), { text: a.text, match: a.match })) continue
    const s = spend.get(a.row.id)!
    s.before += centsOf(r.b)
    s.after += centsOf(r.a)
  }
  for (const a of asks) done.set(a.row.id, stopEffect({ since: a.row.since!, now, spend: spend.get(a.row.id) ?? null, stillIn: stillSpendsIn(a.row) }))
  return rows.map((r) => ({ ...r, effect: done.get(r.id) ?? null }))
}

export { NO_OWNER, DAY_MS }
