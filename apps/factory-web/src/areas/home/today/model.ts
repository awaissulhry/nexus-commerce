import { z } from 'zod'

/**
 * Home › Today (SCR-029; design home.today, W1 parts): what the API answers (apps/factory-api modules/insights:
 * GET /home/today, GET /home/flow) and the ONE view model the screen draws. Rows, tiles, stages and their words come
 * from the API, already matched to the person (who may act on what, four eyes, money only with its grain); the web
 * adds the person's language for its own labels, the grouping, the keyboard and where each row opens.
 *
 * Not in W1 (they need storage; the Later schema list): Assign, Resolve with a note, Acknowledge, Snooze, Arrange this
 * page, "Handled today". No control for them is drawn. Waiting on others, key numbers and coming up are W2.
 */

// ---- the API's answers ---------------------------------------------------------------------------------------------------

const severity = z.enum(['HIGH', 'MEDIUM', 'LOW'])
const group = z.enum(['NOW', 'TODAY', 'THIS_WEEK', 'LATER'])

const phraseSchema = z.object({ key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])) })

/** The design's tiles (home.today focus-strip, W1): every row, Approvals (the reviews), Alerts on my records. */
export const TILES = ['ALL', 'APPROVAL', 'ALERT'] as const
export type Tile = (typeof TILES)[number]
export type Category = Exclude<Tile, 'ALL'>

export const todayItemSchema = z.object({
  key: z.string(),
  kind: z.string(),
  state: z.string(),
  category: z.enum(['APPROVAL', 'ALERT']),
  severity,
  severityWord: z.string(),
  group,
  record: z.object({ type: z.string(), id: z.string(), label: z.string() }),
  companyId: z.string().nullable(),
  siteId: z.string().nullable(),
  partyId: z.string().nullable(),
  /** English; the screen draws `words` in the person's language. */
  sentence: z.string(),
  why: z.string(),
  blocks: z.string().nullable(),
  words: z.object({ sentence: phraseSchema, why: phraseSchema, blocks: phraseSchema.nullable() }),
  /** The figure the sentence quotes (a field of `figures`), only when the person's grains reach it. */
  sentenceFigure: z.enum(['netAmount', 'purchaseAmount', 'marginPct', 'marginAmount']).nullable(),
  due: z.object({ date: z.string(), days: z.number().int(), word: z.enum(['OVERDUE', 'TODAY', 'SOON']).nullable() }).nullable(),
  since: z.string(),
  ageDays: z.number().int(),
  decide: z.enum(['REVIEW', 'OPEN']),
  /** Money the person's grains reach (the API dropped the rest). */
  figures: z
    .object({ currency: z.string(), netAmount: z.number().optional(), purchaseAmount: z.number().optional(), marginPct: z.string().optional(), marginAmount: z.number().optional() })
    .nullable(),
})
export type TodayItem = z.infer<typeof todayItemSchema>

export const todaySchema = z.object({
  asOf: z.string(),
  today: z.string(),
  counts: z.object({
    total: z.number().int(),
    now: z.number().int(),
    tiles: z.array(z.object({ tile: z.enum(TILES), count: z.number().int(), complete: z.boolean() })),
    byKind: z.array(z.object({ kind: z.string(), label: z.string(), count: z.number().int(), complete: z.boolean() })),
  }),
  total: z.number().int(),
  items: z.array(todayItemSchema),
  nextCursor: z.string().nullable(),
  live: z.object({ events: z.array(z.string()) }),
})
export type TodayAnswer = z.infer<typeof todaySchema>

const stageSchema = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
  late: z.number().int().nullable(),
  oldestDays: z.number().int().nullable(),
  filter: z.record(z.string(), z.string()).nullable(),
  exact: z.boolean(),
})

export const flowSchema = z.object({
  asOf: z.string(),
  lenses: z.array(z.object({ lens: z.string(), label: z.string(), list: z.string().nullable(), stages: z.array(stageSchema), complete: z.boolean(), live: z.object({ events: z.array(z.string()) }) })),
})
export type FlowAnswer = z.infer<typeof flowSchema>

// ---- the view model ---------------------------------------------------------------------------------------------------------

/** One part of the page as it loads: each section loads, fails and retries on its own. */
export type Loaded<T> = { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly data: T }

export type LiveState = 'connecting' | 'live' | 'offline'

/** A row as the screen draws it: the API's row and where it opens. */
export interface QueueItem extends TodayItem {
  /** Its record (own page, else its panels), with the company prefix: a real link (⌘-click: a new tab). */
  readonly href: string
  /** REVIEW kinds the module reviews itself (mail to sort): that review; null when Today's decide modal decides it. */
  readonly reviewHref: string | null
}

