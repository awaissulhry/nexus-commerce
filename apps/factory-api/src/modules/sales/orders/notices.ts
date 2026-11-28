import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, money } from '@nexus/factory-domain/money/marked'
import { PAYMENTS_RECORD } from '@nexus/factory-domain/payments/permissions'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { mayOn, officeContextOf } from './access'
import { officeOrder } from './moves'

/**
 * owb-of1 step 4 (order workflow, plan.md § 5m R37 "the customer's 'I paid' notices: a notice, it changes nothing owed"; PL-schema
 * § 5A row 4 PaymentNotice, guard G7): the office reads an order's notices and answers each once.
 *
 *   GET  /sales/orders/:orderId/payment-notices                        orders.view (or orders.view.own on the order); the amount
 *                                                                      only with the price grain (marked money: the serializer
 *                                                                      drops it for everyone else — Sales reads the notice in words)
 *   POST /sales/orders/:orderId/payment-notices/:noticeId/answer {version, state}   payments.record over the order: OPEN →
 *        RECORDED or DISMISSED, once (the database's guard too). RECORDED records NO payment: the person records it with today's
 *        "Record a payment…" (its fresh code kept); the notice only says it was dealt with. One audit row.
 * A notice of another order (or none) is "Payment notice not found." — the words of an unknown id.
 */

const noticeView = output({
  id: id(),
  version: z.number().int(),
  /** The payment step it pays (the step's own label, else its kind code) or the deposit request (`DEPOSIT`); null: none named. */
  step: output({ id: id(), words: z.string() }).nullable(),
  paidOn: businessDate(),
  method: z.string().nullable(),
  note: z.string().nullable(),
  fileId: id().nullable(),
  amount: money.price(z.number().int()),
  currency: z.string(),
  state: z.enum(['OPEN', 'RECORDED', 'DISMISSED']),
  at: instant(),
})

export const paymentNoticesContract = defineContract({
  params: input({ orderId: id() }),
  response: { 200: output({ notices: z.array(noticeView) }) },
})

export const answerNoticeContract = defineContract({
  params: input({ orderId: id(), noticeId: id() }),
  body: input({ version: z.number().int().min(1), state: z.enum(['RECORDED', 'DISMISSED']) }),
  response: { 200: output({ notice: noticeView }) },
})

export const NOTICE_NOT_FOUND = 'Payment notice not found.'
export const NOTICE_ANSWERED_WORDS = Object.freeze({
  en: 'This notice was answered already: it is answered once.',
  it: 'Questo avviso ha già una risposta: si risponde una volta sola.',
})
export const NOTICE_RIGHT_WORDS = Object.freeze({
  en: 'Answering a payment notice needs the right to record payments for this customer.',
  it: 'Per rispondere a un avviso di pagamento serve il diritto di registrare i pagamenti di questo cliente.',
})

const NOTICE_COLUMNS = {
  id: true,
  version: true,
  depositRequestId: true,
  milestoneId: true,
  paidOn: true,
  method: true,
  note: true,
  fileId: true,
  amount: true,
  currency: true,
  state: true,
  createdAt: true,
  milestone: { select: { id: true, label: true, kind: true } },
} as const

type NoticeRow = {
  readonly id: string
  readonly version: number
  readonly depositRequestId: string | null
  readonly milestoneId: string | null
  readonly paidOn: Date
  readonly method: string | null
  readonly note: string | null
  readonly fileId: string | null
  readonly amount: number
  readonly currency: string
  readonly state: 'OPEN' | 'RECORDED' | 'DISMISSED'
  readonly createdAt: Date
  readonly milestone: { readonly id: string; readonly label: string | null; readonly kind: string } | null
}

const viewOf = (row: NoticeRow) => ({
  id: row.id,
  version: row.version,
  step: row.milestone ? { id: row.milestone.id, words: row.milestone.label ?? row.milestone.kind } : row.depositRequestId ? { id: row.depositRequestId, words: 'DEPOSIT' } : null,
  paidOn: row.paidOn.toISOString().slice(0, 10),
  method: row.method,
  note: row.note,
  fileId: row.fileId,
  amount: asMoney('price', row.amount),
  currency: row.currency,
  state: row.state,
  at: toUtcIso(row.createdAt),
})

/** GET /sales/orders/:orderId/payment-notices (see the file's head): the open ones first, then newest first. */
export async function orderPaymentNotices(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  const rows = (await caller.withClient((client) =>
    client.paymentNotice.findMany({ where: { salesOrderId: order.id }, select: NOTICE_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
  )) as NoticeRow[]
  const open = rows.filter((row) => row.state === 'OPEN')
  return { notices: [...open, ...rows.filter((row) => row.state !== 'OPEN')].map(viewOf) }
}

/** POST /sales/orders/:orderId/payment-notices/:noticeId/answer (see the file's head). */
export async function answerPaymentNotice(caller: CommandCaller, orderId: string, noticeId: string, body: { readonly version: number; readonly state: 'RECORDED' | 'DISMISSED' }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  if (!mayOn(context, PAYMENTS_RECORD, order)) throw new ForbiddenError(NOTICE_RIGHT_WORDS.en)
  if (!isUuid(noticeId)) throw new NotFoundError(NOTICE_NOT_FOUND)
  await command(caller, { name: 'orders.paymentNotice.answer', idempotencyKey, input: { orderId: order.id, noticeId, ...body } }, async (tools) => {
    const rows = await tools.tx.$queryRaw<{ id: string; state: string; version: number }[]>`SELECT id::text AS id, state::text AS state, version FROM "PaymentNotice" WHERE id = ${noticeId}::uuid AND "salesOrderId" = ${order.id}::uuid FOR UPDATE`
    const row = rows[0]
    if (!row) throw new NotFoundError(NOTICE_NOT_FOUND)
    if (row.version !== body.version) throw new StaleVersionError('PaymentNotice', noticeId, row.version, body.version)
    if (row.state !== 'OPEN') throw new InvalidStateError(NOTICE_ANSWERED_WORDS.en)
    await tools.tx.paymentNotice.update({ where: { id: noticeId }, data: { state: body.state, answeredAt: tools.now, answeredById: context.actorId, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'orders.paymentNotice.answer', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { noticeId, state: 'OPEN' }, after: { noticeId, state: body.state } })
    return { noticeId, state: body.state }
  })
  const row = (await caller.withClient((client) => client.paymentNotice.findUniqueOrThrow({ where: { id: noticeId }, select: NOTICE_COLUMNS }))) as NoticeRow
  return { notice: viewOf(row) }
}
