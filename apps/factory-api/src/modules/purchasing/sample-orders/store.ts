import type { Prisma } from '@nexus/factory-db'
import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import { PRODUCTION_ORDER_KINDS, planLinesRefusal, type DevelopmentFacts, type SampleOrderRefusal } from '@nexus/factory-domain/purchasing/sample-orders/rules'
import type { SampleKind, SampleStage } from '@nexus/factory-domain/sales/samples/rules'
import type { OrderRow, Reader } from '../store'

/**
 * Sample and development orders' reads (B-W2b-347; SCM-043): what makes a purchase order a sample order — its kind SAMPLE and
 * the style (and sample round) it buys for (PurchaseOrder.kind, developmentStyleId, sampleRoundId; factory-db buying-depth,
 * B-W2b-285) — read beside W1's order columns, and the hooks W1's flows call: the sample order PDF reads it (views.ts
 * readFacts, send.ts), a plan's or a request's lines never land on a sample draft (from-plan.ts), planning nets production
 * orders only (planning/store.ts readPurchases takes PRODUCTION_ORDER_KINDS).
 */

/** A sample-order write refused in words: 409 `conflict` with the issue `refusal/<CODE>` (and the field, when one is named). */
export class SampleOrderRefusedError extends ConflictError {
  override name = 'SampleOrderRefusedError'
  override readonly issues: readonly Issue[]
  constructor(
    readonly refusal: SampleOrderRefusal,
    path?: string,
  ) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }, ...(path ? [{ path, message: refusal.message }] : [])]
  }
}

export const refuseSample = (refusal: SampleOrderRefusal | null, path?: string): void => {
  if (refusal) throw new SampleOrderRefusedError(refusal, path)
}

export interface SampleFacts {
  readonly kind: 'SAMPLE'
  readonly style: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly round: { readonly id: string; readonly number: string; readonly kind: SampleKind; readonly roundNo: number; readonly stage: SampleStage } | null
}

const SAMPLE_SELECT = {
  kind: true,
  developmentStyle: { select: { id: true, code: true, name: true } },
  sampleRound: { select: { id: true, number: true, kind: true, roundNo: true, stage: true } },
} as const

/** The order's sample facts, or null for a production order (STANDARD). */
export async function readSampleFacts(db: Reader, orderId: string): Promise<SampleFacts | null> {
  const row = await db.purchaseOrder.findUnique({ where: { id: orderId }, select: SAMPLE_SELECT })
  if (!row || row.kind !== 'SAMPLE') return null
  return {
    kind: 'SAMPLE',
    style: row.developmentStyle ? { id: row.developmentStyle.id, code: row.developmentStyle.code, name: row.developmentStyle.name } : null,
    round: row.sampleRound ? { id: row.sampleRound.id, number: row.sampleRound.number, kind: row.sampleRound.kind as SampleKind, roundNo: row.sampleRound.roundNo, stage: row.sampleRound.stage as SampleStage } : null,
  }
}

/** What the sample order PDF says it is for (null for a production order: the PDF stays a purchase order). */
export const developmentOf = (sample: SampleFacts | null | undefined): DevelopmentFacts | null =>
  sample ? { style: sample.style ? { code: sample.style.code, name: sample.style.name } : null, round: sample.round ? { number: sample.round.number, kind: sample.round.kind, roundNo: sample.round.roundNo } : null } : null

/** The record's "PO of type Sample" (GET /purchasing/orders/:id `sample`): null for a production order. */
export const sampleViewOf = (sample: SampleFacts | null | undefined) =>
  sample ? { style: sample.style, round: sample.round ? { id: sample.round.id, number: sample.round.number, kind: sample.round.kind, roundNo: sample.round.roundNo, stage: sample.round.stage } : null } : null

/** The where-clause of production orders (planning's netting, the drafts a plan's or a request's lines go into). */
export const productionOrderWhere = { kind: { in: [...PRODUCTION_ORDER_KINDS] } } satisfies Prisma.PurchaseOrderWhereInput

/** Inside a command: a plan's or a request's lines go on a production order, never on the sample draft named (409 in words). */
export async function assertTakesPlanLines(db: Reader, order: Pick<OrderRow, 'id' | 'number'>): Promise<void> {
  const row = await db.purchaseOrder.findUnique({ where: { id: order.id }, select: { kind: true } })
  if (row && row.kind === 'SAMPLE') throw new SampleOrderRefusedError(planLinesRefusal(order.number), 'body/into')
}
