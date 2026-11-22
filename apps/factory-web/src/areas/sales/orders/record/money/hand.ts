import type { DepositRequest, Milestone, MilestoneKind, MoneyPlanAct, MoneyPlanBody, MoneyPlanPreview, Order, PlanFigures, ShareOrAmount, ShortWhy } from '../../api'
import { parseAmount, stillToPay } from '../../model'
import type { PlanRow } from './plan'
import { word, type MoneyWord } from './word'

/**
 * F-OM-201 (order MONEY tab, 10-design §9; 13-backend §3; 18-lead-settles L1) — the plan's hand windows, pure: what each window asks,
 * the ONE body it sends (POST …/money-plan and its preview: the act, the target's version, a reason of 3–500), and the five parts every
 * window says — What happens · The customer (told or not) · What never changes · Why (required, office only) · who and when (the row is
 * tagged "Set by hand", the history keeps the old value). A total is never typed: a share or an amount of ONE step, the rest goes to
 * another step the person picks. Accept short (L1): the deposit counts as paid, the missing part stays owed and goes on the final
 * invoice — no write-off here. The view draws it; the server checks it again and refuses in words (money/plan.ts planRefusalOf).
 */

export type HandField = 'share' | 'day' | 'kind' | 'label' | 'restTo' | 'from' | 'terms' | 'why'

export interface HandInput {
  readonly share: string
  readonly day: string
  readonly kind: MilestoneKind
  readonly label: string
  readonly restTo: string
  readonly from: string
  readonly termsId: string
  readonly why: ShortWhy
  readonly reason: string
}

export interface HandWindow {
  readonly title: MoneyWord
  /** The row it acts on, said under the title (its parts one after the other, " · "); [] the plan's head. F-OM-fx3 (W-11): Change the
   * deposit… says the deposit as it is now ("Deposit · 30 % · € 3,660.00 · open · nothing paid · page sent 20 Nov"). */
  readonly sub: readonly MoneyWord[]
  readonly go: MoneyWord
  readonly fields: readonly HandField[]
  readonly happens: readonly MoneyWord[]
  readonly told: MoneyWord
  readonly never: MoneyWord
  /** A fresh authenticator code follows the act (the terms always; another act when the server asks one). */
  readonly code: boolean
  /** A window whose act cannot be put back the same way (the button in the danger tone). */
  readonly danger: boolean
}

/** The reason every hand act keeps: 3 to 500 characters (the waive's own rule). */
export const HAND_REASON = Object.freeze({ min: 3, max: 500 })
/** A step's printed name (RENAME_STEP, ADD_STEP): at most 120 characters. */
export const HAND_LABEL_MAX = 120

export const reasonProblemOf = (reason: string): MoneyWord | null =>
  reason.trim().length < HAND_REASON.min ? word('moneyTab.hand.problem.reasonShort') : reason.trim().length > HAND_REASON.max ? word('moneyTab.hand.problem.reasonLong') : null

/** "25 %" (or "12,5%") is a share of the order total; "3.050,00" an amount (minor units); anything else: null. */
export function shareOf(text: string): ShareOrAmount | null {
  const trimmed = text.trim()
  const pct = /^(\d{1,3})(?:[.,](\d{1,2}))?\s*%$/.exec(trimmed)
  if (pct) {
    const value = `${pct[1]}${pct[2] ? `.${pct[2]}` : ''}`
    const number = Number(value)
    return number > 0 && number <= 100 ? { pct: String(number) } : null
  }
  const amount = parseAmount(trimmed)
  return amount === null ? null : { amount }
}

