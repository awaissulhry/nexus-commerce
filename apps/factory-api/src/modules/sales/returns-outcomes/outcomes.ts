import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import {
  exchangeHeld,
  exchangeSizesOf,
  finishOptions,
  finishStateHeld,
  missingPiecesOf,
  remakeHeld,
  REMAKE_PHOTOS,
  restOf,
  sendBackHeld,
  splitHeld,
  suggestedFinish,
  type FinishFacts,
  type SendBackLine,
} from '@nexus/factory-domain/sales/returns-outcomes/rules'
import { isSafetyReturn, type GoodsOutcome, type ReturnCause, type ReturnDisposition, type ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { sourceDdtsOf } from '../../shipping/ddt/sources-store'
import { officeReturn } from '../returns/access'
import { dayOrNull, lineKeyOf, LINE_RECORD, photoCounts, readLines, readRma, soldFactsOf, type LineRow, type Reader, type RmaRow, type SoldFacts } from '../returns/store'
import { exchangeFactsOf, styleSizesOf } from './exchange'
import { remakeOf, type RemakeAsked } from './store'

/**
 * `GET /sales/returns/:returnId/outcomes` (B-W2b-346; design sales.returns "Return (RMA)": Lines "a partial receipt splits
 * the line", Inspection & decision "Disposition … size exchange … return unchanged", Shipments "Outbound shipment
 * (returned unchanged)", returns.close "Finish reason (required)"): what the W2b-5 outcomes of a return are now, for the
 * office's screens (B-W2b-352) and the close dialog. Per line its true disposition (SIZE_EXCHANGE with the size it gets),
 * the line it was split from and the lines split from it, whether it may be split (and how many pieces the new line takes),
 * the sizes it may be exchanged for, whether it may go back unchanged and the return DDT that carries it; the remake asked
 * (how, for which lines, what is wrong with the fit, the front and back photos each line has); the return DDTs of goods
 * sent back; every finish reason allowed or held with why, and the one the facts point to. No money here.
 */

export interface OutcomeFacts {
  readonly rma: RmaRow
  readonly lines: LineRow[]
  readonly sold: Map<string, SoldFacts>
  readonly sizes: Map<string, string[]>
  readonly photos: Map<string, number>
  readonly remake: RemakeAsked | null
  readonly ddts: readonly { readonly id: string; readonly number: string; readonly documentDate: string; readonly startAt: string; readonly packages: number; readonly transportBy: string; readonly carrierName: string | null; readonly lineIds: readonly string[] }[]
}

export async function outcomeFactsOf(db: Reader, rma: RmaRow): Promise<OutcomeFacts> {
  const lines = await readLines(db, rma.id)
  const sold = await soldFactsOf(db, lines)
  const sizes = await styleSizesOf(db, [...sold.values()].flatMap((facts) => (facts.orderLine ? [facts.orderLine.styleId] : [])))
  const photos = await photoCounts(db, LINE_RECORD, lines.map((line) => line.id))
  const remake = await remakeOf(db, rma.id)
  const { live } = await sourceDdtsOf(db as CommandTx, { type: 'ReturnAuthorisation', id: rma.id })
  const rows = live.length > 0 ? await db.ddt.findMany({ where: { id: { in: live.map((ddt) => ddt.id) } }, select: { id: true, documentDate: true, packages: true, transportBy: true, carrier: true } }) : []
  const rowOf = new Map(rows.map((row) => [row.id, row]))
  const ddts = live.map((ddt) => {
    const row = rowOf.get(ddt.id)
    const carrier = row?.carrier && typeof row.carrier === 'object' && !Array.isArray(row.carrier) ? (row.carrier as Record<string, unknown>) : null
    return {
      id: ddt.id,
      number: ddt.number,
      documentDate: row ? row.documentDate.toISOString().slice(0, 10) : '',
      startAt: toUtcIso(ddt.startAt),
      packages: row?.packages ?? 0,
      transportBy: row?.transportBy ?? 'SENDER',
      carrierName: carrier && typeof carrier.name === 'string' ? carrier.name : null,
      lineIds: [...ddt.lineIds],
    }
  })
  return { rma, lines, sold, sizes, photos, remake, ddts }
}

/** The send-back facts of a line (W2a's safety rule: a protective garment returned for a defect never goes back as it came). */
export function sendBackLineOf(line: LineRow, sold: SoldFacts | undefined, onDdt: string | null): SendBackLine {
  const ppe = sold?.style?.ppe ?? false
  return {
    id: line.id,
    seq: line.seq,
    received: line.receivedQuantity,
    graded: line.grade !== null,
    disposition: line.disposition as ReturnDisposition | null,
    goodsOutcome: line.goodsOutcome as GoodsOutcome | null,
    safety: isSafetyReturn({ ppe, reasonCode: line.reasonCode, cause: line.cause as ReturnCause | null }),
    onDdt,
  }
}

export const finishFactsOf = (rma: Pick<RmaRow, 'status' | 'goodsDueBy'>, lines: readonly LineRow[], now: Date): FinishFacts => ({
  status: rma.status as ReturnStatus,
  goodsDueBy: dayOrNull(rma.goodsDueBy),
  today: businessDate(now),
  lines: lines.map((line) => ({
    seq: line.seq,
    quantity: line.quantity,
    received: line.receivedQuantity,
    disposition: line.disposition as ReturnDisposition | null,
    goodsOutcome: line.goodsOutcome as GoodsOutcome | null,
    creditWithoutReturn: line.creditWithoutReturn,
    creditAmount: line.creditAmount,
  })),
})

export function outcomesView(facts: OutcomeFacts, now: Date) {
  const { rma } = facts
  const status = rma.status as ReturnStatus
  const onDdt = new Map<string, string>()
  for (const ddt of facts.ddts) for (const lineId of ddt.lineIds) onDdt.set(lineId, ddt.number)
  const finish = finishFactsOf(rma, facts.lines, now)
  const remakeLines = new Set(facts.remake?.lineIds ?? [])
  const lines = facts.lines.map((line) => {
    const sold = facts.sold.get(lineKeyOf(line))
    const exchange = exchangeFactsOf(line, sold, facts.sizes)
    const split = splitHeld({ status, seq: line.seq, quantity: line.quantity, received: line.receivedQuantity, creditWithoutReturn: line.creditWithoutReturn })
    const back = sendBackLineOf(line, sold, onDdt.get(line.id) ?? null)
    const sendBack = sendBackHeld(back)
    return {
      id: line.id,
      seq: line.seq,
      description: line.description,
      size: line.size,
      quantity: line.quantity,
      receivedQuantity: line.receivedQuantity,
      /** Pieces still expected (none for a line credited without the goods). */
      expected: line.creditWithoutReturn ? 0 : restOf({ quantity: line.quantity, received: line.receivedQuantity }),
      graded: line.grade !== null,
      disposition: line.disposition as ReturnDisposition | null,
      goodsOutcome: line.goodsOutcome as GoodsOutcome | null,
      exchangeSize: line.exchangeSize,
      replacementLineId: line.replacementLineId,
      creditWithoutReturn: line.creditWithoutReturn,
      parentLineId: line.parentLineId,
      splitLineIds: facts.lines.filter((other) => other.parentLineId === line.id).map((other) => other.id),
      split: { allowed: split === null, held: split, rest: split === null ? restOf({ quantity: line.quantity, received: line.receivedQuantity }) : 0 },
      exchange: { sizes: exchangeSizesOf(exchange), held: line.disposition !== null ? `Line ${line.seq} is decided already.` : exchangeHeld(exchange) },
      sendBack: { allowed: sendBack === null, held: sendBack, ddtNumber: onDdt.get(line.id) ?? null },
      remake: remakeLines.has(line.id),
      photos: facts.photos.get(line.id) ?? 0,
      version: line.version,
    }
  })
  const backLines = facts.lines.map((line) => sendBackLineOf(line, facts.sold.get(lineKeyOf(line)), onDdt.get(line.id) ?? null))
  const toSend = backLines.filter((line) => sendBackHeld(line) === null)
  const stateHeld = finishStateHeld(finish)
  return {
    id: rma.id,
    number: rma.number,
    status,
    channel: rma.channel,
    remake: facts.remake
      ? {
          asked: true,
          at: facts.remake.at,
          via: facts.remake.via,
          lineIds: facts.remake.lineIds,
          fit: facts.remake.fit,
          /** Each line's photos against the front and back a remake asks for. */
          photos: facts.remake.lineIds.map((lineId) => ({ lineId, count: facts.photos.get(lineId) ?? 0, needed: REMAKE_PHOTOS.length })),
          held: null,
        }
      : { asked: false, at: null, via: null, lineIds: [] as string[], fit: null, photos: [] as { lineId: string; count: number; needed: number }[], held: remakeHeld({ status, asked: false }) },
    lines,
    sendBack: {
      allowed: toSend.length > 0 && (status === 'RECEIVED' || status === 'INSPECTED'),
      held: status === 'CLOSED' ? 'The return is closed: issue a DDT for goods still here under Shipping.' : toSend.length > 0 ? null : 'No line may go back unchanged now.',
      lineIds: toSend.map((line) => line.id),
      ddts: facts.ddts.map((ddt) => ({ ...ddt, lineIds: [...ddt.lineIds] })),
    },
    finish: {
      held: stateHeld,
      reasons: finishOptions(finish).map((option) => ({ reason: option.reason, allowed: option.allowed, held: option.held })),
      suggested: suggestedFinish(finish),
      missingPieces: missingPiecesOf(finish.lines),
      finishReason: rma.finishReason,
      closedAt: rma.closedAt ? toUtcIso(rma.closedAt) : null,
    },
    version: rma.version,
  }
}

export type OutcomesView = ReturnType<typeof outcomesView>

export async function outcomesOf(caller: CommandCaller, returnId: string): Promise<OutcomesView> {
  return caller.withClient(async (client) => {
    const rma = await readRma(client, returnId)
    if (!rma) throw new NotFoundError('Return not found.')
    return outcomesView(await outcomeFactsOf(client, rma), serverClock.now())
  })
}

/** GET /sales/returns/:returnId/outcomes */
export async function getOutcomes(caller: CommandCaller, returnId: string): Promise<{ return: OutcomesView }> {
  const { rma } = await officeReturn(caller, returnId)
  return { return: await outcomesOf(caller, rma.id) }
}
