import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * owb-po6.2 (plan § 5m; owb-po-server § Shape "MONEY") — the order's money for a price holder: `GET /portal/sales-orders/:orderId/money`
 * (price grain only; 403 without — the customer's Designer never reads it) and "I paid: tell the factory…" (`POST …/payment-notices`,
 * `portal.payments.notify`). A notice changes NOTHING owed: only the factory records a payment. Parsed with the page's own schema;
 * every amount in minor units. Until the server's read lands (or when it is refused) the Money tab keeps its round-1 cards.
 */

const STEP_KINDS = ['DEPOSIT', 'MILESTONE', 'REST'] as const
const STEP_STATES = ['PAID', 'PART_PAID', 'DUE', 'LATE', 'LATER'] as const
const ADDS_UP = ['LINES', 'CHARGES', 'VAT', 'CREDIT_NOTES', 'PAID'] as const

export const moneySchema = z.object({
  currency: z.string(),
  totals: z.object({ order: z.number(), invoiced: z.number(), paid: z.number(), stillToPay: z.number() }),
  addsUp: z.array(z.object({ key: z.enum(ADDS_UP), amount: z.number() })).catch([]),
  plan: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(STEP_KINDS),
      percent: z.number().nullable(),
      amount: z.number(),
      due: z.string().nullable(),
      state: z.enum(STEP_STATES),
      paid: z.number(),
      noticeOpen: z.boolean(),
    }),
  ),
  invoices: z.array(z.object({ id: z.string(), kind: z.enum(['INVOICE', 'CREDIT_NOTE']), number: z.string(), date: z.string(), amount: z.number(), open: z.number(), documentId: z.string().nullable() })),
  notices: z.array(z.object({ id: z.string(), stepId: z.string().nullable(), amount: z.number(), paidOn: z.string(), state: z.enum(['OPEN', 'RECORDED', 'DISMISSED']) })),
  may: z.object({ notify: z.boolean() }),
})
export type MoneyRead = z.infer<typeof moneySchema>
export type PlanStep = MoneyRead['plan'][number]

export const fetchMoney = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<MoneyRead> =>
  api.get(`/portal/sales-orders/${encodeURIComponent(orderId)}/money`, { schema: moneySchema, signal })

export interface NoticeBody {
  stepId: string | null
  amount: number
  paidOn: string
  method?: string
  note?: string
}
const noticeSchema = z.object({ id: z.string(), stepId: z.string().nullable(), amount: z.number(), paidOn: z.string(), state: z.string() })

export const sendPaymentNotice = (api: ApiClient, orderId: string, body: NoticeBody, idempotencyKey: string = newIdempotencyKey()) =>
  api.post(`/portal/sales-orders/${encodeURIComponent(orderId)}/payment-notices`, { body, schema: noticeSchema, idempotencyKey })

// ── pure ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The ONE step that is due now (late first, then due, then part paid), or null: the only one that carries "I paid: tell the factory…". */
export function dueStepOf(plan: readonly PlanStep[]): PlanStep | null {
  return plan.find((step) => step.state === 'LATE') ?? plan.find((step) => step.state === 'DUE') ?? plan.find((step) => step.state === 'PART_PAID') ?? null
}

/** What is still open on a step (never below 0). */
export const stepOpen = (step: Pick<PlanStep, 'amount' | 'paid'>): number => Math.max(0, step.amount - step.paid)

/** The day a step's open notice was sent (the newest OPEN notice on it), or null. */
export function toldOn(read: Pick<MoneyRead, 'notices'>, stepId: string): string | null {
  const open = read.notices.filter((notice) => notice.stepId === stepId && notice.state === 'OPEN').sort((a, b) => b.paidOn.localeCompare(a.paidOn))
  return open[0]?.paidOn ?? null
}

/** The notice window's typed fields. */
export interface NoticeDraft {
  amount: string
  paidOn: string
  method: string
  note: string
}

/** A typed amount in minor units ("1.234,50", "1234.5", "€ 80") — null when it is not an amount. */
export function minorOf(text: string): number | null {
  const plain = text.replace(/[^\d.,]/g, '')
  if (!plain) return null
  // The last separator with one or two digits after it is the decimal one; every other separator groups thousands.
  const match = /^(.*?)[.,](\d{1,2})$/.exec(plain)
  const whole = (match ? match[1]! : plain).replace(/[.,]/g, '')
  const cents = match ? match[2]!.padEnd(2, '0') : '00'
  if (!/^\d+$/.test(whole || '0')) return null
  const minor = Number(whole || '0') * 100 + Number(cents)
  return Number.isSafeInteger(minor) ? minor : null
}

/** Why the notice cannot be sent yet (a key of the page's words), or null. Never above what is open on the step (the server refuses it too). */
export function noticeProblem(draft: NoticeDraft, step: Pick<PlanStep, 'amount' | 'paid'> | null, today: string): 'money.problem.amount' | 'money.problem.tooMuch' | 'money.problem.day' | 'money.problem.long' | null {
  const minor = minorOf(draft.amount)
  if (minor === null || minor <= 0) return 'money.problem.amount'
  if (step && minor > stepOpen(step)) return 'money.problem.tooMuch'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.paidOn) || draft.paidOn > today) return 'money.problem.day'
  if (draft.note.length > 2000 || draft.method.length > 100) return 'money.problem.long'
  return null
}

/** The body the window sends (no empty optional field). */
export function noticeBodyOf(draft: NoticeDraft, stepId: string | null): NoticeBody {
  return {
    stepId,
    amount: minorOf(draft.amount) ?? 0,
    paidOn: draft.paidOn,
    ...(draft.method.trim() ? { method: draft.method.trim() } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
  }
}
