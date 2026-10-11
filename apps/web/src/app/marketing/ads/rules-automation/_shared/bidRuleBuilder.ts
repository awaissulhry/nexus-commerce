/**
 * bidRuleBuilder.ts — the bid rule builder's own words and rules, pure and tested in Node (2026-10-10, Owner decision:
 * ONE way to make and edit a bid rule — this builder; the Bid page's 3-step dialog is gone).
 *
 *   preview    the body of POST /api/advertising/bid-rules/preview for the UNSAVED rule, and its answer read safely
 *              (an older API without `sentence`, `heldBy` or `holds` still reads)
 *   mode       Off · Watch · Ask me · Auto, the step a new rule starts on, and why a step cannot be picked
 *   max bid    the highest bid a new rule starts with (never "no max")
 *   schedule   what the evaluator really runs (ads-rule-schedule.ts), so the form never shows a schedule it does not keep
 *   words      plain words for the bid surface: actions, metrics, compare signs, the starts
 *
 * Only the bid surface reads this file; the other rule types keep their own words in RuleBuilder.tsx.
 */
import { settledLagDays } from '@nexus/shared/data-vintage'
import { GATE_EVIDENCE, type BidMode } from './ruleBuilderSave'
import { LATE_SALES_NOTE } from './ruleWindowCopy'

// ── mode ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type { BidMode }
export const BID_MODES: readonly BidMode[] = ['OFF', 'WATCH', 'ASK', 'AUTO']
export const isBidMode = (v: unknown): v is BidMode => typeof v === 'string' && (BID_MODES as readonly string[]).includes(v)

/** What each step does — the same words as the Bid page's mode list (bid/rules/bidRulesModel.ts MODE_MEANS). */
export const BID_MODE_MEANS: Readonly<Record<BidMode, string>> = {
  OFF: 'Does not run.',
  WATCH: 'Runs and records what it would change. Changes nothing.',
  ASK: 'You decide each change.',
  AUTO: 'Changes bids by itself, inside your limits.',
}

/**
 * A new bid rule starts on Ask me: today's create path stores PROPOSE with the Manual belt (ruleBuilderSave
 * `levelToSend` / `beltToSave`), and a new rule is never sent Auto (the graduation gate, D-R1).
 */
export const NEW_BID_MODE: BidMode = 'ASK'

/** Why Auto cannot be picked on a new rule. */
export const AUTO_HELD_AT_CREATE = `New rules reach Auto after ${GATE_EVIDENCE}.`
/** Why Auto cannot be picked for a rule that pauses or unpauses keywords (the graduation ceiling, pure.ts HOLDS.alwaysAsks). */
export const AUTO_HELD_PAUSING = 'Pausing or unpausing a keyword always waits for your yes.'
const PAUSING_OPS = new Set(['pauseTarget', 'enableTarget'])

/**
 * Why a step cannot be picked, or null. Only Auto is ever held here: on a new rule (the gate needs 14 days first), for a
 * rule whose action pauses or unpauses keywords, and for a saved rule the server says cannot reach Auto yet (the bid
 * rules list's `mode.autoLocked`). A rule already on Auto keeps it.
 */
export function bidModeHeld(step: string, s: { isEdit: boolean; initial: BidMode | null; ops: readonly string[]; autoLocked: { label: string; reason?: string } | null }): string | null {
  if (step !== 'AUTO') return null
  if (!s.isEdit) return AUTO_HELD_AT_CREATE
  if (s.initial === 'AUTO') return null
  if (s.ops.some((op) => PAUSING_OPS.has(op))) return AUTO_HELD_PAUSING
  if (s.autoLocked) return s.autoLocked.reason || s.autoLocked.label
  return null
}

// ── highest bid ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The highest bid a new rule starts with when no bid can be read (no permission to see bids, or none in the market). */
export const MAX_BID_FALLBACK_CENTS = 200

/**
 * The highest bid a NEW bid rule starts with, in cents (audit S14: the "Bid toward my ACoS" start had no max, and its
 * preview proposed €0.40 → €4.34).
 *
 * The rule: one and a half times the highest bid any keyword in the rule's reach carries today, rounded UP to the next
 * 10 cents, never below twice the lowest bid. Why this shape:
 *   · ABOVE every bid today: the bid action clamps a new bid to the rule's highest bid (bid_apply), so a ceiling under a
 *     keyword's current bid would LOWER that keyword even on a "raise" — a change nobody asked for.
 *   · Close to them: a computed action (bid toward ACoS, sales per click) can multiply a bid several times over on thin
 *     data; ×1.5 lets a rule raise the best keyword half again in one step and no further.
 *   · When no bid can be read, €2.00 — forty times Amazon's EU minimum, and the preview shows any bid it would cap.
 * The person can change it or clear it ("no max" is then their choice, not a default). An edit keeps what is stored.
 */
