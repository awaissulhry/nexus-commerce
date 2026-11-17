import type { ApprovalDecision, ApprovalKind } from '@nexus/factory-domain/approvals-out/kinds'
import { dueStateOf } from '@nexus/factory-domain/portal/tasks/rules'
import type { ActionDueState } from '@nexus/ui/patterns/ActionList/index'
import type { Locale } from '../../../lib/i18n/locales'
import { payRowsOf } from '../documents/model'
import type { OpenItemsRead, WaitingApproval } from './api'

/**
 * F-PR-14 — Home › Waiting for you (production plan §1 "Waiting for you is the one place where it answers everything", §5; 06-tree
 * B.3; 09-design (f); wall PW-P05), pure: everything we wait for from this customer, in groups — Production approvals (samples:
 * PP, size set, TOP and the others; fabric, trims, colour, leather, artwork), Order (a revised order, a new date, our
 * counter-offer), Quality (concessions), Made-to-measure (design proofs), Payment (a deposit, an invoice) — the soonest due first,
 * ONE verb per row: Review (the answer dialog), View (another colleague answers it: "Waiting for <name>", or a priced counter-offer
 * the reader's buyer answers: "Waiting for your buyer"), Pay (the documents' To pay). An answer goes to us after 10 seconds, with
 * Undo until then (`UNDO_MS`).
 *
 * The wall: every row comes from the session's own reads (its party's approvals, its tasks, its open items); nothing here names
 * another customer, and a request that is not the party's answers as one that does not exist (the API's 404, said neutrally).
 */

export const NS = 'portal-waiting'

export const WAITING_GROUPS = ['production', 'order', 'quality', 'mtm', 'payment', 'other'] as const
export type WaitingGroup = (typeof WAITING_GROUPS)[number]

/** Where each kind of approval waits (a kind the plan does not name stays visible under Other: nothing that waits is hidden). */
export const GROUP_OF_KIND: Readonly<Record<ApprovalKind, WaitingGroup>> = Object.freeze({
  SAMPLE: 'production',
  FABRIC: 'production',
  TRIM: 'production',
  COLOUR: 'production',
  LEATHER: 'production',
  ARTWORK: 'production',
  REVISED_ORDER: 'order',
  REPROMISE: 'order',
  COUNTER_OFFER: 'order',
  CONCESSION: 'quality',
  PROOF: 'mtm',
  SIGNATURE: 'other',
})

/** The one verb a row's request takes (keys of `portal-waiting`). */
const VERB_OF_KIND: Readonly<Partial<Record<ApprovalKind, string>>> = Object.freeze({ REVISED_ORDER: 'verb.reconfirm', REPROMISE: 'verb.answerDate', COUNTER_OFFER: 'verb.answerCounter', SIGNATURE: 'verb.sign' })

export type WaitingKind = ApprovalKind | 'PAY_DEPOSIT' | 'PAY_INVOICE'

export interface WaitingRow {
  /** The approval request's id, or `pay:<invoice|deposit>:<id>`. */
  readonly id: string
  readonly group: WaitingGroup
  readonly kind: WaitingKind
  /** The request in our words (`row.<kind>` of `portal-waiting`) with the record as the API names it for the party. */
  readonly title: { readonly key: string; readonly label: string }
  /** Who of us asked (the task's), else null. */
  readonly askedBy: string | null
  readonly due: { readonly at: string; readonly state: ActionDueState } | null
  /** answer: the answer dialog; view: read only (another answers it); link: its page. */
  readonly verb: { readonly act: 'answer' | 'view' | 'link'; readonly key: string; readonly href?: string }
  /** Who answers it when it is not the reader: a named colleague, or their buyer (a priced counter-offer). */
  readonly heldFor: { readonly kind: 'person'; readonly name: string } | { readonly kind: 'buyer' } | null
  /** A payment's amount still open (price grain only; minor units). */
  readonly amount?: { readonly minor: number; readonly currency: string } | null
}

const DUE_STATE: Readonly<Record<ReturnType<typeof dueStateOf>, ActionDueState>> = { OVERDUE: 'overdue', TODAY: 'today', SOON: 'soon', LATER: 'later', NONE: 'none' }
const APPROVAL_LINK = /\/open\/ApprovalRequest\/([0-9a-f-]{36})/i

/** A row of the frame's one task list, as far as Waiting for you reads it (who asked; the API's due state). */
export interface TaskLink {
  readonly href: string
  readonly askedBy: string | null
  readonly due: { readonly at: string; readonly state: ActionDueState } | null
}

/** The tasks that answer an approval, by its id. */
export function tasksByApproval(tasks: readonly TaskLink[]): Map<string, TaskLink> {
  const out = new Map<string, TaskLink>()
  for (const task of tasks) {
    const match = APPROVAL_LINK.exec(task.href)
    if (match) out.set(match[1]!.toLowerCase(), task)
  }
  return out
}

