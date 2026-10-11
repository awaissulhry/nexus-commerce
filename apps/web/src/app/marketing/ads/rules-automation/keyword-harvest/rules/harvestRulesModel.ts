/**
 * Keyword Harvest page, Rules view (2026-10-11, lane HRULES) — the words and rules of the harvest rules table, pure and
 * tested in Node.
 *
 * The rows are the Bid page's `BidRuleRow` (GET /api/advertising/harvest/rules answers in that shape so one look serves
 * both pages): the brain first (`id: 'brain'`), a rule's honest mode (`set`, what `acts`, what holds it), what it works on
 * and, for a harvest rule, where it harvested INTO in 7 days (`changed7d`, `.keywords`). The generic parts — modes, holds,
 * the lists of links, the draft — are the Bid page's own (`bid/rules/bidRulesModel.ts`, `ruleChanges.ts`), imported, not
 * copied. Here: what differs for a harvest — the words of each mode, the Last 7 d chips (keywords, not bids), the tiles,
 * the rule's harvests (History) and the Owner's D2 caps on Auto.
 *
 * The Owner's words only: Off · Watch · Ask me · Auto; Brain; Rule; Better · Worse · Too early. Labels, numbers and chips.
 */
import { CHANGE_STATE_TONE, CHANGE_STATE_WORD, type ChangeTone } from '../../bid/_shared/delivery'
import { WEEK, periodWord, relWords } from '../../bid/_shared/format'
import {
  MODE_WORD, heldStep, holdReason, holdWord, holdsOf, isBrain, modeRank, plural,
  type BidMode, type BidRuleMode, type BidRuleRow, type Hold, type Part,
} from '../../bid/rules/bidRulesModel'
import type { CandidateDestination, HistoryRow, RulePreviewAnswer, Verdict } from '../_shared/types'
import { undoWhyWords } from '../terms/termsModel'

export type { BidMode, BidRuleRow, Part }

// ── modes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What each mode does for a HARVEST rule (the hover help of the Mode list and the panel). */
export const HARVEST_MODE_MEANS: Readonly<Record<BidMode, string>> = {
  OFF: 'Does not run.',
  WATCH: 'Shows what it would add.',
  ASK: 'You approve each harvest.',
  AUTO: 'Harvests by itself, inside its caps.',
}

/** The brain's harvest is set per product (its settings), never as one switch here. */
export const BRAIN_HARVEST_LOCK = 'Set per product: the Brain’s product settings'

/** The Owner's D2 caps on a harvest rule at Auto, in words: "10 new keywords a day · own campaigns · no new campaign". */
export function autoCapWords(capPerDay: number | null | undefined): string | null {
  const n = typeof capPerDay === 'number' && Number.isFinite(capPerDay) && capPerDay > 0 ? Math.round(capPerDay) : null
  return n != null ? `On Auto: ≤ ${plural(n, 'keyword')} a day · own campaigns` : null
}

/** The Auto line of the Mode list: what it does, then its caps. */
/** Auto's line in a mode list: the same words everywhere (the cap's number is its own chip, once read). */
export const autoMeans = (_capPerDay?: number | null): string => HARVEST_MODE_MEANS.AUTO

/**
 * Why a step cannot be picked for this row (the Bid page's rule, in this page's words), or null. Auto is held up front on
 * the server's `mode.autoLocked` (HCORE sets it for an Off rule too: "Turn on Watch first"), never offered and then refused
 * with server text (functional walk, SHOULD) — in the cell, the rule window and the bulk Mode list alike. A rule set to Auto
 * has no lock, so "Pick Auto again" stays a pick that is sent.
 */
export function harvestHeldStep(row: BidRuleRow, step: string): string | null {
  // The Bid rule (`heldStep`), and also on a rule set to Auto whose new pick the gate would refuse (HCORE: its lock).
  const lock = step === 'AUTO' && row.mode.set === 'AUTO' && !isBrain(row) ? row.mode.autoLocked : null
  const why = lock ? holdReason(lock) : heldStep(row, step)
  if (!why) return null
  return /^Pick Watch or Ask me first/.test(why) ? 'Turn on Watch first' : plainHoldWords(why)
}