export function defaultMaxBidCents(bidsCents: readonly number[], floorCents = 5): number {
  const bids = bidsCents.filter((b) => Number.isFinite(b) && b > 0)
  if (!bids.length) return Math.max(MAX_BID_FALLBACK_CENTS, floorCents * 2)
  const top = Math.max(...bids)
  return Math.max(Math.ceil((top * 1.5) / 10) * 10, floorCents * 2)
}

/** Cents as the form's text: 200 → "2", 150 → "1.5", 95 → "0.95". */
export const centsToInput = (cents: number): string => String(Math.round(cents) / 100)

// ── the lookback note ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The note beside "Over" (audit §5: the old Lookback column's "Amazon still attributing" warning was lost): the window
 * ends where Amazon has settled the days — normally the attribution lag plus one (ruleWindowCopy settledWindowText).
 */
export function lookbackNote(now: number = Date.now()): { tag: string; tip: string } {
  const ago = settledLagDays('SPONSORED_PRODUCTS') + 1
  // The last settled day, as the keyword's Why tab says it ("Data to 3 Oct"); "Ends 8 d ago" meant nothing on its own
  // (re-audit R17). A day in Rome, the page's clock.
  const day = DATA_DAY.format(new Date(now - ago * 86_400_000))
  return { tag: `Data to ${day}`, tip: `${LATE_SALES_NOTE} The newest ${ago} days are left out.` }
}
const DATA_DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Rome' })

// ── schedule ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The evaluator's truth (apps/api/src/services/advertising/ads-rule-schedule.ts scheduleIsDue):
 *   · Daily · Weekly · Monthly · Custom run at a time of day in the rule's zone; Weekly is 7 days after the last run (its
 *     day is NOT read — only Custom in weeks honours a day), Monthly 30 days;
 *   · Hourly runs when the last run is 55 minutes old — no time, no zone;
 *   · a missing or unknown frequency runs on EVERY 15-minute tick;
 *   · a zone other than cet · utc · pst · est is read as Rome.
 * So the form offers "Every 15 min" (stored as that word, which the evaluator reads as unknown → every tick), opens a
 * stored rule on what it really runs, and shows time and zone only where they are read.
 */
export const EVERY_TICK = 'Every 15 min'
const TIMED = new Set(['Daily', 'Weekly', 'Monthly', 'Custom'])
const KNOWN_FREQUENCIES = new Set([...TIMED, 'Hourly', EVERY_TICK])
export const isTimedFrequency = (f: string): boolean => TIMED.has(f)
const ZONES = new Set(['cet', 'utc', 'pst', 'est'])

/** The frequency and zone a stored schedule really runs on, in the form's values. */
export function scheduleAsRun(s: { frequency?: unknown; timezone?: unknown } | null | undefined): { frequency: string; timezone: string } {
  const f = typeof s?.frequency === 'string' ? s.frequency : ''
  const tz = typeof s?.timezone === 'string' ? s.timezone : ''
  return {
    frequency: s && KNOWN_FREQUENCIES.has(f) ? f : EVERY_TICK,
    timezone: ZONES.has(tz) ? tz : 'cet',
  }
}

/** The frequency options' notes: what each one really does (a hover line, not a sentence on the page). */
export const FREQUENCY_NOTE: Readonly<Record<string, string>> = {
  Daily: 'Once a day at the time you pick',
  Weekly: '7 days after the last run, at the time you pick',
  Monthly: '30 days after the last run, at the time you pick',
  Custom: 'Every N days, weeks or months',
  Hourly: 'About once an hour',
  [EVERY_TICK]: 'Every 15 minutes',
}

// ── words for the bid surface ────────────────────────────────────────────────────────────────────────────────────────

/** The THEN actions in plain words (the values are RuleBuilder's BID_ACTIONS, unchanged). */
export const BID_ACTION_WORDS: Readonly<Record<string, string>> = {
  targetAcos: 'Bid toward ACoS',
  curBidTargetAcos: 'Step toward ACoS',
  decPct: 'Lower bid by %',
  incPct: 'Raise bid by %',
  decAbs: 'Lower bid by',
  incAbs: 'Raise bid by',
  set: 'Set bid to',
  setCpc: 'Bid = CPC',
  revPerClick: 'Bid = sales per click',
  pauseTarget: 'Pause keyword',
  enableTarget: 'Unpause keyword',
}
/** The order the plain list shows them in: the common ones first. */
export const BID_ACTION_ORDER: readonly string[] = ['targetAcos', 'decPct', 'incPct', 'decAbs', 'incAbs', 'set', 'curBidTargetAcos', 'setCpc', 'revPerClick', 'pauseTarget', 'enableTarget']

