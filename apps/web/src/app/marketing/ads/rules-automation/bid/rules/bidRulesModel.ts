/**
 * Bid page, Rules view (2026-10-10) — the words and rules of the rules table, pure and tested in Node.
 *
 * The shapes mirror GET /api/advertising/bid-rules (apps/api/src/services/advertising/bid-rules/read.ts): the brain is the
 * first row (`id: 'brain'`), money is in cents and lives in money keys a person without the ad-spend permission does not
 * receive (so every money field is optional here), and every `href` comes WITHOUT the `/w/<id>` prefix (the workspace
 * `Link` adds it).
 *
 * The Owner's words only: Off · Watch · Ask me · Auto; Brain; Rule. Labels, numbers and chips — never sentences on the
 * page, except the one line a rule carries.
 */
import { WEEK, currencyOf, dayWords, moneyText, periodWord, relWords, whenWords } from '../_shared/format'

// ── the API's shapes ────────────────────────────────────────────────────────────────────────────────────────────────

export type BidMode = 'OFF' | 'WATCH' | 'ASK' | 'AUTO'
/** The stored level the one level route takes (PATCH /api/advertising/autonomy/rules/:id). */
export type RuleLevel = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'

export interface Ref { id: string; name: string; href?: string | null }
/** One thing that holds a mode: a short `label` for the chip and a one-line `reason` for its hover (the API's HOLDS). */
export interface Hold { kind: string; label: string; reason?: string | null }
export interface BidRuleMode { set: BidMode; acts: BidMode; heldBy: Hold | null; also: Hold[]; autoLocked: Hold | null }
export interface RefSet { portfolios: Ref[]; campaigns: Ref[]; adGroups: Ref[] }
/** How many there are in all, per kind (the API's lists stop at 100). Ad groups may be missing on an older answer. */
export interface RefCounts { portfolios: number; campaigns: number; adGroups?: number }

export interface EffectSide { clicks: number; orders: number; spendCents?: number; salesCents?: number; acosPct?: number | null }
export interface Effect {
  window: { settledThrough: string }
  keywords: number
  tooEarly: number
  days: number
  currency: string | null
  before: EffectSide
  after: EffectSide
}

export interface BidRuleRow {
  id: string
  kind: 'rule' | 'brain'
  name: string
  sentence: string
  market: string | null
  mode: BidRuleMode
  /** `counts`: how many there are in all (the lists stop at 100): the chip says the count, never the list's length. */
  scope: RefSet & { all: boolean; product: Ref | null; counts: RefCounts }
  changed7d: RefSet & { bids: number; keywords: number; counts?: RefCounts }
  last7d: { runs: number; asks: number; applied: number; written: number; brainInputs: number; refused: number }
  waiting: number
  lastRunAt: string | null
  /** The true next run; null when it does not run (Off, archived, held to Off). */
  nextRunAt: string | null
  /** Only when the next run is its first ever (= nextRunAt); `thenRunAt` the run after it, by its schedule. */
  firstRunAt?: string | null
  thenRunAt?: string | null
  /** Its schedule in words, as the engine runs it ("Daily · 06:00 · Rome", "Every 15 min") — the truth for Settings too. */
  schedule?: string | null
  effect: Effect | null
  archived: boolean
}

export interface BidRulesTotals {
  rules: number; on: number; waiting: number
  bidsChanged7d: number; clashes: number; archived: number; otherMarkets: number
}

export interface BidRulesAnswer { market: string | null; rules: BidRuleRow[]; totals: BidRulesTotals }

export const BRAIN_ID = 'brain'
export const isBrain = (row: Pick<BidRuleRow, 'id' | 'kind'>): boolean => row.kind === 'brain' || row.id === BRAIN_ID