const ACT_WINDOWS: Readonly<Record<MoneyPlanAct, { readonly fields: readonly HandField[]; readonly happens: readonly string[]; readonly code?: boolean; readonly danger?: boolean }>> = Object.freeze({
  REPLACE_DEPOSIT: { fields: ['share'], happens: ['replaced', 'asked', 'waits'] },
  MOVE_DUE: { fields: ['day'], happens: ['together', 'overdue'] },
  ASK_AGAIN: { fields: ['day'], happens: ['asked', 'waits'] },
  ADD_STEP: { fields: ['kind', 'share', 'from', 'day', 'label'], happens: ['taken', 'request'] },
  CHANGE_STEP: { fields: ['share', 'restTo'], happens: ['rest', 'request'] },
  REMOVE_STEP: { fields: ['restTo'], happens: ['earlier', 'rest'], danger: true },
  RENAME_STEP: { fields: ['label'], happens: ['printed'] },
  UNDO_OPEN: { fields: [], happens: ['cancelled', 'shipment'], danger: true },
  CHANGE_TERMS: { fields: ['terms'], happens: ['remade', 'total'], code: true },
  ACCEPT_SHORT: { fields: ['why'], happens: ['paid', 'owed', 'td02'], danger: true },
})

/**
 * The window of one act on one row (or the plan's head): its title, what it asks and its five parts. `row` is the row the act is on
 * (null: the head's Change payment terms… / Add a step…); `price`: amounts in its words only with the grain.
 */
export function handWindowOf(act: MoneyPlanAct, context: { readonly order: Pick<Order, 'number' | 'currency'>; readonly row: PlanRow | null; readonly price: boolean; /** F-OM-fx3 (B-OM-024): the company's write-off tolerance (price grain; null / absent: not known). */ readonly tolerance?: number | null }): HandWindow {
  const { order, row, price } = context
  const shape = ACT_WINDOWS[act]
  const what = row?.title ?? word('moneyTab.hand.thePlan')
  const request = row?.request ?? null
  const left = request && price ? stillToPay(request) : null
  const td02 = request?.fiscalDocument === 'TD02'
  // F-OM-fx3 (W-11): Accept short says the tolerance first — within it, or over it (only the Owner, with a fresh code).
  const tolerance = price && typeof context.tolerance === 'number' ? context.tolerance : null
  const short = act === 'ACCEPT_SHORT' ? (row?.short ?? null) : null
  const happens = [
    ...(short && (short.amount ?? left) !== null && tolerance !== null ? [word(short.within ? 'moneyTab.hand.ACCEPT_SHORT.within' : 'moneyTab.hand.ACCEPT_SHORT.over', { money: { amount: (short.amount ?? left)!, tolerance } })] : []),
    ...shape.happens
      .filter((key) => !(act === 'ACCEPT_SHORT' && key === 'td02' && !td02))
      .map((key) => (act === 'ASK_AGAIN' && key === 'waits' && row?.kind === 'BEFORE_SHIPPING' ? word('moneyTab.hand.ASK_AGAIN.holds') : word(`moneyTab.hand.${act}.happens.${key}`))),
    // S2: removing the order's deposit step means production no longer waits for a deposit (the order's depositRequired goes off).
    ...(act === 'REMOVE_STEP' && row?.kind === 'DEPOSIT' ? [word('moneyTab.hand.REMOVE_STEP.happens.noDeposit')] : []),
  ]
  const live = request?.link?.state === 'LIVE'
  const told = act === 'MOVE_DUE' ? word(live ? 'moneyTab.hand.MOVE_DUE.toldLive' : 'moneyTab.hand.MOVE_DUE.toldNone') : word(`moneyTab.hand.${act}.told`)
  const title =
    act === 'ACCEPT_SHORT' && left !== null
      ? word('moneyTab.hand.ACCEPT_SHORT.title', { money: { amount: left } })
      : act === 'ACCEPT_SHORT'
        ? word('moneyTab.hand.ACCEPT_SHORT.titleWords')
        : act === 'CHANGE_TERMS' || act === 'ADD_STEP' || act === 'REPLACE_DEPOSIT'
          ? word(`moneyTab.hand.${act}.title`, { params: { number: order.number } })
          : word(`moneyTab.hand.${act}.title`, { words: { row: what } })
  const go = act === 'ACCEPT_SHORT' ? (left !== null ? word('moneyTab.hand.ACCEPT_SHORT.go', { money: { amount: left } }) : word('moneyTab.hand.ACCEPT_SHORT.goWords')) : word(`moneyTab.hand.${act}.go`)
  // F-OM-fx3 (W-11): the deposit as it is now (what is replaced), else the row's due words.
  const placed = (request?.paidAmount ?? 0) > 0 || !!row?.short
  const sub: MoneyWord[] = !row
    ? []
    : act === 'REPLACE_DEPOSIT'
      ? [row.title, ...(price && row.amount !== null ? [word('moneyTab.hand.sub.amount', { money: { amount: row.amount } })] : []), word(placed ? 'moneyTab.hand.sub.openPart' : 'moneyTab.hand.sub.openNothing'), ...(request?.link ? [word('moneyTab.hand.sub.pageSent', { instants: { date: request.link.sentAt } })] : [])]
      : [row.due]
  // A fresh code follows the terms, and an Accept short over the tolerance (the server's rule: only the Owner, orders.waive).
  return { title, sub, go, fields: shape.fields, happens, told, never: word(`moneyTab.hand.${act}.never`), code: (shape.code ?? false) || (!!short && !short.within), danger: shape.danger ?? false }
}