const METRIC_WORDS: Readonly<Record<string, string>> = { ACOS: 'ACoS', 'PPC Orders': 'PPC orders', 'Current Bid': 'Bid' }
export const bidMetricWord = (metric: string): string => METRIC_WORDS[metric] ?? metric
export const BID_OPERATORS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'gt', label: '>' }, { value: 'gte', label: '≥' }, { value: 'lt', label: '<' }, { value: 'lte', label: '≤' },
  { value: 'eq', label: '=' }, { value: 'ne', label: '≠' },
]

export interface BidStart {
  id: string
  name: string
  /** The rule in one line, in the server's sentence form (bid-rules/pure.ts ruleSentence). */
  line: string
  windowDays: number
  conditions: Array<{ metric: string; op: string; value: string }>
  action: { op: string; value: string }
}

/** The starts (the dialog's four, plus break-even). Made-up thresholds the person edits; not advice for any product. */
export const BID_STARTS: readonly BidStart[] = [
  { id: 'acos', name: 'Bid toward 25 % ACoS', line: 'If clicks ≥ 10 and orders ≥ 1 over 14 d → bid toward 25 %', windowDays: 14, conditions: [{ metric: 'Clicks', op: 'gte', value: '10' }, { metric: 'Orders', op: 'gte', value: '1' }], action: { op: 'targetAcos', value: '25' } },
  { id: 'nosales', name: 'Lower bids: clicks, no sales', line: 'If clicks ≥ 20 and orders = 0 over 14 d → bid −15 %', windowDays: 14, conditions: [{ metric: 'Clicks', op: 'gte', value: '20' }, { metric: 'Orders', op: 'eq', value: '0' }], action: { op: 'decPct', value: '15' } },
  { id: 'highacos', name: 'Cut bids on high ACoS', line: 'If ACoS > 35 % and clicks ≥ 10 over 14 d → bid −15 %', windowDays: 14, conditions: [{ metric: 'ACOS', op: 'gt', value: '35' }, { metric: 'Clicks', op: 'gte', value: '10' }], action: { op: 'decPct', value: '15' } },
  { id: 'winners', name: 'Raise bids on winners', line: 'If ACoS < 20 % and orders ≥ 2 over 14 d → bid +10 %', windowDays: 14, conditions: [{ metric: 'ACOS', op: 'lt', value: '20' }, { metric: 'Orders', op: 'gte', value: '2' }], action: { op: 'incPct', value: '10' } },
  { id: 'breakeven', name: 'Bid break-even', line: 'If ACoS > 30 % and clicks ≥ 10 over 14 d → bid = sales per click', windowDays: 14, conditions: [{ metric: 'ACOS', op: 'gt', value: '30' }, { metric: 'Clicks', op: 'gte', value: '10' }], action: { op: 'revPerClick', value: '' } },
]
/** The short label of each start on its button. */
export const BID_START_LABEL: Readonly<Record<string, string>> = { acos: 'Bid toward ACoS', nosales: 'Cut no-sale bids', highacos: 'Cut high ACoS', winners: 'Raise winners', breakeven: 'Break-even' }