// ── modes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MODES: readonly BidMode[] = ['OFF', 'WATCH', 'ASK', 'AUTO']
export const MODE_WORD: Readonly<Record<BidMode, string>> = { OFF: 'Off', WATCH: 'Watch', ASK: 'Ask me', AUTO: 'Auto' }
export const LEVEL_OF_MODE: Readonly<Record<BidMode, RuleLevel>> = { OFF: 'OFF', WATCH: 'OBSERVE', ASK: 'PROPOSE', AUTO: 'AUTO' }
export const MODE_OF_LEVEL: Readonly<Record<RuleLevel, BidMode>> = { OFF: 'OFF', OBSERVE: 'WATCH', PROPOSE: 'ASK', AUTO: 'AUTO' }
export const modeRank = (m: BidMode): number => MODES.indexOf(m)
export const isMode = (v: unknown): v is BidMode => typeof v === 'string' && (MODES as readonly string[]).includes(v)

/** What each mode does, for the hover help (the Control Room's one vocabulary). */
export const MODE_MEANS: Readonly<Record<BidMode, string>> = {
  OFF: 'Does not run.',
  WATCH: 'Runs and records what it would change. Changes nothing.',
  ASK: 'You decide each change.',
  AUTO: 'Changes bids by itself, inside your limits.',
}

/** A hold's label in the page's words: the server's "shadow" (decides, writes nothing) is Watch. */
export const holdWord = (label: string): string => label.replace(/\bshadow\b/gi, 'Watch')

/** A hold's hover line: the server's reason, else its label (an older answer carries no reason). */
export const holdReason = (h: Hold): string => (h.reason?.trim() ? h.reason.trim() : holdWord(h.label))

/** Every hold on a row, the first one first (what makes it act lower, or turns its writes into brain inputs). */
export function holdsOf(mode: BidRuleMode): Hold[] {
  return [...(mode.heldBy ? [mode.heldBy] : []), ...mode.also].map((h) => ({ ...h, label: holdWord(h.label) }))
}

/**
 * The holds the Mode cell's arrow does not show: the ones on part of its campaigns while it still acts as set (the arrow
 * is drawn only when it acts lower). The cell marks them so the table is as honest as the panel.
 */
export function partHolds(mode: BidRuleMode): Hold[] {
  return mode.acts === mode.set ? holdsOf(mode) : []
}

/**
 * Why Auto cannot be picked, as a chip (label) and its hover (reason); null when it can, or when the row shows none. Never
 * while the rule is Off: Auto is not a step from Off anyway (the mode list says "Pick Watch or Ask me first"), so a chip
 * "Auto: Turn on first" only repeated it (audit R15).
 */
export function autoLockOf(row: BidRuleRow): Hold | null {
  if (row.archived || row.mode.set === 'AUTO' || row.mode.set === 'OFF' || !row.mode.autoLocked) return null
  const h = row.mode.autoLocked
  const label = holdWord(h.label)
  return { ...h, label: /^auto\b/i.test(label) ? label : `Auto: ${label}` }
}

/**
 * Why a step cannot be picked for this row (the mode list's held line), or null. From Off, Auto is never a step to take at
 * once — whatever the answer says about Auto's own hold (the API sends none for an Off rule: use audit A5, the save would
 * be refused) — so the plain next step says so.
 */
export function heldStep(row: BidRuleRow, step: string): string | null {
  if (step !== 'AUTO' || row.mode.set === 'AUTO') return null
  if (row.mode.set === 'OFF') return 'Pick Watch or Ask me first'
  return row.mode.autoLocked ? holdReason(row.mode.autoLocked) : null
}

/** Why the whole mode picker is locked for this row, or null (it may change). One wording in the table and the panel. */
export function modeLock(row: BidRuleRow): string | null {
  if (isBrain(row)) return BRAIN_LOCK
  if (row.archived) return 'Archived: restore it first'
  return null
}
export const BRAIN_LOCK = 'Set per campaign: open the Brain'

// ── the brain, per campaign ─────────────────────────────────────────────────────────────────────────────────────────

/** Watch (the brain decides and records; today's writers keep the bids) or Auto (it is the campaign's one bid writer). */
export type BrainStep = 'WATCH' | 'AUTO'
export interface BrainPick { id: string; name: string; from: BrainStep; to: BrainStep }
export const BRAIN_STEP_MEANS: Readonly<Record<BrainStep, string>> = {
  WATCH: 'Decides and records; today’s writers keep the bids.',
  AUTO: 'Sets this campaign’s bids itself, inside your limits.',
}
/** A campaign's step: Auto while the brain owns it (LIVE or held), else Watch. */
export const brainStepOf = (campaignId: string, owned: ReadonlySet<string>): BrainStep => (owned.has(campaignId) ? 'AUTO' : 'WATCH')