/** What a window opens with: the row's own day, the first open step to take from or give to, the current terms, bank charges. */
export function handInputOf(act: MoneyPlanAct, context: { readonly row: PlanRow | null; readonly order: Pick<Order, 'paymentTermsId'>; readonly openSteps: readonly { readonly id: string }[]; readonly today: string }): HandInput {
  const { row, order, openSteps, today } = context
  const day = row?.step?.dueDate ?? row?.request?.dueDate ?? ''
  const rest = (row?.restTo ?? [])[0]?.id ?? ''
  return {
    share: '',
    day: act === 'ASK_AGAIN' ? today : day && day >= today ? day : today,
    kind: 'BEFORE_SHIPPING',
    label: act === 'RENAME_STEP' ? (row?.step?.label ?? '') : '',
    restTo: rest,
    from: openSteps[0]?.id ?? '',
    termsId: order.paymentTermsId ?? '',
    why: 'BANK_CHARGES',
    reason: '',
  }
}

/** The day problem of a window that asks one: a day, today or later. */
const dayProblemOf = (day: string, today: string): MoneyWord | null => (!/^\d{4}-\d{2}-\d{2}$/.test(day) ? word('moneyTab.hand.problem.day') : day < today ? word('moneyTab.hand.problem.past') : null)

/**
 * The ONE body of the act as typed, and what holds it: the fields' first problem (the window's Go waits on it; the preview waits
 * too), then the reason's (the preview goes without it). The target's version is sent with it (B-OM: every write sends the version).
 */