/**
 * The bulk "Mode…" list for the ticked rules: a step any of them cannot take is held with the same reason the cell's list
 * gives (audit S21), never offered silently.
 */
export function bulkModeOptions(rows: readonly BidRuleRow[]): Array<{ value: BidMode; label: string; note: string; heldReason?: string }> {
  return (['OFF', 'WATCH', 'ASK', 'AUTO'] as const).map((m) => {
    const held = rows.map((r) => harvestHeldStep(r, m)).find((x) => !!x) ?? null
    return { value: m, label: MODE_WORD[m], note: held ?? HARVEST_MODE_MEANS[m], ...(held ? { heldReason: held } : {}) }
  })
}

// ── plain words for the API's holds and lines (audit §2) ────────────────────────────────────────────────────────────

/** A hold's words without the server's jargon: "79 campaigns locked" → "Can't change 79 campaigns", test mode → test account. */
export function plainHoldWords(text: string): string {
  return text
    .replace(/^Not on the live-change list, bids held by hand, or the account takes no changes(: )?/i, 'Nexus may not change these campaigns$1')
    .replace(/^(\d+) campaigns? locked$/i, 'Can’t change $1 campaigns')
    .replace(/Amazon test mode/i, 'test account')
    .replace(/The server sends ads changes to Amazon's test account, not the live one\./i, 'Changes go to Amazon’s test account, not the live one.')
}

/**
 * A refusal of the mode route in plain words — never server or developer text (functional walk, SHOULD): the deploy
 * switch reads as the test account, the graduation gate as its first runs, "enabled" as turned on.
 */
export function plainRefusal(text: string): string {
  return plainHoldWords(text)
    .replace(/\s*Set [A-Z][A-Z0-9_]*=\S+ on Railway and redeploy\.?/g, ' Changes go to Amazon’s test account, not the live one.')
    .replace(/\bAUTO only after the graduation gate:\s*/i, 'Auto only after its first runs: ')
    .replace(/Rule must be enabled \(toggle it on first\)/i, 'turn it on first')
    .replace(/\b(\d+) evaluations?\b/gi, '$1 runs')
    .trim()
}

/** An approve refused for the approver's code, in one plain line (functional walk, NICE): never "two-factor". */
export function plainApproveError(a: { code?: string; error?: string } | null | undefined): string {
  if (!a) return 'Not approved'
  if (a.code === 'mfa_required' || a.code === 'mfa_invalid' || a.code === 'mfa_not_enrolled' || /two-factor/i.test(a.error ?? '')) return 'Needs the code from your authenticator app'
  return plainRefusal(a.error ?? 'Not approved')
}

/** A hold as the page shows it: plain label and reason; "Auto: test account" reads "Auto off: test account". */
export function plainHold<H extends Hold>(h: H): H {
  const label = plainHoldWords(holdWord(h.label)).replace(/^Auto: /, 'Auto off: ')
  const reason = h.reason ? plainHoldWords(h.reason) : h.reason
  return { ...h, label, ...(reason !== undefined ? { reason } : {}) }
}

/** A rule's one line in the page's words: "If a term converts → harvest by its mapping" → "If a term sells → its mapped ad group". */
export function ruleLine(sentence: string): string {
  return sentence.replace(/\bconverts\b/g, 'sells').replace(/harvest by its mapping/g, 'its mapped ad group')
}

/**
 * The schedule in a few words for a hover that already says the next run's Rome time: "Daily · 05:25 UTC" → "daily",
 * "Daily · 00:00 · Rome" → "daily", "Every 15 min" → "every 15 min" (audit S10: one time zone on a line).
 */
export function scheduleShort(schedule: string | null | undefined): string | null {
  const s = schedule?.trim()
  if (!s) return null
  const head = s.split(' · ')[0]
  return head.charAt(0).toLowerCase() + head.slice(1)
}

/**
 * The holds the Mode cell marks with a shield: those on part of its reach while it acts as set, and — a harvest rule's
 * own case — every hold when it acts HIGHER than set (a builder rule whose belt asks: set to Watch, it asks you). The DS
 * cell draws only a lower step (its arrow), so without this the table would say "Watch" over a rule that asks.
 */
export function shieldHolds(mode: BidRuleMode): Hold[] {
  return mode.acts === mode.set || modeRank(mode.acts) > modeRank(mode.set) ? holdsOf(mode) : []
}

/** The four steps with what each does under it (Auto with its caps). */
export function harvestSteps(capPerDay: number | null | undefined): Array<{ value: BidMode; label: string; note: string }> {
  return (['OFF', 'WATCH', 'ASK', 'AUTO'] as const).map((m) => ({ value: m, label: MODE_WORD[m], note: m === 'AUTO' ? autoMeans(capPerDay) : HARVEST_MODE_MEANS[m] }))
}

/** A pick that lets the rule add keywords: up to Ask me (once you approve) or Auto (alone). Watch adds nothing. */
export const canAddKeywords = (from: BidMode, to: BidMode): boolean => (to === 'ASK' || to === 'AUTO') && modeRank(to) > modeRank(from)

/** The one tick's words for the picks that can add keywords. */
export const harvestRaiseAck = (count: number): string => (count === 1
  ? 'I understand: from its next run this rule can add keywords and block their sources'
  : `I understand: from their next run these ${count} rules can add keywords and block their sources`)

/** The read's one cap number from a preview answer (`capPerDay`), else null. */
export const capOf = (p: Pick<RulePreviewAnswer, 'capPerDay'> | null | undefined): number | null =>
  p && typeof p.capPerDay === 'number' && Number.isFinite(p.capPerDay) ? p.capPerDay : null

// ── last 7 days ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Keywords it harvested in 7 days: the keywords it created that landed (`changed7d.keywords`, else its landed writes). */
export const keywords7d = (row: BidRuleRow): number => Math.max(row.changed7d.keywords ?? 0, isBrain(row) ? row.last7d.written : 0)

/** The cell's chips, most telling first: keywords harvested (History), asks made (Waiting), asks applied, refusals. */
export function harvestLast7Parts(row: BidRuleRow): Part[] {
  const l = row.last7d
  const parts: Part[] = []
  const kw = keywords7d(row)
  if (kw > 0) parts.push({ key: 'keywords', text: plural(kw, 'keyword'), tab: 'history' })
  if (l.asks > 0) parts.push({ key: 'asks', text: `${l.asks} asked`, tab: 'waiting' })
  if (l.applied > 0) parts.push({ key: 'applied', text: `${l.applied} applied`, tab: 'history' })
  if (l.refused > 0) parts.push({ key: 'refused', text: `${l.refused} refused`, tone: 'warning' })
  return parts
}

/** The same in one line (tooltip, CSV, quick filter), with the runs. */
export function harvestLast7Text(row: BidRuleRow): string {
  const parts = harvestLast7Parts(row).map((p) => p.text)
  const runs = row.last7d.runs
  if (!parts.length) return runs ? `${plural(runs, 'run')}, nothing harvested` : 'No runs'
  return [...parts, ...(runs ? [plural(runs, 'run')] : [])].join(' · ')
}

/** Where Enter on the Last 7 d cell goes: the asks while some wait, else the first chip's tab, else the Overview. */
export function harvestLast7Tab(row: BidRuleRow): 'waiting' | 'history' | 'overview' {
  if (row.waiting > 0) return 'waiting'
  return harvestLast7Parts(row).find((p) => p.tab)?.tab ?? 'overview'
}

// ── tiles, search ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The Rules view's tiles (and `?show=`): rules on · keywords harvested in 7 d · asks waiting · held. */
export const RULES_SHOWS = ['on', 'harvested', 'asks', 'held'] as const
export type HarvestRulesShow = (typeof RULES_SHOWS)[number]
export const isRulesShow = (v: unknown): v is HarvestRulesShow => typeof v === 'string' && (RULES_SHOWS as readonly string[]).includes(v)

/**
 * Held back: a hold stands on the rule as a whole (`mode.heldBy`) — the server's own count (`totals.held`), so the tile,
 * its filter and the API say one number (functional walk, NICE). A hold on part of its campaigns stays its shield.
 */
export const isHeld = (row: BidRuleRow): boolean => !row.archived && !isBrain(row) && !!row.mode.heldBy

export function rowMatchesShow(row: BidRuleRow, show: HarvestRulesShow | null): boolean {
  if (!show) return true
  if (show === 'on') return !row.archived && row.mode.set !== 'OFF'
  if (show === 'harvested') return keywords7d(row) > 0
  if (show === 'asks') return row.waiting > 0
  return isHeld(row)
}

const norm = (s: string) => s.toLocaleLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')

/** Every word in its name, its line, its market or what it works on / harvested into. */
export function rowMatchesSearch(row: BidRuleRow, search: string): boolean {
  const words = norm(search).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = norm([
    row.name, row.sentence, row.market ?? '',
    ...row.scope.portfolios.map((r) => r.name), ...row.scope.campaigns.map((r) => r.name), ...row.scope.adGroups.map((r) => r.name),
    ...row.changed7d.campaigns.map((r) => r.name), ...row.changed7d.adGroups.map((r) => r.name),
  ].join(' '))
  return words.every((w) => hay.includes(w))
}

export interface HarvestRulesFilter { show: HarvestRulesShow | null; search: string; archived: boolean }

/** The rows on screen (the brain included while it matches); archived rules only when asked for. */
export function visibleHarvestRows(rows: readonly BidRuleRow[], f: HarvestRulesFilter): BidRuleRow[] {
  return rows.filter((r) => (f.archived ? r.archived : !r.archived) && rowMatchesShow(r, f.show) && rowMatchesSearch(r, f.search))
}

export const isFilteredView = (f: HarvestRulesFilter): boolean => !!f.show || f.search.trim() !== '' || f.archived

/** One tile of a view: its id (`?show=`), its label and its number. The page draws them; a click sets `show`. */
export interface ViewTile<Id extends string = string> {
  id: Id
  label: string
  value: number
  /** The tile's status key: 'success' on, 'primary' did, 'warning' waits, 'danger' held. */
  tone: 'success' | 'primary' | 'warning' | 'danger'
  /** Clicking it filters (false: nothing to show, the tile only counts). */
  filters: boolean
}

/** What the Rules view reports to the page (`onTotals`) after each read: its numbers and its tiles. */
export interface HarvestRulesViewTotals {
  rules: number
  on: number
  /** Keywords harvested by the rules and the brain in 7 days. */
  keywords7d: number
  /** Asks of the rules (and the brain's requests) that wait for a person. */
  asks: number
  held: number
  archived: number
  otherMarkets: number
  tiles: Array<ViewTile<HarvestRulesShow>>
}

export const RULES_TILE_LABEL: Readonly<Record<HarvestRulesShow, string>> = {
  on: 'Rules on',
  harvested: `Keywords · ${WEEK}`,
  asks: 'Waiting for you',
  held: 'Held back',
}

/**
 * The numbers over the rows as read (archived left out), the SAME predicates the filter uses: a tile and the rows it shows
 * never disagree (audit M1). Keywords and asks are sums (their labels say so); on and held count rows.
 */
export function rulesViewTotals(rows: readonly BidRuleRow[], otherMarkets = 0): HarvestRulesViewTotals {
  const active = rows.filter((r) => !r.archived)
  // The Bid page's convention (audit M6): the brain row shows but is not a rule — "Rules on" and "Held back" count rules
  // only, like the toolbar's "3 rules" and the tab badge. Keywords and asks are sums, the brain's included.
  const rules = active.filter((r) => !isBrain(r))
  const on = rules.filter((r) => rowMatchesShow(r, 'on')).length
  const kw = active.reduce((n, r) => n + keywords7d(r), 0)
  const asks = active.reduce((n, r) => n + Math.max(0, r.waiting), 0)
  const held = rules.filter(isHeld).length
  const tiles: Array<ViewTile<HarvestRulesShow>> = [
    { id: 'on', label: RULES_TILE_LABEL.on, value: on, tone: 'success', filters: on > 0 },
    { id: 'harvested', label: RULES_TILE_LABEL.harvested, value: kw, tone: 'primary', filters: kw > 0 },
    { id: 'asks', label: RULES_TILE_LABEL.asks, value: asks, tone: 'warning', filters: asks > 0 },
    { id: 'held', label: RULES_TILE_LABEL.held, value: held, tone: 'danger', filters: held > 0 },
  ]
  return {
    rules: rules.length, on, keywords7d: kw, asks, held,
    archived: rows.filter((r) => r.archived).length, otherMarkets, tiles,
  }
}

// ── preview ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A preview row the brain owns: its campaign's harvests are the brain's (the plan's `lever` hold, "Brain decides"). */
export const isBrainHeld = (h: { kind?: string; label?: string } | null | undefined): boolean => !!h && (h.kind === 'lever' || /^brain/i.test(h.label ?? ''))

/**
 * What the Preview tab shows (audit S12): the rows that are the rule's own, and the brain's terms as ONE line — the
 * server's own count when it sends one (`brainTerms`), else the rows of the sample. A sample cut at `limit` cannot say
 * how many of the rest are the brain's: then `held` stays the server's total and the line says "of the first N".
 */
export function previewView(p: Pick<RulePreviewAnswer, 'sample' | 'held'> & { brainTerms?: number; brainOwned?: BrainOwned | null }, limit = Number.POSITIVE_INFINITY): { rows: RulePreviewAnswer['sample']; brainTerms: number; ofFirst: number | null; held: number; words: string | null } {
  const brainRows = p.sample.filter((s) => isBrainHeld(s.heldBy))
  const rows = p.sample.filter((s) => !isBrainHeld(s.heldBy))
  // The server's own line (S12): the brain's terms are counted apart, neither in the sample nor in `held`.
  if (p.brainOwned) return { rows, brainTerms: p.brainOwned.terms, ofFirst: null, held: p.held, words: brainWords(p.brainOwned.words) }
  if (typeof p.brainTerms === 'number') return { rows, brainTerms: p.brainTerms, ofFirst: null, held: Math.max(0, p.held - p.brainTerms), words: null }
  const cut = p.sample.length >= limit
  return { rows, brainTerms: brainRows.length, ofFirst: cut ? p.sample.length : null, held: cut ? p.held : Math.max(0, p.held - brainRows.length), words: null }
}

/** The rules preview's line about the brain's terms (POST /rules/preview `brainOwned`). */
export interface BrainOwned { terms: number; mode: string; words: string }

/** The server's words with the page's capital: "the brain" → "the Brain". */
const brainWords = (w: string): string => w.replace(/\bthe brain\b/g, 'the Brain')

/** "54 terms belong to the Brain (Watch: it adds nothing)" — what the brain does with them, in its mode's words. */
export function brainTermsLine(n: number, brainMode: BidMode | null, ofFirst: number | null = null): string {
  const what = brainMode === 'WATCH' ? ' (Watch: it adds nothing)' : brainMode === 'OFF' ? ' (Off: nobody adds them)' : brainMode === 'ASK' ? ' (Ask me: it asks you)' : brainMode === 'AUTO' ? ' (Auto: it adds them)' : ''
  if (ofFirst != null) return `${n} of the first ${ofFirst} terms belong to the Brain${what}`
  return `${plural(n, 'term')} ${n === 1 ? 'belongs' : 'belong'} to the Brain${what}`
}

// ── history (a rule's harvests) ─────────────────────────────────────────────────────────────────────────────────────

export const VERDICT_WORD: Readonly<Record<Verdict, string>> = { better: 'Better', worse: 'Worse', 'too-early': 'Too early' }
export const VERDICT_TONE: Readonly<Record<Verdict, ChangeTone>> = { better: 'success', worse: 'danger', 'too-early': 'neutral' }

/** The verdict chip after the attribution window + 72 h; before it, "Too early" with the day it is judged. */
export function verdictView(j: HistoryRow['judge'], now = Date.now()): { word: string; tone: ChangeTone; hint: string | null } | null {
  if (j.verdict) return { word: VERDICT_WORD[j.verdict], tone: VERDICT_TONE[j.verdict], hint: j.why ?? null }
  if (j.judgeAfter) {
    const t = Date.parse(j.judgeAfter)
    return { word: VERDICT_WORD['too-early'], tone: 'neutral', hint: Number.isFinite(t) && t > now ? `Judged ${relWords(j.judgeAfter, now)}` : 'Judged at the next daily run' }
  }
  return null
}

/** What became of a harvest, in the page's one set of words (`bid/_shared/delivery.ts`), plus the two a harvest adds. */
export function harvestStatusView(status: string): { word: string; tone: ChangeTone } {
  switch (status) {
    case 'DONE': return { word: CHANGE_STATE_WORD.live, tone: CHANGE_STATE_TONE.live }
    case 'WRITING':
    case 'CAMPAIGN_BUILT': return { word: CHANGE_STATE_WORD.sent, tone: CHANGE_STATE_TONE.sent }
    case 'HALF_DONE': return { word: 'Part live', tone: 'warning' }
    case 'UNDO_PROPOSED': return { word: 'Undo waits', tone: 'warning' }
    case 'UNDONE': return { word: CHANGE_STATE_WORD.undone, tone: CHANGE_STATE_TONE.undone }
    case 'REFUSED':
    case 'FAILED': return { word: CHANGE_STATE_WORD.failed, tone: CHANGE_STATE_TONE.failed }
    default: return { word: status ? status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ') : '—', tone: 'neutral' }
  }
}

const MATCH_WORD: Readonly<Record<string, string>> = { EXACT: 'Exact', PHRASE: 'Phrase', BROAD: 'Broad' }
export const harvestMatchWord = (m: string | null | undefined): string => (m ? MATCH_WORD[m.toUpperCase()] ?? m : '—')

/** Its blocks are lifted, by the undo's own words ("…and its blocks are lifted"). */
const blocksLifted = (r: Pick<HistoryRow, 'undo' | 'status'>): boolean => r.status === 'UNDONE' || /blocks? (are|is) lifted/i.test(r.undo?.why ?? '')

/** "3 blocked": the source and funnel negatives of a harvest that STAND now (landed, not lifted); null when none. */
export function blocksWord(r: Pick<HistoryRow, 'sources' | 'funnel' | 'undo' | 'status'> & { blocks?: number }): string | null {
  // The server's own count of the blocks that stand (HCORE: lifted ones read `result: 'lifted'`), else counted here.
  if (typeof r.blocks === 'number') return r.blocks > 0 ? `${r.blocks} blocked` : null
  if (blocksLifted(r)) return null
  const n = r.sources.filter((s) => s.action === 'negate' && s.result === 'landed').length + r.funnel.filter((f) => f.result === 'landed').length
  return n > 0 ? `${n} blocked` : null
}

/**
 * Whether its keyword runs: the keyword's own state when the API sends it, else the undo's words ("its keyword is not
 * running"). A harvest that is placed but whose keyword no longer runs is never called Live (audit M3).
 */
export function keywordRuns(r: Pick<HistoryRow, 'undo' | 'status'> & { keyword?: unknown }): boolean {
  const k = r.keyword as { state?: string | null } | null | undefined
  if (k && typeof k === 'object' && k.state) return k.state === 'ENABLED'
  return !/not running/i.test(r.undo?.why ?? '')
}

/** What became of a harvest as History shows it: the delivery word, "Not running" for a placed one whose keyword stopped. */
export function historyStateView(r: Pick<HistoryRow, 'undo' | 'status'> & { keyword?: unknown }): { word: string; tone: ChangeTone } {
  if ((r.status === 'DONE' || r.status === 'HALF_DONE') && !keywordRuns(r)) return { word: 'Not running', tone: 'neutral' }
  return harvestStatusView(r.status)
}

/** The Undo of one harvest: offered, or why not in Terms' short words ("Already undone"). */
export function harvestUndoView(r: Pick<HistoryRow, 'undo' | 'status'>): { kind: 'undo' } | { kind: 'cant'; reason: string } {
  if (r.undo.available) return { kind: 'undo' }
  if (r.status === 'UNDONE') return { kind: 'cant', reason: 'Already undone' }
  return { kind: 'cant', reason: undoWhyWords(r.undo.why) }
}

/** History's days, as the Bid panel offers them (the API reads up to 90). */
export const HISTORY_DAYS = [7, 30, 90].map((d) => ({ value: String(d), label: periodWord(d) }))

// ── waiting asks (Terms' own rows and review; re-audit N-M1) ────────────────────────────────────────────────────────

/** Where a candidate would go, in words: "Campaign › Ad group", or "New · <name>" for a campaign to build. */
export function destinationWords(d: CandidateDestination | null | undefined): string {
  if (!d) return '—'
  if (d.kind === 'new') return `New · ${d.plan.name}`
  return [d.campaign.name, d.adGroup.name].filter(Boolean).join(' › ')
}

/**
 * A stale ask's reason in a few plain words (audit §2): "The rule changed since it asked. It asks again on its next run if
 * still needed." — the server's long sentence when it says something else.
 */
export function plainStale(why: string | null | undefined): string | null {
  const w = why?.trim()
  if (!w) return null
  if (/was edited|edited .* after it proposed|has not proposed it again/i.test(w)) return 'The rule changed since it asked. It asks again on its next run if still needed.'
  if (/\bis off\b|switched off|turned off/i.test(w)) return 'The rule is off: turn it on, or reject the ask.'
  if (/archived|gone|deleted/i.test(w)) return 'The rule is gone: reject the ask.'
  return w
}

// ── effect: what became of its harvests ─────────────────────────────────────────────────────────────────────────────

/** A rule's harvests over the read's days, judged after the attribution window + 72 h. */
export interface RuleEffect { harvests: number; better: number; worse: number; tooEarly: number }

/** The harvest history grouped by who made it: a rule by its id, the brain as `brain`. People and Claude are left out. */
export function effectByRule(rows: readonly HistoryRow[]): Map<string, RuleEffect> {
  const out = new Map<string, RuleEffect>()
  for (const r of rows) {
    const kind = String(r.by.kind).toUpperCase()
    const key = kind === 'BRAIN' ? 'brain' : kind === 'RULE' && r.by.id ? r.by.id : null
    if (!key) continue
    const e = out.get(key) ?? { harvests: 0, better: 0, worse: 0, tooEarly: 0 }
    e.harvests++
    if (r.judge.verdict === 'better') e.better++
    else if (r.judge.verdict === 'worse') e.worse++
    else if (r.status !== 'UNDONE' && r.status !== 'REFUSED' && r.status !== 'FAILED') e.tooEarly++
    out.set(key, e)
  }
  return out
}

/** The Effect cell's chips: "2 better", "1 worse", "3 too early" — nothing when it harvested nothing. */
export function effectParts(e: RuleEffect | null | undefined): Array<{ key: string; text: string; tone: ChangeTone }> {
  if (!e) return []
  const parts: Array<{ key: string; text: string; tone: ChangeTone }> = []
  if (e.better) parts.push({ key: 'better', text: `${e.better} better`, tone: 'success' })
  if (e.worse) parts.push({ key: 'worse', text: `${e.worse} worse`, tone: 'danger' })
  if (e.tooEarly) parts.push({ key: 'early', text: `${e.tooEarly} too early`, tone: 'neutral' })
  return parts
}

/** The same in one line (tooltip, CSV, sort); the dash's words when there is none. */
export function effectText(e: RuleEffect | null | undefined, days: number): string {
  const parts = effectParts(e).map((p) => p.text)
  return parts.length ? `${parts.join(' · ')} · ${periodWord(days)}` : `No harvests in ${periodWord(days)}`
}

/** Sorts by the share judged better, then by how many. */
export const effectScore = (e: RuleEffect | null | undefined): number => (e && e.harvests ? (e.better - e.worse) / e.harvests + e.harvests / 1e6 : -2)
