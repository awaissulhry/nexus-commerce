/**
 * BID BRAIN BB-15 (design BRAIN-UPGRADES-DESIGN.md U1b) — the nowcast switch and its pure parts. The loader is
 * load.ts `loadNowcastEvidence`; the curve is lag-curve.ts; the maturity weighting is estimator.ts `matureSum`.
 *
 *   NEXUS_BID_BRAIN_NOWCAST = off · shadow (default) · on
 *     off     nothing extra is read; the brain decides from its settled window, exactly as before BB-15
 *     shadow  the brain still decides from its settled window, byte for byte. Each full run ALSO decides the same
 *             keywords from the window that ends yesterday, every day weighted by its copy's maturity, and where the
 *             two decisions differ the stored why says so (" · nowcast to …: would …"); the run's line counts them.
 *             Nothing more is written, nothing is sent.
 *     on      the window ends yesterday and every day counts with its copy's maturity: the decisions use it
 *   With no usable curve for the market (none fitted yet, only the prior, or a fit older than two weeks), the young days
 *   are ignored (design U1 guardrails): shadow compares nothing and on reads the settled window exactly as off.
 *
 *   maturity  the age a keyword-day's copy was PULLED at, not the day's age: Amazon answers the targeting report one day
 *             per request, so BB-13 asks each keyword day twice — the morning after (age 0) and once settled (age 7).
 *             A keyword day 4 days old still holds its age-0 copy: its maturity is L(0), not L(4). The same rule
 *             corrects the old days the 60-day re-read never reached (their only copy is the morning-after one).
 */
import type { Decision, TargetFacts } from './decide.js'
import { estimate, matureSum, type Evidence } from './estimator.js'
import { maturityOf, type LagShares } from './lag-curve.js'

export type NowcastMode = 'off' | 'shadow' | 'on'

/** The switch. Anything unrecognised is shadow: decisions never change by accident. */
export function nowcastMode(env: string | undefined = process.env.NEXUS_BID_BRAIN_NOWCAST): NowcastMode {
  const v = (env ?? '').trim().toLowerCase()
  if (v === 'off' || v === '0' || v === 'false') return 'off'
  if (v === 'on' || v === '1' || v === 'true') return 'on'
  return 'shadow'
}

/** One keyword's rows of one pull age and youth, decay-weighted (load.ts sums them in SQL). */
export interface NowcastGroup extends Evidence {
  targetId: string
  /** The age the copies were pulled at (0..14; 15 = 15 or older). */
  pullAge: number
  /** Newer than the settled window. */
  young: boolean
  /** Ad sales of the rows in the newest 30 days, not decayed (TACoS). */
  sales30: number
}

export interface NowcastEvidence {
  evidence: Map<string, Evidence>
  /** Each keyword's ad sales over the newest 30 days, nowcast (observed ÷ the sales share of its copy). */
  adSales30: Map<string, number>
  /** Each keyword's young days' share of its matured clicks (after the cap). */
  youngShare: Map<string, number>
  /** Over the market: matured clicks, the young days' part, the cap's cut and the clicks too young to use. */
  totals: { clicks: number; youngClicks: number; youngCapped: number; tooYoung: number }
}

/** The matured evidence of every keyword from its grouped rows, each under its own curve (`curveOf`). */
export function nowcastEvidence(groups: readonly NowcastGroup[], curveOf: (targetId: string) => LagShares): NowcastEvidence {
  const byTarget = new Map<string, NowcastGroup[]>()
  for (const g of groups) {
    const list = byTarget.get(g.targetId)
    if (list) list.push(g)
    else byTarget.set(g.targetId, [g])
  }
  const out: NowcastEvidence = { evidence: new Map(), adSales30: new Map(), youngShare: new Map(), totals: { clicks: 0, youngClicks: 0, youngCapped: 0, tooYoung: 0 } }
  for (const [id, list] of byTarget) {
    const maturity = maturityOf(curveOf(id))
    const m = matureSum(list, maturity)
    out.evidence.set(id, { clicks: m.clicks, orders: m.orders, salesCents: m.salesCents, costCents: m.costCents })
    out.youngShare.set(id, m.youngShare)
    out.adSales30.set(id, list.reduce((s, g) => { const k = maturity(g.pullAge); return k ? s + g.sales30 / k.sales : s }, 0))
    out.totals.clicks += m.clicks
    out.totals.youngClicks += m.clicks * m.youngShare
    out.totals.youngCapped += m.youngCapped
    out.totals.tooYoung += m.tooYoung
  }
  return out
}