export interface QueueTile {
  readonly tile: Tile
  readonly count: number
  /** False: a source of its rows stopped at its limit, the count is a lower bound ("at least 200"). */
  readonly complete: boolean
}

export interface QueueData {
  readonly asOf: string
  readonly total: number
  readonly needYou: number
  readonly now: number
  /** The three tiles, always (0 is an answer). */
  readonly tiles: readonly QueueTile[]
  /** The kinds' names, for the chip of a `?kind=` deep link. */
  readonly kindLabels: Readonly<Record<string, string>>
  readonly items: readonly QueueItem[]
  /** The list goes on (`nextCursor`). */
  readonly more: boolean
  readonly loadingMore: boolean
  /** Rows a live change brought that wait behind "N new · Show" (rows never jump in). */
  readonly fresh: number
}

export interface FlowStage {
  readonly key: string
  readonly label: string
  readonly count: number
  readonly late: number | null
  readonly oldestDays: number | null
  /** The list page with the stage's filter; null: no list page shows it (no link drawn). */
  readonly href: string | null
  /** The list shows more than this stage (it cannot filter it exactly). */
  readonly inexact: boolean
}

export interface FlowLensView {
  readonly lens: string
  readonly label: string
  readonly stages: readonly FlowStage[]
  readonly complete: boolean
}

export interface PanelRow {
  readonly id: string
  readonly label: string
  readonly sub: string | null
  /** One status word (a message key of `home`, or text). */
  readonly word: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null
  /** A date, ISO day or instant. */
  readonly date: string | null
  readonly href: string
}

export interface PanelView {
  readonly id: string
  /** `home:` key of its title (a question). */
  readonly titleKey: string
  readonly emptyKey: string
  readonly state: Loaded<{ readonly rows: readonly PanelRow[]; readonly more: boolean }>
  /** "See all": the list page, or null while no page shows that list. */
  readonly seeAllHref: string | null
}

export interface NewVerb {
  readonly id: string
  readonly labelKey: string
  /** Its create page; null while that page is not built (the item is held with the reason). */
  readonly href: string | null
}

/** The quote approval review of Today's decide modal (quotes module: GET /sales/quotes/:id). */
export interface QuoteReview {
  readonly quoteId: string
  readonly number: string
  /** The quote's version: the decision is refused (409) if it moved. */
  readonly version: number
  readonly customer: string
  readonly status: string
  readonly revision: number
  readonly currency: string
  readonly netAmount: number | null
  readonly marginPct: string | null
  readonly marginFloorPct: string | null
  readonly validUntil: string | null
  /** The rules that break, in the quotes module's words. */
  readonly rules: readonly { readonly reason: string; readonly message: string }[]
  readonly request: { readonly reasons: readonly string[]; readonly note: string | null; readonly askedAt: string } | null
  /** A request waits: it can be decided now. */
  readonly decidable: boolean
}

export type ReviewState = Loaded<QuoteReview>

export interface Notice {
  readonly key: string
  readonly tone: 'success' | 'warning' | 'danger' | 'info'
  readonly params?: Readonly<Record<string, string | number>>
}

export interface TodayViewModel {
  /** The person may open Today (home.view); else the page says so and loads nothing. */
  readonly access: 'open' | 'refused'
  /** The read's clock (AsOf renders the same on the server and the client). */
  readonly now: number
  readonly live: LiveState
  /** The pressed tile (`?tile=APPROVAL|ALERT`); null: every row. */
  readonly tile: Category | null
  /** A deep link to one kind (`?kind=`); the tiles clear it. */
  readonly kind: string | null
  readonly queue: Loaded<QueueData>
  /** Null: the person sees no lens (the section is absent). */
  readonly flow: Loaded<readonly FlowLensView[]> | null
  readonly lens: string | null
  readonly panels: readonly PanelView[]
  readonly newVerbs: readonly NewVerb[]
  readonly printHref: string
  /** The row open in the decide modal (`?open=`). */
  readonly open: string | null
  /** Quote approval reviews by row key. */
  readonly reviews: Readonly<Record<string, ReviewState>>
  readonly busy: boolean
  readonly notice: Notice | null
}

// ---- rules of the screen -----------------------------------------------------------------------------------------------------

export const GROUP_ORDER = ['NOW', 'TODAY', 'THIS_WEEK', 'LATER'] as const
export type Group = (typeof GROUP_ORDER)[number]

/** The rows by group, each group keeping the API's rank (severity, due, age). Empty groups are left out. */
export function groupItems<T extends { readonly group: string }>(items: readonly T[]): { readonly group: Group; readonly items: readonly T[] }[] {
  return GROUP_ORDER.map((name) => ({ group: name, items: items.filter((item) => item.group === name) })).filter((entry) => entry.items.length > 0)
}

