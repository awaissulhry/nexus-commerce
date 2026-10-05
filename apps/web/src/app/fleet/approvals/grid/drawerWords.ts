/**
 * Approvals grid — the request drawer's words (docs/approvals-grid/PLAN.md §2, §3, §5, §6; build agent D2, 2026-10-05).
 *
 * Pure: ApprovalDrawer.tsx renders these, the API decides everything. Nothing here invents a result: a field the API
 * sent as null stays "not known", a channel answer Nexus cannot see is said to be unknown, never a success.
 *
 *   statusWords        the one status for the whole life of a request (PLAN §3), refined by the channel's answer
 *   timelineSteps      the API's timeline + the channel's answer, as DS Timeline steps (fallback words when empty)
 *   channelResultView  what the channel said; `unknown` always says Nexus cannot see it
 *   whyView            why it waits, why it failed or came back, or the outcome
 *   drawerVerbs        the same verbs as the grid row, per state
 *   EDIT_SPECS         edit, then approve: which argument holds the value and its kind, per tool (PLAN §5)
 */
import type { QueueAsker, QueueChange, QueueDetail, QueueEvent, QueueRow, QueueState, QueueTarget } from '@nexus/shared/approval-queue'
import type { Tone } from '@/design-system/primitives'

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

/* ── status (PLAN §3) ─────────────────────────────────────────────────────────────────────────── */

/**
 * The state → words and tone map: the SAME words and tones as the grid's `queueWords.ts` STATE_META (D1), copied, not
 * imported (the two were built side by side); the lead merges them into one module.
 */