// ── the live preview ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The body of POST /api/advertising/bid-rules/preview. An unsaved rule (new or edited) sends its body as the builder
 * would save it — the same `actions` and `conditions` Save sends, so the preview cannot describe another rule. A saved
 * rule's id rides along so the server applies the rule's own scope below the market. A rule the builder cannot fully draw
 * (engine-native, `locked`) is previewed as SAVED: the server refuses unsaved edits of those.
 * "All markets" is null (the server's word), as Save sends it.
 */
export function bidPreviewBody(s: { ruleId: string | null; locked: boolean; actions: unknown[]; conditions: unknown[]; scopeMarket: string; limit?: number }): Record<string, unknown> {
  const limit = s.limit ?? 8
  if (s.locked && s.ruleId) return { ruleId: s.ruleId, limit }
  return {
    ...(s.ruleId ? { ruleId: s.ruleId } : {}),
    actions: s.actions,
    conditions: s.conditions,
    scopeMarketplace: s.scopeMarket && s.scopeMarket !== 'all' ? s.scopeMarket : null,
    limit,
  }
}

/** What keeps the preview from running, one short chip each (empty = it may run). */
export function bidPreviewBlockers(s: { conditionsFilled: boolean; thenFilled: boolean; numbersValid: boolean; campaigns: number; scopeMarket: string; locked: boolean }): string[] {
  if (s.locked) return []
  const out: string[] = []
  if (s.campaigns === 0 && (!s.scopeMarket || s.scopeMarket === 'all')) out.push('Pick a market or campaigns')
  if (!s.conditionsFilled) out.push('Fill every condition')
  if (!s.thenFilled) out.push('Fill the action')
  if (!s.numbersValid) out.push('Fix the numbers')
  return out
}

export interface PreviewRef { id: string; name: string; href?: string | null }
export interface PreviewHold { held: string; label: string; reason: string; count: number }
export interface PreviewRow {
  key: string
  keyword: string
  campaign: PreviewRef | null
  adGroup: PreviewRef | null
  field: 'bid' | 'state'
  fromCents: number | null | undefined
  toCents: number | null | undefined
  from: string | null
  to: string | null
  hold: { label: string; reason: string } | null
}
export interface BidPreview {
  /** The rule in one line, as the rules list says it; null when the API does not send it. */
  sentence: string | null
  wouldChange: number
  /** Counted by the engine without being listed. */
  unsampled: number
  holds: PreviewHold[]
  rows: PreviewRow[]
  /** What the count counts: keywords when every listed change is a pause / unpause, else bids. */
  noun: 'bid' | 'keyword'
  note: string | null
  windowDays: number | null
}

/** The page's words for a hold when the API sends only its code (before `heldBy`): audit §2. */
export const HOLD_WORDS: Readonly<Record<string, { label: string; reason: string }>> = {
  brain: { label: 'Brain decides', reason: 'The brain sets the bids there, so this rule’s change goes to the brain for 7 days.' },
  brainStopped: { label: 'Brain off', reason: 'You stopped the brain’s bids there, so nothing changes.' },
  locked: { label: 'Locked', reason: 'Not on the live-change list, bids held by hand, or the account takes no changes.' },
  market: { label: 'Market not set up', reason: 'Nexus does not know Amazon’s bid limits in this market yet, so it changes nothing there.' },
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const ref = (v: unknown): PreviewRef | null => {
  const o = obj(v)
  const id = o && (typeof o.id === 'string' || typeof o.id === 'number') ? String(o.id) : null
  return o && id ? { id, name: text(o.name) ?? id, href: typeof o.href === 'string' ? o.href : null } : null
}
const cents = (v: unknown): number | null | undefined => (v === undefined ? undefined : typeof v === 'number' && Number.isFinite(v) ? v : null)
const holdOf = (v: unknown, code: unknown): { label: string; reason: string } | null => {
  const h = obj(v)
  const label = h ? text(h.label) : null
  if (label) return { label, reason: (h && text(h.reason)) ?? label }
  return typeof code === 'string' && HOLD_WORDS[code] ? HOLD_WORDS[code] : null
}

/** The preview's answer, read safely: unknown or missing fields read as none, never as a crash. */
export function readBidPreview(json: unknown): BidPreview | null {
  const j = obj(json)
  if (!j || typeof j.wouldChange !== 'number') return null
  const sample = Array.isArray(j.sample) ? j.sample : []
  const rows: PreviewRow[] = sample.flatMap((x, i) => {
    const s = obj(x)
    if (!s) return []
    const target = ref(s.target)
    const adGroup = ref(s.adGroup)
    return [{
      key: `${target?.id ?? ''}:${adGroup?.id ?? ''}:${i}`,
      keyword: target?.name ?? adGroup?.name ?? '—',
      campaign: ref(s.campaign),
      adGroup,
      field: s.field === 'state' ? 'state' : 'bid',
      fromCents: cents(s.fromCents),
      toCents: cents(s.toCents),
      from: text(s.from),
      to: text(s.to),
      hold: s.held == null && s.heldBy == null ? null : holdOf(s.heldBy, s.held),
    } satisfies PreviewRow]
  })
  let holds: PreviewHold[] = []
  if (Array.isArray(j.holds)) {
    holds = j.holds.flatMap((x) => {
      const h = obj(x)
      const label = h ? text(h.label) : null
      return h && label && num(h.count) > 0 ? [{ held: String(h.held ?? h.kind ?? label), label, reason: text(h.reason) ?? label, count: num(h.count) }] : []
    })
  } else {
    // An older answer: the brain's count and the locked count, in the page's words.
    if (num(j.brainInputs) > 0) holds.push({ held: 'brain', ...HOLD_WORDS.brain, count: num(j.brainInputs) })
    if (num(j.locked) > 0) holds.push({ held: 'locked', ...HOLD_WORDS.locked, count: num(j.locked) })
  }
  return {
    sentence: text(j.sentence),
    wouldChange: num(j.wouldChange),
    unsampled: num(j.unsampled),
    holds,
    rows,
    noun: rows.length > 0 && rows.every((r) => r.field === 'state') ? 'keyword' : 'bid',
    note: text(j.note),
    windowDays: typeof j.windowDays === 'number' ? j.windowDays : null,
  }
}

/** "1 bid", "6 bids", "2 keywords". */
export const countWords = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/** The name a rule saves with when the person typed none: its sentence, cut to the length a name takes. */
export function nameOrSentence(name: string, sentence: string | null): string {
  const typed = name.trim()
  if (typed) return typed
  const s = (sentence ?? '').trim()
  return s.length > 120 ? `${s.slice(0, 119)}…` : s
}