/** The review line of one campaign's pick; Auto lets the brain write: it needs the tick and the approver's code. */
export function brainPickChange(p: BrainPick): { id: string; where: string; what: string; now: string; next: string; raise: boolean; note: string } {
  return {
    id: p.id, where: p.name, what: 'Brain', now: MODE_WORD[p.from], next: MODE_WORD[p.to], raise: p.to === 'AUTO',
    note: p.to === 'AUTO' ? 'Becomes its one bid writer · your code' : 'Bids stay; today’s writers resume',
  }
}

/** A brain request's outcome as the Done step's words: approved (and when it runs), or why not. */
export function brainAskWords(a: { executeAfter?: string | null }, now = Date.now()): string {
  return a.executeAfter && Date.parse(a.executeAfter) > now ? `Approved · runs ${relWords(a.executeAfter, now)}` : 'Approved'
}

/**
 * The Brain's row has nothing to say in this market: it decides in none of its campaigns here, ran no time, changed and
 * held nothing (FR, ES, UK and the markets Nexus only reads — it decides in IT and DE). The page leaves it out there
 * rather than show "Watch" with five dashes and empty tabs (use audit C-UI 3). On All markets it always shows.
 */
export function brainIdleHere(row: BidRuleRow, market: string): boolean {
  if (!isBrain(row) || market === 'all') return false
  return !row.scope.campaigns.length && !row.last7d.runs && !row.changed7d.bids && !row.last7d.brainInputs
    && !row.last7d.written && !row.lastRunAt && !row.effect
}

// ── tiles, search ───────────────────────────────────────────────────────────────────────────────────────────────────

export type RulesTile = 'on' | 'changed' | 'waiting'
export const isRulesTile = (v: unknown): v is RulesTile => v === 'on' || v === 'changed' || v === 'waiting'

export function rowMatchesTile(row: BidRuleRow, tile: RulesTile | null): boolean {
  if (!tile) return true
  if (tile === 'on') return !row.archived && row.mode.set !== 'OFF'
  if (tile === 'changed') return row.changed7d.bids > 0
  return row.waiting > 0
}

const norm = (s: string) => s.toLocaleLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')

/** A rule matches when every word is in its name, its sentence or a portfolio / campaign / ad group it works on. */
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

export interface RulesFilter { tile: RulesTile | null; search: string; archived: boolean }

/** The rows on screen: the brain always first while it matches; archived rules only when asked for. */
export function visibleRows(rows: readonly BidRuleRow[], f: RulesFilter): BidRuleRow[] {
  return rows.filter((r) => (f.archived ? r.archived : !r.archived) && rowMatchesTile(r, f.tile) && rowMatchesSearch(r, f.search))
}

export const isFiltered = (f: RulesFilter): boolean => !!f.tile || f.search.trim() !== '' || f.archived

// ── what it works on / changed ──────────────────────────────────────────────────────────────────────────────────────

export type RefKind = 'portfolios' | 'campaigns' | 'adGroups'
export const REF_NOUN: Readonly<Record<RefKind, { one: string; many: string }>> = {
  portfolios: { one: 'portfolio', many: 'portfolios' },
  campaigns: { one: 'campaign', many: 'campaigns' },
  adGroups: { one: 'ad group', many: 'ad groups' },
}
export const REF_HEADER: Readonly<Record<RefKind, string>> = { portfolios: 'Portfolios', campaigns: 'Campaigns', adGroups: 'Ad groups' }

/**
 * How many a rule works on of one kind, and how many of them the list leaves out (the API lists up to 100 per kind and
 * counts them all): "+55" is said, never hidden.
 */