export const STATE_WORDS: Record<QueueState, { label: string; tone: Tone }> = {
  waiting: { label: 'Waiting', tone: 'info' },
  starting: { label: 'Starting', tone: 'warning' },
  on_hold: { label: 'On hold', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  back_to_you: { label: 'Back to you', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
  replaced: { label: 'Replaced by an edit', tone: 'neutral' },
  recorded: { label: 'Recorded', tone: 'neutral' },
}

/** States in which nobody has decided yet (rawStatus `pending`): the request can still be approved, edited or rejected. */
export const PENDING_STATES: ReadonlySet<QueueState> = new Set<QueueState>(['waiting', 'failed', 'back_to_you'])

const CHANNEL_NAME: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy' }

/** "eBay IT", "Amazon", "IT"; null when the request names neither. */
export function whereWords(channel: string | null, market: string | null): string | null {
  const name = channel ? (CHANNEL_NAME[channel.toUpperCase()] ?? channel) : null
  const words = [name, market].filter(Boolean).join(' ')
  return words || null
}

/** The "Where" line: the channel and market, or plainly that it stays in Nexus or names no place. */
export function whereLine(row: Pick<QueueRow, 'channel' | 'market' | 'reachesOutside'>): string {
  return whereWords(row.channel, row.market) ?? (row.reachesOutside ? 'Not named in the request' : 'In Nexus only')
}

/** The pill: the state's words, and for a run that is over, how far it got (only what Nexus knows). */
export function statusWords(row: Pick<QueueRow, 'state' | 'plan' | 'channel' | 'market'>, channelResult?: QueueDetail['channelResult']): { label: string; tone: Tone } {
  const base = STATE_WORDS[row.state] ?? { label: row.state, tone: 'neutral' as Tone }
  if (row.state === 'running' && row.plan) {
    const progress = planProgress(row.plan)
    return { label: `Running · ${progress.done} of ${progress.max}`, tone: base.tone }
  }
  if (row.state !== 'done' || row.plan || !channelResult) return base
  const where = whereWords(row.channel, row.market) ?? 'the channel'
  switch (channelResult.state) {
    case 'reached': return { label: `Done · reached ${where}`, tone: 'success' }
    case 'waiting': return { label: `Done in Nexus · waiting for ${where}`, tone: 'info' }
    case 'failed': return { label: `Done in Nexus · ${where} did not take it`, tone: 'warning' }
    default: return { label: 'Done in Nexus', tone: 'success' }
  }
}

/** What approving it means, in one line: where it lands and whether it can be put back. */
export function consequenceWords(row: Pick<QueueRow, 'reachesOutside' | 'reversibility'>): string {
  const where = row.reachesOutside ? 'Reaches a marketplace or a buyer' : 'Stays in Nexus'
  const back = row.reversibility === 'full' ? 'can be undone' : row.reversibility === 'partial' ? 'can be partly undone' : 'cannot be undone'
  return `${where}; ${back}`
}

/** The label of the "what it is about" line, by the target's kind. */
export const TARGET_LABEL: Record<QueueTarget['kind'], string> = {
  product: 'Product',
  listing: 'Listing',
  campaign: 'Campaign',
  'ad-target': 'Ad target',
  order: 'Order',
  shipment: 'Shipment',
  'purchase-order': 'Purchase order',
  customer: 'Customer',
  supplier: 'Supplier',
  rule: 'Rule',
  other: 'About',
}

/** The product (or other target) as the header names it; null when the request names no single thing. */
export function targetWords(target: QueueTarget | null): { main: string; name: string | null; more: string | null; href: string | null } | null {
  if (!target) return null
  const main = target.sku ?? target.name ?? target.id
  if (!main) return target.count > 1 ? { main: plural(target.count, 'item'), name: null, more: null, href: null } : null
  return {
    main,
    name: target.sku && target.name ? target.name : null,
    more: target.count > 1 ? `and ${target.count - 1} more` : null,
    href: target.href,
  }
}

/** A plan's step counts: "34 of 120 done", and the steps that were skipped or failed. */
export function planProgress(plan: { steps: number; byStatus: Record<string, number> }): { done: number; value: number; max: number; words: string } {
  const count = (status: string) => Math.max(0, Number(plan.byStatus[status] ?? 0) || 0)
  const done = count('done')
  const skipped = count('skipped')
  const failed = count('failed')
  const max = Math.max(0, plan.steps)
  const extra = [skipped ? `${skipped} skipped` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(', ')
  return { done, value: Math.min(max, done + skipped + failed), max, words: `${done} of ${plural(max, 'step')} done${extra ? ` · ${extra}` : ''}` }
}

/* ── why / result ─────────────────────────────────────────────────────────────────────────────── */

export interface WhyView {
  /** A Banner (failed, handed back) or a labelled paragraph. */
  banner: boolean
  tone: Tone
  title: string
  text: string
}

/** Why it waits, why it failed or came back (prominent), or the outcome. Null when the API has nothing to say. */
export function whyView(row: Pick<QueueDetail, 'state' | 'note' | 'reason' | 'automation'>): WhyView | null {
  const said = (row.note ?? row.reason ?? '').trim()
  switch (row.state) {
    case 'failed':
      return { banner: true, tone: 'danger', title: 'The run failed', text: said || 'Nexus did not record why.' }
    case 'back_to_you':
      return { banner: true, tone: 'warning', title: 'Handed back to you: it did not run', text: said || 'Nexus did not record why.' }
    case 'waiting': {
      const why = (row.automation.whyWaits ?? said).trim()
      return why ? { banner: false, tone: 'neutral', title: 'Why it waits for you', text: why } : null
    }
    default:
      return said ? { banner: false, tone: 'neutral', title: 'Result', text: said } : null
  }
}

/** The label above the asker's own words: "Claude says". */
export function askerSaysLabel(asker: Pick<QueueAsker, 'kind' | 'label'>): string {
  switch (asker.kind) {
    case 'claude': return 'Claude says'
    case 'assistant': return 'The assistant says'
    case 'rule': return 'The rule says'
    case 'system': return 'Nexus says'
    default: return `${asker.label} says`
  }
}

/* ── timeline and the channel's answer ────────────────────────────────────────────────────────── */

const EVENT_TONE: Record<QueueEvent['kind'], Tone> = {
  asked: 'neutral',
  approved: 'info',
  held: 'info',
  undone: 'neutral',
  ran: 'success',
  failed: 'danger',
  handed_back: 'warning',
  rejected: 'neutral',
  expired: 'neutral',
  replaced: 'neutral',
  reached_channel: 'success',
  change_undone: 'info',
}

/** The words of an event the API sent without any (a failed run or a hand-back with no stored reason). */
const EVENT_FALLBACK: Record<QueueEvent['kind'], string> = {
  asked: 'Asked',
  approved: 'Approved',
  held: 'Held',
  undone: 'Approval taken back',
  ran: 'Ran',
  failed: 'The run failed',
  handed_back: 'Handed back to you',
  rejected: 'Rejected',
  expired: 'Nobody decided in time. Nothing changed.',
  replaced: 'Replaced by an edit',
  reached_channel: 'Reached the channel',
  change_undone: 'Put back (undone)',
}

/** For these kinds the API's words are the REASON (the row's note), so the step is named and the reason is its detail. */
const REASON_KINDS: ReadonlySet<QueueEvent['kind']> = new Set(['failed', 'handed_back'])

export function eventWords(event: Pick<QueueEvent, 'kind' | 'words'>): { label: string; detail: string | null } {
  const words = (event.words ?? '').trim()
  const fallback = EVENT_FALLBACK[event.kind] ?? 'Something happened'
  if (REASON_KINDS.has(event.kind)) return { label: fallback, detail: words || null }
  return { label: words || fallback, detail: null }
}

export interface ChannelResultView {
  title: string
  tone: Tone
  /** The API's own sentence, when it adds something to the title. */
  detail: string | null
}

/** What the channel said. `unknown` is ALWAYS "Nexus cannot see the channel's answer": never a success. */
export function channelResultView(result: NonNullable<QueueDetail['channelResult']>): ChannelResultView {
  const words = (result.words ?? '').trim() || null
  switch (result.state) {
    case 'reached': return { title: 'Reached the channel', tone: 'success', detail: words }
    case 'waiting': return { title: 'Waiting for the channel', tone: 'info', detail: words }
    case 'failed': return { title: 'Did not reach the channel', tone: 'danger', detail: words }
    default: return { title: 'Nexus cannot see the channel’s answer', tone: 'neutral', detail: words && /cannot see/i.test(words) ? null : words }
  }
}

/** A Timeline step, as the DS `TimelineStep` takes it (plain strings here, so this stays pure). */
export interface DrawerTimelineStep {
  key: string
  label: string
  tone: Tone
  /** ISO; null = not yet; absent = no time stored. */
  at?: string | null
  detail?: string
}

/** The API's events in order, then what is still to come (a run after the stop window), then the channel's answer. */
export function timelineSteps(detail: Pick<QueueDetail, 'timeline' | 'state' | 'channelResult'>): DrawerTimelineStep[] {
  const steps: DrawerTimelineStep[] = detail.timeline.map((event, index) => {
    const { label, detail: why } = eventWords(event)
    return { key: `${event.kind}:${index}`, label, tone: EVENT_TONE[event.kind] ?? 'neutral', at: event.at, ...(why ? { detail: why } : {}) }
  })
  if (detail.state === 'starting') steps.push({ key: 'runs', label: 'Runs when the stop window ends', tone: 'info', at: null })
  if (detail.state === 'on_hold') steps.push({ key: 'runs', label: 'Runs when the hold ends', tone: 'info', at: null })
  if (detail.channelResult) {
    const view = channelResultView(detail.channelResult)
    steps.push({ key: 'channel', label: view.title, tone: view.tone, ...(view.detail ? { detail: view.detail } : {}) })
  }
  return steps
}

/* ── the change itself ────────────────────────────────────────────────────────────────────────── */

/**
 * Lines or items: a bulk request that names several products shows its items (SKU, name, change); anything else shows
 * every change line. `more` = what the request covers beyond what is listed.
 */
export function changesView(detail: Pick<QueueDetail, 'allChanges' | 'items' | 'changeCount' | 'plan'>):
  | { mode: 'items'; items: QueueDetail['items']; more: number }
  | { mode: 'lines'; lines: QueueChange[]; more: number } {
  const skus = new Set(detail.items.map((item) => item.sku).filter(Boolean))
  if (!detail.plan && skus.size > 1) return { mode: 'items', items: detail.items, more: Math.max(0, detail.changeCount - detail.items.length) }
  return { mode: 'lines', lines: detail.allChanges, more: Math.max(0, detail.changeCount - detail.allChanges.length) }
}

/* ── verbs (the same as the grid row) ─────────────────────────────────────────────────────────── */

export interface DrawerVerbs {
  approve: boolean
  reject: boolean
  /** "Retry" for a failed run (approve again); null when not offered. */
  retry: string | null
  undo: boolean
  hold: boolean
}

export function drawerVerbs(state: QueueState): DrawerVerbs {
  switch (state) {
    case 'waiting': return { approve: true, reject: true, retry: null, undo: false, hold: false }
    case 'failed': return { approve: false, reject: true, retry: 'Retry', undo: false, hold: false }
    // As the grid row: a hand-back is approved again with Approve (the run re-checks it), a failed run with Retry.
    case 'back_to_you': return { approve: true, reject: true, retry: null, undo: false, hold: false }
    case 'starting': return { approve: false, reject: false, retry: null, undo: true, hold: true }
    case 'on_hold': return { approve: false, reject: false, retry: null, undo: true, hold: false }
    default: return { approve: false, reject: false, retry: null, undo: false, hold: false }
  }
}

/** "3f2a…41c9": enough to tell two requests apart on screen; the copy button copies the whole id. */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
}

/* ── edit, then approve (PLAN §5) ─────────────────────────────────────────────────────────────── */

export type EditKind = 'money' | 'number' | 'text'
type Args = Record<string, unknown>

/**
 * One editable value of one tool. Declared, never inferred: the server's POST /api/agent/fleet/approvals/:id/amend
 * patches `args` SHALLOWLY ({ ...args, ...patch }) and re-runs the tool's own handler on the result, so a key the tool
 * would ignore (a `price` on an "adjust by percent" request) would "succeed" and change nothing. A tool is listed here
 * only where the key alone is unambiguous, or where `when` can see from the request's own arguments that it is.
 * The bounds are a courtesy that catches a typo before the round trip; the real check is the tool's (the bid floor,
 * the price bounds, the authority pins), and its refusal is shown verbatim.
 */
export interface EditSpec {
  /** The argument the server patches. */
  arg: string
  kind: EditKind
  /** Money: typed in the currency's main unit; sent as such (`major`) or in minor units (`cents`, × 100). */
  unit?: 'major' | 'cents'
  /** Whole numbers only (a stock count). */
  integer?: boolean
  /** In the unit the person types (euros for money). */
  min?: number
  /** True when `min` itself is refused (a price must be above 0). */
  minExclusive?: boolean
  max?: number
  minLength?: number
  maxLength?: number
  /** The field's label: "New master price". */
  label: string
  /** The change line that holds the value now (its `to`), to start the field from when the arguments are not sent. */
  line?: RegExp
  /** How the line's `to` carries the amount, when not on its own ("“term” at €0.45"). */
  linePattern?: RegExp
  /** The value now, from the request's arguments (when the API sends them). */
  fromArgs?: (args: Args) => unknown
  /** The arguments patch; default `{ [arg]: value }`. */
  patch?: (value: number | string, args: Args | null) => Args
}

/** One tool's spec, or a choice by the request's arguments (null = not editable for these arguments). */
type SpecEntry = EditSpec | { needsArgs: true; pick: (args: Args) => EditSpec | null }

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * The edit-spec table. `needsArgs` entries are editable only when the detail carries the request's arguments
 * (`editArgs`, see `requestArgsOf`), which the API sends only when `canEdit`.
 */
export const EDIT_SPECS: Record<string, SpecEntry> = {
  // Master price, in the master currency (set-price's `price`, above 0).
  'set-price': { arg: 'price', kind: 'money', unit: 'major', min: 0, minExclusive: true, max: 1_000_000, label: 'New master price', line: /^base price$/i },
  // Amazon ads, in the campaign's currency, minor units. 5 cents is the tool's bid floor; €10 is a typo guard (the old card's).
  'set-target-bid': { arg: 'proposedBidCents', kind: 'money', unit: 'cents', min: 0.05, max: 10, label: 'New bid', line: /^bid$/i },
  'graduate-keyword': { arg: 'bidCents', kind: 'money', unit: 'cents', min: 0.05, max: 10, label: 'Starting bid', line: /^new exact keyword$/i, linePattern: / at ((?:[€£$]|[A-Z]{3} )?\d+(?:\.\d+)?)$/ },
  'set-campaign-budget': { arg: 'dailyBudgetCents', kind: 'money', unit: 'cents', min: 0.01, max: 100_000, label: 'New daily budget', line: /^daily budget$/i },
  'set-ebay-campaign-budget': { arg: 'dailyBudgetCents', kind: 'money', unit: 'cents', min: 1, max: 100_000, label: 'New daily budget', line: /^daily budget$/i },
  // Text: a public eBay reply (2–80 characters) and a product's SKU in Nexus.
  'reply-to-review': { arg: 'body', kind: 'text', minLength: 2, maxLength: 80, label: 'Your reply', fromArgs: (a) => a.body },
  'set-product-sku': { arg: 'sku', kind: 'text', minLength: 1, maxLength: 100, label: 'New SKU', line: /^sku$/i, fromArgs: (a) => a.sku },
  // The Matrix: only "set a price" carries one price; adjust-by-percent, copy and sale do not.
  'set-listing-price': {
    needsArgs: true,
    pick: (a) => (a.action === 'set-price'
      ? { arg: 'price', kind: 'money', unit: 'major', min: 0, minExclusive: true, max: 1_000_000, label: 'New listing price', fromArgs: (x) => x.price }
      : null),
  },
  'set-listing-stock': {
    needsArgs: true,
    pick: (a) => (a.action === 'pin-quantity'
      ? { arg: 'quantity', kind: 'number', integer: true, min: 0, max: 1_000_000, label: 'Pinned quantity', fromArgs: (x) => x.quantity }
      : a.action === 'set-buffer'
        ? { arg: 'buffer', kind: 'number', integer: true, min: 0, max: 1_000_000, label: 'Units held back (buffer)', fromArgs: (x) => x.buffer }
        : null),
  },
  // Own-warehouse stock: one row only (several rows are several values).
  'set-stock': {
    needsArgs: true,
    pick: (a) => {
      const items = Array.isArray(a.items) ? a.items : []
      const only = items.length === 1 && items[0] && typeof items[0] === 'object' ? (items[0] as Args) : null
      if (!only) return null
      return {
        arg: 'items', kind: 'number', integer: true, min: 0, max: 1_000_000, label: 'New stock count',
        fromArgs: () => only.quantity,
        patch: (value) => ({ items: [{ ...only, quantity: value }] }),
      }
    },
  },
}

/**
 * The request's own arguments (`QueueDetail.editArgs`, sent only when `canEdit`). Null when absent or not an object;
 * the tools that need them then show "ask for a new request".
 */
export function requestArgsOf(detail: unknown): Args | null {
  const value = detail && typeof detail === 'object' ? (detail as { editArgs?: unknown }).editArgs : null
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Args) : null
}

/** "€52.00" → { amount: 52, currency: "€" }; "SEK 120.00" → SEK; "52.00" → no currency. Null for anything else. */
export function parseMoneyText(text: string | null | undefined): { amount: number; currency: string | null } | null {
  const match = /^([−-])?(?:([€£$])|([A-Z]{3}) )?(\d+(?:\.\d+)?)$/.exec((text ?? '').trim())
  if (!match) return null
  const amount = Number(match[4]) * (match[1] ? -1 : 1)
  return Number.isFinite(amount) ? { amount, currency: match[2] ?? match[3] ?? null } : null
}

export interface EditField {
  tool: string
  spec: EditSpec
  /** The currency mark beside a money field ("€", "SEK"), when the request shows one. */
  currency: string | null
  /** What the field starts with, as typed text ("52.00"); "" when the value now is not known. */
  initial: string
  /** The value now as the request shows it ("€52.00"), for the hint; null when not known. */
  proposed: string | null
}

/** null = no edit at all (not editable now); `ask` = editable on the server, but not a single value this drawer can name. */
export type EditPlan = { kind: 'form'; field: EditField } | { kind: 'ask'; hint: string }

/** The hint for a request this drawer cannot edit. */
export function askAgainHint(asker: Pick<QueueAsker, 'kind'>): string {
  return asker.kind === 'claude' ? 'To change it, ask Claude for a new request.' : 'To change it, reject it and ask for a new request.'
}

const typed = (value: number, spec: EditSpec): string => {
  const shown = spec.kind === 'money' && spec.unit === 'cents' ? value / 100 : value
  return spec.kind === 'money' ? shown.toFixed(2) : String(shown)
}

export function editPlan(detail: Pick<QueueDetail, 'toolName' | 'canEdit' | 'state' | 'allChanges' | 'asker'>, args: Args | null): EditPlan | null {
  if (!detail.canEdit || !PENDING_STATES.has(detail.state)) return null
  const entry = EDIT_SPECS[detail.toolName]
  const spec = !entry ? null : 'needsArgs' in entry ? (args ? entry.pick(args) : null) : entry
  if (!spec) return { kind: 'ask', hint: askAgainHint(detail.asker) }

  // The value now: from the arguments when sent, else from the change line the request shows.
  const line = spec.line ? detail.allChanges.find((change) => spec.line!.test(change.label.trim())) : undefined
  const lineText = line?.to ? (spec.linePattern ? (spec.linePattern.exec(line.to)?.[1] ?? null) : line.to) : null
  const money = spec.kind === 'money' ? parseMoneyText(lineText) : null
  const fromArgs = args && spec.fromArgs ? spec.fromArgs(args) : args ? args[spec.arg] : undefined

  let initial = ''
  if (spec.kind === 'text') {
    const text = typeof fromArgs === 'string' ? fromArgs : lineText && !lineText.endsWith('…') ? lineText : ''
    initial = text
  } else if (num(fromArgs) !== null) {
    initial = typed(num(fromArgs)!, spec)
  } else if (money) {
    initial = money.amount.toFixed(2)
  } else if (spec.kind === 'number' && lineText && /^\d+$/.test(lineText.trim())) {
    initial = lineText.trim()
  }
  return {
    kind: 'form',
    field: { tool: detail.toolName, spec, currency: money?.currency ?? null, initial, proposed: lineText ?? (initial || null) },
  }
}

/** What the person typed, checked against the spec: the value to send (cents for a cents field), or why not. */
export function parseEditInput(field: EditField, raw: string): { ok: true; value: number | string } | { ok: false; error: string } {
  const { spec } = field
  const text = raw.trim()
  if (spec.kind === 'text') {
    if (text.length < (spec.minLength ?? 1)) return { ok: false, error: spec.minLength && spec.minLength > 1 ? `Write at least ${spec.minLength} characters.` : 'Write a value.' }
    if (spec.maxLength && text.length > spec.maxLength) return { ok: false, error: `Use ${spec.maxLength} characters at most (now ${text.length}).` }
    if (field.initial && text === field.initial.trim()) return { ok: false, error: 'That is the value the request already has.' }
    return { ok: true, value: text }
  }
  // "49,90" is a decimal comma; "1,234.50" or "1.234,50" are not accepted (no guessing at thousands).
  const normal = /^-?\d+,\d+$/.test(text) ? text.replace(',', '.') : text
  if (!/^-?\d+(\.\d+)?$/.test(normal)) return { ok: false, error: spec.kind === 'money' ? 'Type an amount, for example 49.90.' : 'Type a number.' }
  const value = Number(normal)
  if (spec.integer && !Number.isInteger(value)) return { ok: false, error: 'Use a whole number.' }
  if (spec.kind === 'money' && Math.abs(Math.round(value * 100) - value * 100) > 1e-6) return { ok: false, error: 'Use at most 2 decimals.' }
  if (spec.min !== undefined && (spec.minExclusive ? value <= spec.min : value < spec.min)) {
    return { ok: false, error: spec.minExclusive ? `Use more than ${formatTyped(field, spec.min)}.` : `Use at least ${formatTyped(field, spec.min)}.` }
  }
  if (spec.max !== undefined && value > spec.max) return { ok: false, error: `Use at most ${formatTyped(field, spec.max)}.` }
  const wire = spec.kind === 'money' && spec.unit === 'cents' ? Math.round(value * 100) : spec.kind === 'money' ? Math.round(value * 100) / 100 : value
  if (field.initial && Number(field.initial) === value) return { ok: false, error: 'That is the value the request already has.' }
  return { ok: true, value: wire }
}

/** A typed amount in words: "€0.05", "SEK 1.00", "10" (a count). */
export function formatTyped(field: EditField, value: number): string {
  if (field.spec.kind !== 'money') return String(value)
  const amount = value.toFixed(2)
  if (!field.currency) return amount
  return field.currency.length === 1 ? `${field.currency}${amount}` : `${field.currency} ${amount}`
}

/** A wire value in words, for the button: "Use €48.00 instead". */
export function formatWire(field: EditField, value: number | string): string {
  if (typeof value === 'string') return `“${value}”`
  return formatTyped(field, field.spec.kind === 'money' && field.spec.unit === 'cents' ? value / 100 : value)
}

/** The body of POST …/amend: `{ args: patch }`. */
export function editPatch(field: EditField, value: number | string, args: Args | null): Args {
  return field.spec.patch ? field.spec.patch(value, args) : { [field.spec.arg]: value }
}