/** The kinds Today's decide modal decides itself (the quotes module's approve / reject). */
export const DECIDED_HERE: ReadonlySet<string> = new Set(['QUOTE_APPROVAL'])

/** The message key and count of a row's due date: "Overdue 2 days", "Due today", "Due in 3 days", "Due 12/11/2026". */
export function dueWords(due: TodayItem['due']): { key: string; count: number; date: string } | null {
  if (!due) return null
  if (due.days < 0) return { key: 'today.due.overdue', count: -due.days, date: due.date }
  if (due.days === 0) return { key: 'today.due.today', count: 0, date: due.date }
  if (due.days <= 7) return { key: 'today.due.soon', count: due.days, date: due.date }
  return { key: 'today.due.on', count: due.days, date: due.date }
}

/** The tile's number in words: a lower bound when its source stopped at its limit. */
export function tileCount(tile: Pick<QueueTile, 'count' | 'complete'>): { key: string; count: number } {
  return tile.complete ? { key: 'today.tiles.count', count: tile.count } : { key: 'today.tiles.atLeast', count: tile.count }
}

/** A live change concerns the page when its type is one the sections named (`live.events`). */
export function wantsChange(events: ReadonlySet<string>, type: string): boolean {
  return events.has(type)
}

/** How many rows of a fresh first page the screen does not show yet (they wait behind "N new · Show"). */
export function freshCount(shown: readonly { readonly key: string }[], fetched: readonly { readonly key: string }[]): number {
  const seen = new Set(shown.map((item) => item.key))
  return fetched.filter((item) => !seen.has(item.key)).length
}

/** After a decision: the row after it in the list as it was, else the one before, else none. */
export function nextAfter(keys: readonly string[], decided: string): string | null {
  const index = keys.indexOf(decided)
  if (index < 0) return keys[0] ?? null
  return keys[index + 1] ?? keys[index - 1] ?? null
}

/** The queue's keys: j / k move (and the arrows), Enter or o opens, Escape leaves. Null: not ours. */
export function queueKey(key: string, modifiers: { readonly alt: boolean; readonly ctrl: boolean; readonly meta: boolean }): 'next' | 'previous' | 'open' | null {
  if (modifiers.alt || modifiers.ctrl || modifiers.meta) return null
  if (key === 'j' || key === 'ArrowDown') return 'next'
  if (key === 'k' || key === 'ArrowUp') return 'previous'
  if (key === 'Enter' || key === 'o') return 'open'
  return null
}

/** The decide modal's keys: a approves, r rejects (only where Today decides; never in a text field). */
export function decideKey(key: string, modifiers: { readonly alt: boolean; readonly ctrl: boolean; readonly meta: boolean; readonly inField: boolean }): 'approve' | 'reject' | null {
  if (modifiers.alt || modifiers.ctrl || modifiers.meta || modifiers.inField) return null
  if (key === 'a') return 'approve'
  if (key === 'r') return 'reject'
  return null
}

/** A reject reason: 3 to 1000 characters (the quotes module asks one; a word is not a reason). */
export function rejectReasonProblem(text: string): string | null {
  const length = text.trim().length
  if (length === 0) return 'today.decide.reject.reasonNeeded'
  if (length < 3) return 'today.decide.reject.reasonShort'
  if (length > 1000) return 'today.decide.reject.reasonLong'
  return null
}

// ---- New ▾ -------------------------------------------------------------------------------------------------------------------

/** The create verbs and the permission each needs; its page (`?new=1` opens the area's create dialog) once built. */
export const NEW_VERBS: readonly { readonly id: string; readonly permission: string; readonly page: string }[] = Object.freeze([
  { id: 'quote', permission: 'quotes.manage', page: '/sales/quotes' },
  { id: 'purchaseOrder', permission: 'purchasing.manage', page: '/purchasing/orders' },
  { id: 'workOrder', permission: 'workorders.manage', page: '/production/work-orders' },
  { id: 'party', permission: 'parties.manage', page: '/parties' },
  { id: 'style', permission: 'product.styles.manage', page: '/product/styles' },
  { id: 'material', permission: 'product.materials.manage', page: '/product/materials' },
  { id: 'registerEntry', permission: 'compliance.register.manage', page: '/compliance/register' },
  { id: 'certificate', permission: 'compliance.certificates.manage', page: '/compliance/certificates' },
])

/** The verbs this person's permissions allow; a verb whose page is not built yet is held (href null). */
export function newVerbsFor(permissions: ReadonlySet<string>, built: ReadonlySet<string>, prefix: string): NewVerb[] {
  return NEW_VERBS.filter((verb) => permissions.has(verb.permission)).map((verb) => ({
    id: verb.id,
    labelKey: `today.new.${verb.id}`,
    href: built.has(verb.page) ? `${prefix}${verb.page}?new=1` : null,
  }))
}
