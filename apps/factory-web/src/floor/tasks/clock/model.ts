import type { ClockAction, ClockFlag, ClockSource, ClockState } from '@nexus/factory-domain/people/clock/rules'

/**
 * SCR-170 — Clock in & out, the rules that need no screen (design floor.clock; MES-223, MES-224, MES-239, MES-199,
 * MES-117): the bar of a state (main action last, under the thumb; Enter presses it), what the tablet knows after an
 * action it saved itself, the flags of today's events, the running clock of the day, what a clock-out pauses. The times,
 * the words and the buttons come from the API (B-W2b-33); nothing here decides a rule of the clock. Pure, so tests hold it.
 */

export type { ClockAction, ClockFlag, ClockSource, ClockState }

export interface ClockEvent {
  readonly id: string
  readonly kind: ClockAction
  readonly source: ClockSource
  readonly occurredAt: string
  readonly flags: readonly ClockFlag[]
  readonly flagged: boolean
}

export interface ClockBreak {
  readonly label: string | null
  readonly startsAt: string
  readonly endsAt: string
}

/** GET /people/clock/floor: the person's own "Your time today", nobody else's. */
export interface ClockView {
  readonly person: { readonly workerId: string; readonly employeeId: string; readonly name: string }
  readonly state: ClockState
  readonly inSince: string | null
  readonly breakSince: string | null
  /** A clock-in never closed (older than 13 hours): the team leader corrects that day. */
  readonly forgottenSince: string | null
  readonly minutes: { readonly worked: number; readonly present: number; readonly breaks: number }
  readonly shift: { readonly label: string | null; readonly date: string; readonly startsAt: string; readonly endsAt: string; readonly source: 'ROSTER' | 'DEFAULT' } | null
  readonly breaks: {
    readonly mode: 'FIXED' | 'CLOCKED'
    readonly next: ClockBreak | null
    /** CLOCKED: the reminder once a stretch passes the rule (D.Lgs. 66/2003 art. 8). */
    readonly due: string | null
  }
  readonly autoClockOutAt: string | null
  /** The buttons, the main one first. */
  readonly actions: readonly ClockAction[]
  readonly next: ClockAction
  readonly events: readonly ClockEvent[]
  readonly serverTime: string
}

/** An item of GET /production/terminal/open, as far as the clock needs it. */
export interface OpenItem {
  readonly bundleId: string
  readonly bundleCode: string
  readonly operation: { readonly id: string; readonly seq: number; readonly name: string }
  readonly state: string
  readonly mine: boolean
  readonly pausedAtClockOut: boolean
}

export interface OpenWork {
  readonly items: readonly OpenItem[]
  readonly offer: { readonly bundleId: string; readonly workOrderOperationId: string; readonly words: string } | null
  readonly clockOutWarning: string | null
}

/** The way a person clocked, for the receipt. */
export type Receipt =
  /** The office recorded it. `name`: said when it is not the person signed in (a kiosk, a badge scanned here). */
  | { readonly kind: 'recorded'; readonly action: ClockAction; readonly at: string; readonly repeated: boolean; readonly name: string | null; readonly flags: readonly ClockFlag[] }
  /** Kept on this tablet: its time, and whether its clock looks wrong. */
  | { readonly kind: 'saved'; readonly action: ClockAction; readonly at: string; readonly clockWrong: boolean }
  /** A rule said no (the API's code and words). */
  | { readonly kind: 'refused'; readonly code: string; readonly message: string; readonly fix: string | null }
  /** One uniform answer for a badge or a PIN that does not open this tablet. */
  | { readonly kind: 'wrong' }
  /** The scanned code is no badge. */
  | { readonly kind: 'notBadge' }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'unavailable' }

/**
 * The bar of a state, the main action LAST (under the thumb; Enter): the API lists it first. Nothing known (offline, no
 * read on this tablet): the person says which, Clock in as the main one; the office keeps it as the tablet recorded it.
 */
export function barOf(view: Pick<ClockView, 'actions'> | null): readonly ClockAction[] {
  return view ? [...view.actions].reverse() : ['OUT', 'IN']
}

/** What Enter presses. */
export function mainActionOf(view: Pick<ClockView, 'actions'> | null): ClockAction {
  const bar = barOf(view)
  return bar[bar.length - 1] ?? 'IN'
}

/** The state an action leads to. */
export const stateAfter = (action: ClockAction): ClockState => (action === 'OUT' ? 'OUT' : action === 'BREAK_OUT' ? 'ON_BREAK' : 'IN')

const actionsIn = (state: ClockState, fixed: boolean): readonly ClockAction[] => (state === 'OUT' ? ['IN'] : state === 'IN' ? (fixed ? ['OUT'] : ['OUT', 'BREAK_OUT']) : ['BREAK_IN', 'OUT'])

/**
 * What the tablet knows after an action it saved itself (offline), until the office answers: the state and the buttons
 * move on, the minutes stay as last read.
 */
export function afterAction(view: ClockView, action: ClockAction, at: string): ClockView {
  const state = stateAfter(action)
  const fixed = view.breaks.mode === 'FIXED'
  return {
    ...view,
    state,
    inSince: state === 'OUT' ? null : action === 'IN' ? at : view.inSince,
    breakSince: state === 'ON_BREAK' ? at : null,
    forgottenSince: null,
    actions: actionsIn(state, fixed),
    next: state === 'OUT' ? 'IN' : state === 'IN' ? 'OUT' : 'BREAK_IN',
    breaks: { ...view.breaks, due: null },
  }
}

/** The flags of today's events, each once ("for your team leader"): a name and PIN, a wrong tablet clock. */
export function flagsOf(events: readonly Pick<ClockEvent, 'flags'>[]): ClockFlag[] {
  return [...new Set(events.flatMap((event) => event.flags))]
}

/** The running time of today for FloorElapsed (null: not clocked in). It counts from the moment of the read: the tablet's clock may be wrong. */
export function todayClock(view: Pick<ClockView, 'state' | 'minutes'>, readAt: number): { since: number; carriedMs: number; paused: boolean } | null {
  if (view.state === 'OUT') return null
  return { since: readAt, carriedMs: view.minutes.worked * 60_000, paused: view.state === 'ON_BREAK' }
}

/** The bundles a clock-out pauses: the person's own running work. */
export const runningBundles = (open: Pick<OpenWork, 'items'> | null): string[] => (open?.items ?? []).filter((item) => item.state === 'RUNNING' && item.mine).map((item) => item.bundleCode)

/** The work the last clock-out paused. */
export const pausedAtClockOut = (open: Pick<OpenWork, 'items'> | null): OpenItem[] => (open?.items ?? []).filter((item) => item.pausedAtClockOut)

/** "Continue bundle B-000123 at Op 30?": the item of the API's offer; null when there is none. */
export function offeredItem(open: OpenWork | null): OpenItem | null {
  const offer = open?.offer
  if (!offer) return null
  return open.items.find((item) => item.bundleId === offer.bundleId && item.operation.id === offer.workOrderOperationId) ?? null
}

/** The refusal codes with words of their own in `floor-clock` (any other shows the API's words). */
export const KNOWN_REFUSALS = ['ALREADY_IN', 'NOT_IN', 'ON_BREAK', 'NOT_ON_BREAK', 'ALREADY_ON_BREAK', 'BREAKS_FIXED', 'NO_EMPLOYEE', 'EMPLOYEE_LEFT', 'MONTH_CLOSED', 'OTHER_PERSON', 'CLOCK_AHEAD'] as const

/** How long a receipt stays for someone who is not the person signed in: the tablet does not keep showing another person's time. */
export const RECEIPT_MS = 8000