export function worksOn(row: BidRuleRow, kind: RefKind, set: 'scope' | 'changed' = 'scope'): { items: Ref[]; more: number; total: number } {
  const from = set === 'scope' ? row.scope : row.changed7d
  const items = from[kind]
  const counted = from.counts?.[kind]
  const total = Math.max(items.length, typeof counted === 'number' && Number.isFinite(counted) ? counted : items.length)
  return { items, more: total - items.length, total }
}

/**
 * A rule names ad groups only when it is bound to some: otherwise it works on every ad group of its campaigns — "All",
 * in the table and in the panel alike.
 */
export const allAdGroups = (row: BidRuleRow): boolean => !isBrain(row) && !row.scope.adGroups.length && (row.scope.campaigns.length > 0 || row.scope.all)

// ── last 7 days ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A chip: its words, its tone, and the panel tab it opens (a chip with a tab is a button). */
export interface Part { key: string; text: string; tone?: 'warning' | 'info'; tab?: 'history' | 'waiting' }

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/**
 * The cell's chips, most telling first: bids it changed and asks it applied (both open History), asks it made (open the
 * asks), brain inputs, refusals.
 */
export function last7Parts(row: BidRuleRow): Part[] {
  const l = row.last7d
  const parts: Part[] = []
  const bids = Math.max(row.changed7d.bids, l.written)
  if (bids > 0) parts.push({ key: 'bids', text: n(bids, 'bid'), tab: 'history' })
  // The asks open the Waiting tab only while some still wait; when none does (decided or ended), the chip says so and
  // opens nothing — never an empty tab (audit R13).
  if (l.asks > 0) parts.push(row.waiting > 0 ? { key: 'asks', text: `${l.asks} asked`, tab: 'waiting' } : { key: 'asks', text: `${l.asks} asked · none waiting` })
  if (l.applied > 0) parts.push({ key: 'applied', text: `${l.applied} applied`, tab: 'history' })
  if (l.brainInputs > 0) parts.push({ key: 'brain', text: `${l.brainInputs} to Brain`, tone: 'info' })
  if (l.refused > 0) parts.push({ key: 'refused', text: `${l.refused} refused`, tone: 'warning' })
  return parts
}

/** One chip of the Last 7 d cell: the asks that wait (a warning button that opens them), or one of `last7Parts`. */
export type Last7Item = { key: string; text: string; waiting?: true; part?: Part }

/** The room the Last 7 d cell gives its chips: the column's least width (RulesTable: 170 on All markets, where the
 *  Market column takes its share; 254 on one market) less the cell's padding. */
export const LAST7_ROOM = 140
export const LAST7_ROOM_ONE_MARKET = 224
const CHIP_GAP = 4
/** About how wide a small chip draws its words: 12 px semibold is ~6.4 px a character, plus its padding and border. */
const chipWidth = (text: string) => 16 + Math.ceil(text.length * 6.4)

/**
 * The Last 7 d cell on ONE line (design audit M7: four chips wrapped onto two lines and crossed the row lines). The asks
 * that wait come first (the one call to act), then the parts in their order, as many as fit `room`; the rest become one
 * "+n" chip that names them on hover (the whole line is also the cell's title). At least one chip always shows.
 */
export function last7Fit(row: BidRuleRow, room = LAST7_ROOM): { shown: Last7Item[]; hidden: Last7Item[] } {
  const items: Last7Item[] = [
    ...(row.waiting > 0 ? [{ key: 'waiting', text: `${row.waiting} waiting`, waiting: true as const }] : []),
    ...last7Parts(row).map((part) => ({ key: part.key, text: part.text, part })),
  ]
  let used = 0
  let count = 0
  for (let i = 0; i < items.length; i += 1) {
    const left = items.length - i - 1
    const need = (count ? used + CHIP_GAP : 0) + chipWidth(items[i].text) + (left ? CHIP_GAP + chipWidth(`+${left}`) : 0)
    if (count && need > room) break
    used = (count ? used + CHIP_GAP : 0) + chipWidth(items[i].text)
    count += 1
  }
  return { shown: items.slice(0, count), hidden: items.slice(count) }
}