/** What the nowcast changed in one run, for the run's line. */
export interface NowcastShadowSummary {
  dataDay: string
  curve: string
  compared: number
  differ: number
  higher: number
  lower: number
  /** The young days' share of the market's matured clicks, in percent. */
  youngPct: number
}

const pct2 = (f: number) => `${Math.round(f * 10_000) / 100}%`

/**
 * One keyword: the settled decision against the nowcast one. Null when they agree (same action and bid); else the words
 * the stored why gains: "nowcast to 2026-10-07: would write 21¢ (goal; CR 1.2% vs 1% settled; young days 18% of its
 * clicks)".
 */
export function nowcastNote(settled: { facts: TargetFacts; decision: Decision }, nowcast: { facts: TargetFacts; decision: Decision }, youngShare: number | undefined): string | null {
  const a = settled.decision
  const b = nowcast.decision
  if (a.action === b.action && a.bidCents === b.bidCents) return null
  const verb = b.action === 'write' ? `would write ${b.bidCents}¢` : b.action === 'brake' ? 'would brake' : `would hold at ${b.bidCents}¢`
  const cr = (f: TargetFacts) => (f.chain.length ? estimate(f.chain, { rootCr: f.rootCr, listPriceCents: f.listPriceCents }).node.cr : null)
  const crNow = cr(nowcast.facts)
  const crThen = cr(settled.facts)
  const parts = [b.layer.replace('_', '-')]
  if (crNow != null && crThen != null) parts.push(`CR ${pct2(crNow)} vs ${pct2(crThen)} settled`)
  if (youngShare != null && youngShare > 0) parts.push(`young days ${Math.round(youngShare * 100)}% of its clicks`)
  return `nowcast to ${nowcast.facts.dataDay}: ${verb} (${parts.join('; ')})`
}

/** Every keyword of a run: the notes and the counts. Pure. `settled[i]` and `nowcast` facts are matched by target. */
export function compareNowcast(
  settled: ReadonlyArray<{ facts: TargetFacts; decision: Decision }>,
  nowcast: ReadonlyArray<{ facts: TargetFacts; decision: Decision }>,
  youngShare: ReadonlyMap<string, number>,
  info: { dataDay: string; curve: string; youngPct: number },
): { notes: Map<string, string>; summary: NowcastShadowSummary } {
  const byTarget = new Map(nowcast.map((n) => [n.facts.targetId, n]))
  const notes = new Map<string, string>()
  const summary: NowcastShadowSummary = { dataDay: info.dataDay, curve: info.curve, compared: 0, differ: 0, higher: 0, lower: 0, youngPct: info.youngPct }
  for (const s of settled) {
    const n = byTarget.get(s.facts.targetId)
    if (!n) continue
    summary.compared += 1
    const note = nowcastNote(s, n, youngShare.get(s.facts.targetId))
    if (!note) continue
    notes.set(s.facts.targetId, note)
    summary.differ += 1
    if (n.decision.bidCents > s.decision.bidCents) summary.higher += 1
    else if (n.decision.bidCents < s.decision.bidCents) summary.lower += 1
  }
  return { notes, summary }
}

/** The run line's words: "nowcast to 2026-10-07 (IT market curve …): 12 of 120 differ (8 higher, 4 lower), young days 14%". */
export function nowcastSummaryWords(s: NowcastShadowSummary | null | undefined): string {
  if (!s) return ''
  return `nowcast to ${s.dataDay} (${s.curve}): ${s.differ} of ${s.compared} differ (${s.higher} higher, ${s.lower} lower), young days ${s.youngPct}%`
}

/** The young days' share of matured clicks, in percent with one decimal. */
export const youngPctOf = (t: NowcastEvidence['totals']): number => (t.clicks > 0 ? Math.round((t.youngClicks / t.clicks) * 1000) / 10 : 0)

/** The layers whose decision rests on the evidence (an override's does not): where `on` names the young days in the why. */
const EVIDENCE_LAYERS: ReadonlySet<string> = new Set(['goal', 'band', 'limit', 'restore'])

/**
 * `on` — the words a decision's stored why gains when its evidence holds young days: "nowcast to 2026-10-07: young days
 * 16% of its clicks". None for an override's decision, or a keyword with no young clicks. Pure.
 */
export function nowcastOnNotes(decisions: ReadonlyArray<Pick<Decision, 'targetId' | 'layer'>>, youngShare: ReadonlyMap<string, number>, dataDay: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const d of decisions) {
    const y = youngShare.get(d.targetId) ?? 0
    if (y > 0 && EVIDENCE_LAYERS.has(d.layer)) out.set(d.targetId, `nowcast to ${dataDay}: young days ${Math.round(y * 100)}% of its clicks`)
  }
  return out
}
