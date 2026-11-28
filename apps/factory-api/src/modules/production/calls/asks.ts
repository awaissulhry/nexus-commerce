import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { askTo, DESIGNER_ASK_CODES, SIGNAL_REFUSALS, type AskTo, type FloorAskCode } from '@nexus/factory-domain/production/baskets/signals'
import { CALL_LIMITS, OPEN_CALL_STATUSES } from '@nexus/factory-domain/production/calls/rules'
import type { CommandCaller } from '../../../core/command'
import { answerCall } from './answer'
import { refuse } from './access'
import { readCall, type Reader } from './store'

/**
 * The floor's asks to the designer, for S2's Design desk (owb- order workflow, S5 fl3 step 1; LF shared-asks 2026-11-28 00:36;
 * `_owb-fl-common.md` settle 5; pick C: no chat — the answer goes back as the call's resolutionNote, "An answer for you").
 *
 *   openDesignerAsks(db, { companyId, orderIds?, wall? })   the OPEN help calls of the ask codes the designer answers (askTo =
 *                                                           DESIGNER: ASK_LOGO, ASK_PATCH, ASK_UNCLEAR) of the company's sites,
 *                                                           oldest first: ASKED (sent, seen) or TAKEN (someone is on it)
 *   takeAsk(caller, callId)                                  "I take it" = today's ON_THE_WAY step (./answer.ts)
 *   answerAsk(caller, callId, words)                         "Done — tell the worker" = today's SOLVED with resolutionNote = the
 *                                                           words the worker reads (resolution code ANSWERED)
 *
 * Who answers is fixed by the code, never stored (factory-domain production/baskets/signals `askTo`). The read takes the reader's
 * client: S2 passes its reader's db and, for a person limited to some customers, `wall` (./access.ts `callWall`: a call on
 * another customer's work order is left out). The commands check the caller with production.calls.answer and the brand wall
 * (answer.ts knownCall), as every responder's step. No person is named: the worker who asked stays out.
 */

export interface DesignerAsk {
  readonly callId: string
  readonly salesOrderId: string | null
  readonly workOrderId: string | null
  readonly bundleId: string | null
  readonly basketCode: string | null
  readonly typeCode: FloorAskCode
  readonly to: AskTo
  /** When the worker asked (UTC ISO). */
  readonly since: string
  readonly state: 'ASKED' | 'TAKEN'
}

const ASKS_MAX = 200

/** The designer's open asks of a company (optionally of some sales orders), oldest first. */
export async function openDesignerAsks(db: Reader, input: { readonly companyId: string; readonly orderIds?: readonly string[] | undefined; readonly wall?: Prisma.HelpCallWhereInput | undefined }): Promise<DesignerAsk[]> {
  const orders = input.orderIds ? [...new Set(input.orderIds)] : null
  if (orders !== null && orders.length === 0) return []
  const ofOrders: Prisma.HelpCallWhereInput = orders
    ? {
        OR: [
          { bundle: { is: { workOrderSize: { salesOrderLine: { is: { orderId: { in: orders } } } } } } },
          { bundleId: null, workOrder: { is: { sizes: { some: { salesOrderLine: { is: { orderId: { in: orders } } } } } } } },
        ],
      }
    : {}
  const rows = await db.helpCall.findMany({
    where: { AND: [{ status: { in: [...OPEN_CALL_STATUSES] }, station: { companyId: input.companyId }, type: { code: { in: [...DESIGNER_ASK_CODES] } } }, ofOrders, input.wall ?? {}] },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    take: ASKS_MAX,
    select: {
      id: true,
      status: true,
      sentAt: true,
      workOrderId: true,
      bundleId: true,
      type: { select: { code: true } },
      bundle: { select: { code: true, workOrderSize: { select: { salesOrderLine: { select: { orderId: true } } } } } },
      workOrder: { select: { sizes: { where: { salesOrderLineId: { not: null } }, take: 1, select: { salesOrderLine: { select: { orderId: true } } } } } },
    },
  })
  return rows.flatMap((row) => {
    const to = askTo(row.type.code)
    if (to !== 'DESIGNER') return []
    const salesOrderId = row.bundle?.workOrderSize.salesOrderLine?.orderId ?? row.workOrder?.sizes[0]?.salesOrderLine?.orderId ?? null
    return [
      {
        callId: row.id,
        salesOrderId,
        workOrderId: row.workOrderId,
        bundleId: row.bundleId,
        basketCode: row.bundle?.code ?? null,
        typeCode: row.type.code as FloorAskCode,
        to,
        since: toUtcIso(row.sentAt),
        state: row.status === 'ON_THE_WAY' ? ('TAKEN' as const) : ('ASKED' as const),
      },
    ]
  })
}

/** The call must be an ask for the designer (else a refusal in words; an unknown call is not found). */
async function designerAsk(caller: CommandCaller, callId: string): Promise<void> {
  const call = isUuid(callId) ? await caller.withClient((db) => readCall(db, callId)) : null
  if (!call) throw new NotFoundError('Call not found.')
  if (askTo(call.type.code) !== 'DESIGNER') refuse(SIGNAL_REFUSALS.NOT_AN_ASK)
}

/** "I take it": today's ON_THE_WAY step of the ask (production.calls.answer, the brand wall: answer.ts). */
export async function takeAsk(caller: CommandCaller, callId: string, idempotencyKey?: string) {
  await designerAsk(caller, callId)
  return answerCall(caller, callId, 'ON_THE_WAY', {}, idempotencyKey)
}

/** The resolution code an answered ask is solved with. */
export const ASK_ANSWERED = 'ANSWERED'

/** "Done — tell the worker": today's SOLVED with the words the worker reads as "An answer for you". */
export async function answerAsk(caller: CommandCaller, callId: string, words: string, idempotencyKey?: string) {
  const answer = words.trim()
  if (answer.length === 0) refuse(SIGNAL_REFUSALS.NO_ANSWER_WORDS)
  await designerAsk(caller, callId)
  return answerCall(caller, callId, 'SOLVED', { resolutionCode: ASK_ANSWERED, resolutionNote: answer.slice(0, CALL_LIMITS.resolutionNote) }, idempotencyKey)
}