/** Where Enter on the Last 7 d cell goes: the asks while some wait, else the first chip's tab, else the Overview. */
export function last7Tab(row: BidRuleRow): 'waiting' | 'history' | 'overview' {
  if (row.waiting > 0) return 'waiting'
  return last7Parts(row).find((p) => p.tab)?.tab ?? 'overview'
}

/** The same in one line for the tooltip, the CSV and the quick filter, with the runs. */
export function last7Text(row: BidRuleRow): string {
  const parts = last7Parts(row).map((p) => p.text)
  const runs = row.last7d.runs
  if (!parts.length) return runs ? `${n(runs, 'run')}, nothing changed` : 'No runs'
  return [...parts, ...(runs ? [n(runs, 'run')] : [])].join(' · ')
}

// ── effect ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EffectView { text: string; tone: 'success' | 'danger'; title: string }

const pct = (v: number) => `${Math.round(v * 10) / 10}`

/** The window an effect compares: "1 keyword · 9 d before/after · ends 3 Oct" (and how many are too early). */
export function effectWindow(e: Effect): string {
  return [
    n(e.keywords, 'keyword'),
    `${periodWord(Math.round(e.days / Math.max(1, e.keywords)))} before/after`,
    e.tooEarly ? `${e.tooEarly} too early` : null,
    `ends ${dayWords(e.window.settledThrough)}`,
  ].filter(Boolean).join(' · ')
}

/**
 * "ACoS 24 → 20 %" (lower is better), or orders when ACoS is not readable (no sales on a side, or the money hidden).
 * null = nothing to show: no change to compare, too early, or the same before and after (the dash's title says which).
 */
export function effectView(e: Effect | null): EffectView | null {
  if (!e || e.keywords <= 0) return null
  const a = e.before.acosPct, b = e.after.acosPct
  if (typeof a === 'number' && typeof b === 'number') {
    if (pct(a) === pct(b)) return null
    return { text: `ACoS ${pct(a)} → ${pct(b)} %`, tone: b < a ? 'success' : 'danger', title: effectWindow(e) }
  }
  const o1 = e.before.orders, o2 = e.after.orders
  if (o1 === o2) return null
  return { text: `Orders ${o1} → ${o2}`, tone: o2 > o1 ? 'success' : 'danger', title: effectWindow(e) }
}

/** The dash's title when there is no effect to show. */
const TOO_EARLY = 'Too early: fewer than 3 settled days after its changes'
export function noEffectWords(row: BidRuleRow): string {
  if (row.effect && row.effect.keywords <= 0) return TOO_EARLY
  if (row.effect) return `No change · ${effectWindow(row.effect)}`
  return row.changed7d.bids > 0 || row.last7d.written > 0 ? TOO_EARLY : 'No bid changes to compare'
}

// ── money ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Cents in the market's own money ("€0.15", "£0.15"), a dash when none: the page's one helper (`_shared/format.ts`). */
export const marketMoney = (cents: number | null | undefined, market: string | null | undefined): string => moneyText(cents, currencyOf(market))

/**
 * When it runs next, as the Overview says it: "in 20 min" with the moment and its schedule on hover; a rule that has never
 * run says its first run and the one after ("First run 23:00 · then 11 Oct, 06:00").
 */
export function nextRunView(row: Pick<BidRuleRow, 'nextRunAt' | 'firstRunAt' | 'thenRunAt' | 'schedule'>, now = Date.now()): { value: string; hint: string | null } {
  if (!row.nextRunAt) return { value: '—', hint: row.schedule ?? null }
  if (!row.firstRunAt) return { value: relWords(row.nextRunAt, now), hint: [whenWords(row.nextRunAt), row.schedule ?? null].filter(Boolean).join(' · ') }
  // A rule that has not run yet: its first runs, then its schedule, in one sentence (audit R14: "First 01:30 and 13:30,
  // then daily 06:00" — the evaluator's first runs beside "Daily 06:00" read as a contradiction when listed apart). The
  // run after the first that is simply its schedule's is not said twice (use audit C-UI 8: "… and 12 Oct, 06:00, then
  // daily 06:00").
  const a = whenWords(row.nextRunAt)
  const scheduleTime = /\b(\d{2}:\d{2})\b/.exec(row.schedule ?? '')?.[1] ?? null
  const thenWords = row.thenRunAt ? whenWords(row.thenRunAt) : null
  const b = thenWords && !(scheduleTime && thenWords.endsWith(scheduleTime)) ? thenWords : null
  const sameDay = !!b && a.split(', ')[0] === b.split(', ')[0]
  const firsts = b ? `First ${a} and ${sameDay ? b.split(', ')[1] : b}` : `First ${a}`
  const then = row.schedule ? `, then ${row.schedule.replace(/^\S/, (c) => c.toLowerCase()).replace(/^(\w+) · (\d{2}:\d{2})/, '$1 $2')}` : ''
  return { value: relWords(row.nextRunAt, now), hint: `${firsts}${then}` }
}