/** A due as the list draws it: the task's state when it has one (the API's clock), else the same rule here (the domain's). */
function dueOf(at: string | null, now: number, task: TaskLink | null): WaitingRow['due'] {
  if (!at) return null
  if (task?.due && task.due.at === at && task.due.state !== 'none') return { at, state: task.due.state }
  return { at, state: DUE_STATE[dueStateOf(new Date(at), new Date(now))] }
}

export interface WaitingInput {
  readonly approvals: readonly WaitingApproval[]
  readonly tasks: readonly TaskLink[]
  /** The documents' open items (null: not read or not part of the access). */
  readonly payments: OpenItemsRead | null
  readonly locale: Locale
  readonly prefix: string
  readonly now: number
}

/** Every row that waits for the customer, in our words, each with its one verb (the soonest due first inside a group). */
export function waitingRowsOf(input: WaitingInput): WaitingRow[] {
  const tasks = tasksByApproval(input.tasks)
  const rows: WaitingRow[] = input.approvals
    .filter((approval) => approval.status === 'OPEN')
    .map((approval) => {
      const task = tasks.get(approval.id.toLowerCase()) ?? null
      const heldFor: WaitingRow['heldFor'] = approval.waitingFor ? { kind: 'person', name: approval.waitingFor } : approval.waitingForBuyer ? { kind: 'buyer' } : null
      return {
        id: approval.id,
        group: GROUP_OF_KIND[approval.kind],
        kind: approval.kind,
        title: { key: `row.${approval.kind}`, label: approval.words[input.locale] },
        askedBy: task?.askedBy ?? null,
        due: dueOf(approval.dueAt, input.now, task),
        verb: heldFor ? { act: 'view', key: 'verb.view' } : { act: 'answer', key: VERB_OF_KIND[approval.kind] ?? 'verb.review' },
        heldFor,
      }
    })
  const payHref = `${input.prefix}/documents?group=FINANCE`
  for (const pay of payRowsOf(input.payments)) {
    const kind = pay.target.kind === 'deposit' ? 'PAY_DEPOSIT' : 'PAY_INVOICE'
    const at = `${pay.dueDate.slice(0, 10)}T16:00:00Z`
    rows.push({
      id: `pay:${pay.key}`,
      group: 'payment',
      kind,
      title: { key: `row.${kind}`, label: pay.number },
      askedBy: null,
      due: pay.daysLate > 0 ? { at, state: 'overdue' } : dueOf(at, input.now, null),
      verb: { act: 'link', key: 'verb.pay', href: payHref },
      heldFor: null,
      amount: pay.open !== null ? { minor: pay.open, currency: pay.currency } : null,
    })
  }
  return rows
}

export interface WaitingGroupRows {
  readonly group: WaitingGroup
  readonly rows: readonly WaitingRow[]
}

/** The rows in their groups, in the page's order (a group with nothing waiting is not drawn). */
export function waitingGroupsOf(rows: readonly WaitingRow[]): WaitingGroupRows[] {
  return WAITING_GROUPS.map((group) => ({ group, rows: rows.filter((row) => row.group === group) })).filter((entry) => entry.rows.length > 0)
}

/** The approvals the reader answers here, in the list's order (J / K in the answer dialog). */
export const answerQueue = (groups: readonly WaitingGroupRows[]): string[] => groups.flatMap((entry) => entry.rows.filter((row) => row.verb.act === 'answer').map((row) => row.id))

// ── the answer: Undo for 10 seconds, then we are told ──────────────────────────────────────────────────────────────────────
/** How long a signed answer waits on this page before it goes to us (Undo until then). */
export const UNDO_MS = 10_000

/** A signed answer that has not gone yet. */
export interface PendingAnswer {
  readonly requestId: string
  readonly decision: ApprovalDecision
  readonly answer: string | null
  readonly typedName: string
  readonly version: number
  /** When it goes (epoch ms). */
  readonly sendAt: number
}

/** The answer as it waits (sendAt = now + 10 s): nothing is sent before then. */
export const pendingOf = (body: Omit<PendingAnswer, 'sendAt'>, now: number): PendingAnswer => ({ ...body, sendAt: now + UNDO_MS })

/** The row's words after the answer: waiting to go (with Undo), sent, or failed. */
export function doneWordsOf(state: { phase: 'pending' | 'sending' | 'sent'; decision: ApprovalDecision }): string {
  return state.phase === 'sent' ? `done.sent.${state.decision}` : `done.pending.${state.decision}`
}

/** Why the answer could not go, in our words (a key of `portal-waiting`): neutral — a request not the party's is "no longer waits". */
export function sendRefusal(kind: string | null): string {
  switch (kind) {
    case 'not_found':
      return 'problem.gone'
    case 'forbidden':
      return 'problem.forbidden'
    case 'conflict':
      return 'problem.changed'
    case 'invalid':
      return 'problem.invalid'
    case 'unavailable':
    case 'rate_limited':
      return 'problem.unavailable'
    default:
      return 'problem.internal'
  }
}