export function handBodyOf(
  act: MoneyPlanAct,
  input: HandInput,
  context: {
    readonly step: Pick<Milestone, 'id' | 'version'> | null
    readonly request: Pick<DepositRequest, 'id' | 'version'> | null
    readonly order: Pick<Order, 'version' | 'paymentTermsId'>
    readonly today: string
    /** The plan's steps (Add a step… sends the version of the step it takes from). */
    readonly steps?: readonly Pick<Milestone, 'id' | 'version'>[]
  },
): { readonly body: MoneyPlanBody | null; readonly problem: MoneyWord | null; readonly reasonProblem: MoneyWord | null } {
  const { step, request, order, today } = context
  const reason = input.reason.trim()
  const reasonProblem = reasonProblemOf(input.reason)
  const fail = (key: string) => ({ body: null, problem: word(key), reasonProblem })
  const ok = (body: MoneyPlanBody) => ({ body, problem: null, reasonProblem })
  const share = shareOf(input.share)
  const target = step ? { milestoneId: step.id } : request ? { requestId: request.id } : null
  switch (act) {
    case 'REPLACE_DEPOSIT':
      if (!request) return fail('moneyTab.hand.problem.gone')
      if (!share) return fail('moneyTab.hand.problem.share')
      return ok({ act, requestId: request.id, version: request.version, reason, ...share })
    case 'MOVE_DUE': {
      if (!target) return fail('moneyTab.hand.problem.gone')
      const day = dayProblemOf(input.day, today)
      if (day) return { body: null, problem: day, reasonProblem }
      return ok({ act, ...target, version: step ? step.version : request!.version, dueDate: input.day, reason })
    }
    case 'ASK_AGAIN': {
      if (!target) return fail('moneyTab.hand.problem.gone')
      const day = dayProblemOf(input.day, today)
      if (day) return { body: null, problem: day, reasonProblem }
      return ok({ act, ...target, version: step ? step.version : request!.version, dueDate: input.day, reason })
    }
    case 'ADD_STEP': {
      if (!share) return fail('moneyTab.hand.problem.share')
      const from = (context.steps ?? []).find((entry) => entry.id === input.from) ?? null
      if (!from) return fail('moneyTab.hand.problem.from')
      if (input.label.trim().length > HAND_LABEL_MAX) return fail('moneyTab.hand.problem.labelLong')
      const day = input.day ? dayProblemOf(input.day, today) : null
      if (day) return { body: null, problem: day, reasonProblem }
      return ok({ act, kind: input.kind, from: from.id, version: from.version, ...(input.day ? { dueDate: input.day } : {}), ...(input.label.trim() ? { label: input.label.trim() } : {}), reason, ...share })
    }
    case 'CHANGE_STEP':
      if (!step) return fail('moneyTab.hand.problem.gone')
      if (!share) return fail('moneyTab.hand.problem.share')
      if (!input.restTo) return fail('moneyTab.hand.problem.restTo')
      return ok({ act, milestoneId: step.id, version: step.version, restTo: input.restTo, reason, ...share })
    case 'REMOVE_STEP':
      if (!step) return fail('moneyTab.hand.problem.gone')
      if (!input.restTo) return fail('moneyTab.hand.problem.restTo')
      return ok({ act, milestoneId: step.id, version: step.version, restTo: input.restTo, reason })
    case 'RENAME_STEP': {
      if (!step) return fail('moneyTab.hand.problem.gone')
      const label = input.label.trim()
      if (label === '') return fail('moneyTab.hand.problem.label')
      if (label.length > HAND_LABEL_MAX) return fail('moneyTab.hand.problem.labelLong')
      return ok({ act, milestoneId: step.id, version: step.version, label, reason })
    }
    case 'UNDO_OPEN':
      if (!step) return fail('moneyTab.hand.problem.gone')
      return ok({ act, milestoneId: step.id, version: step.version, reason })
    case 'CHANGE_TERMS':
      if (!input.termsId) return fail('moneyTab.hand.problem.terms')
      if (input.termsId === order.paymentTermsId) return fail('moneyTab.hand.problem.termsSame')
      return ok({ act, paymentTermsId: input.termsId, version: order.version, reason })
    case 'ACCEPT_SHORT':
      if (!request) return fail('moneyTab.hand.problem.gone')
      return ok({ act, requestId: request.id, version: request.version, why: input.why, reason })
  }
}

/** One row of the window's Before → after (the preview's steps, S2): a new step has no before; one that goes is CANCELLED after. */
export interface BeforeAfterRow {
  readonly key: string
  readonly kind: MilestoneKind
  readonly before: PlanFigures | null
  readonly after: PlanFigures
  readonly added: boolean
  readonly removed: boolean
}

/** The steps the act touches, before → after; null: no preview (an older answer, the act refused, still reading). */
export function beforeAfterOf(answer: MoneyPlanPreview | null): BeforeAfterRow[] | null {
  const steps = answer?.preview?.steps ?? null
  if (!steps || steps.length === 0) return null
  return steps.map((step, index) => ({ key: step.id ?? `new-${index}`, kind: step.kind, before: step.before, after: step.after, added: step.before === null, removed: step.after.status === 'CANCELLED' }))
}