/** The page's one week, for headers and chips: "Last 7 d". */
export const LAST_WEEK = `Last ${WEEK}`

// ── history ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RuleChange {
  id: string
  at: string
  target: Ref | null
  adGroup: Ref | null
  campaign: Ref | null
  portfolio: Ref | null
  field: string
  fromCents?: number | null
  toCents?: number | null
  from?: string | null
  to?: string | null
  who: { kind: 'rule' | 'brain' | 'person'; id: string | null; name: string }
  delivery: string | null
  changeId: string | null
  undoBlocked: string | null
}

export interface RuleHistory { id: string; name: string; days: number; changes: RuleChange[] }

const FIELD_WORD: Readonly<Record<string, string>> = { bid: 'Bid', defaultBid: 'Default bid', defaultBidCents: 'Default bid', state: 'State', status: 'State' }
export const fieldWord = (field: string): string => FIELD_WORD[field] ?? field

/** A change's before → after in the market's money (a bid) or as stored (a state). */
export function changeFromTo(c: RuleChange, market: string | null): { from: string; to: string } {
  if ('fromCents' in c || 'toCents' in c) return { from: marketMoney(c.fromCents ?? null, market), to: marketMoney(c.toCents ?? null, market) }
  if (c.from === undefined && c.to === undefined) return { from: '—', to: '—' }
  return { from: c.from ?? '—', to: c.to ?? '—' }
}

/**
 * Who made it, as a chip word — only when it is not the rule whose History this is (that would say "Rule" on every
 * line): a person is "You" (one name for a person on the whole page, audit R10 — never "operator" or a login), the
 * Brain, or another rule's name.
 */
export function whoWord(c: RuleChange, ownerId: string): string | null {
  if (c.who.kind === 'person') return 'You'
  if (c.who.kind === 'brain') return ownerId === BRAIN_ID ? null : 'Brain'
  return c.who.id && c.who.id !== ownerId ? c.who.name || 'Rule' : null
}

// ── preview ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PreviewHeld = 'brain' | 'brainStopped' | 'locked' | 'market'
/** One would-be change: a bid (cents, money keys: absent without the ad-spend permission) or a keyword's state. */
export interface PreviewSample {
  target: Ref | null
  adGroup: Ref | null
  campaign: Ref | null
  field?: 'bid' | 'state'
  fromCents?: number | null
  toCents?: number | null
  from?: string | null
  to?: string | null
  held: PreviewHeld | null
  /** The held change's own words (label for the chip, reason for its hover); older answers carry only `held`. */
  heldBy?: Hold | null
}
export interface PreviewResult {
  ruleId: string | null
  saved: boolean
  /** What the rule itself would change: the listed ones that go through, plus `unsampled`. */
  wouldChange: number
  /** Counted by a handler without being listed. */
  unsampled?: number
  brainInputs: number
  locked: number
  refused: number
  capped: boolean
  windowDays: number | null
  sample: PreviewSample[]
  note: string | null
  /** The held changes counted per word, with the campaigns they are on. */
  holds?: Array<Hold & { held: PreviewHeld; count: number; campaigns: Ref[] }>
  /** The body in one line, the same words as the rules list. */
  sentence?: string
}

export const HELD_WORD: Readonly<Record<PreviewHeld, string>> = { brain: 'Brain decides', brainStopped: 'Brain off', locked: 'Locked', market: 'Market not set up' }
export const HELD_MEANS: Readonly<Record<PreviewHeld, string>> = {
  brain: 'The Brain runs this campaign: the rule’s change is passed to the Brain for 7 days.',
  brainStopped: 'You stopped the Brain’s bids on this campaign: nothing changes.',
  locked: 'Automation may not change this campaign, or its bids are held by hand: the change is refused.',
  market: 'Nexus does not know Amazon’s bid limits in this market yet: the change is refused.',
}
export const heldTone = (h: PreviewHeld): 'info' | 'warning' => (h === 'brain' ? 'info' : 'warning')
/** A held change's chip and hover: the server's words, else the page's for its kind. */
export function sampleHold(s: Pick<PreviewSample, 'held' | 'heldBy'>): { label: string; reason: string; tone: 'info' | 'warning' } | null {
  if (!s.held) return null
  return { label: s.heldBy?.label || HELD_WORD[s.held], reason: s.heldBy ? holdReason(s.heldBy) : HELD_MEANS[s.held], tone: heldTone(s.held) }
}

const STATE_WORD: Readonly<Record<string, string>> = { ENABLED: 'On', PAUSED: 'Paused', ARCHIVED: 'Archived' }
export const stateWord = (s: string | null | undefined): string => (s ? STATE_WORD[s.toUpperCase()] ?? s : '—')

/** A would-be change as before → after, in money (a bid) or words (a state). */
export function sampleFromTo(s: PreviewSample, market: string | null): { label: string; from: string; to: string } {
  if (s.field === 'state') return { label: 'State', from: stateWord(s.from), to: stateWord(s.to) }
  return { label: 'Bid', from: marketMoney(s.fromCents ?? null, market), to: marketMoney(s.toCents ?? null, market) }
}

/** What a preview counts: keywords when every listed change is a state (pause / unpause), else bids. */
export const previewNoun = (p: Pick<PreviewResult, 'sample'>): 'bid' | 'keyword' =>
  p.sample.length > 0 && p.sample.every((s) => s.field === 'state') ? 'keyword' : 'bid'

/** "6 bids" — with what else would happen to the rest, in chips. */
export function previewParts(p: PreviewResult): Part[] {
  const parts: Part[] = [{ key: 'change', text: n(p.wouldChange, previewNoun(p)) }]
  if (p.unsampled) parts.push({ key: 'unsampled', text: `${p.unsampled} not listed` })
  if (p.brainInputs) parts.push({ key: 'brain', text: `${p.brainInputs} to Brain`, tone: 'info' })
  if (p.locked) parts.push({ key: 'locked', text: `${p.locked} locked`, tone: 'warning' })
  if (p.refused) parts.push({ key: 'refused', text: `${p.refused} refused`, tone: 'warning' })
  if (p.capped) parts.push({ key: 'capped', text: 'Daily limit reached', tone: 'warning' })
  return parts
}

/** Archive's answer (POST /bid-rules/:id/archive), as the Done step's words. */
export interface ArchiveAnswer { expiredAsks?: number; endedBrainInputs?: number; cancelledWrites?: number; already?: boolean }
export function archiveWords(a: ArchiveAnswer | null | undefined): string {
  if (a?.already) return 'Already archived'
  const parts = [
    'Archived',
    a?.expiredAsks ? `${n(a.expiredAsks, 'ask')} expired` : null,
    a?.endedBrainInputs ? `${n(a.endedBrainInputs, 'Brain input')} ended` : null,
    a?.cancelledWrites ? `${n(a.cancelledWrites, 'write')} cancelled` : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

// ── errors ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The server's own sentence from a failed read, shown under "X not read"; null for a bare HTTP code or a network failure
 * (the title and Try again say all there is).
 */
export function readError(message: string | null | undefined): string | null {
  const m = message?.trim()
  if (!m) return null
  if (/^Refused \(HTTP \d+/.test(m) || /^No answer/.test(m) || /^(Failed to fetch|NetworkError|Load failed)/i.test(m)) return null
  return m
}

// ── plurals for the page ────────────────────────────────────────────────────────────────────────────────────────────

export const plural = n
