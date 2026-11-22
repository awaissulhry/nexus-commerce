import type { DeliveryRow } from './delivered/api'
import { alsoCarries } from './model'
import { nextOf, type ShipmentFacts } from './rows'
import type { ShipmentRow } from './where'

/**
 * os-fx7 (order SHIPMENTS tab; 30-walk W-06, W-07, W-12) — what the tab reads of a shipment beyond the order read, pure: WHICH reads a
 * row needs (few rows need any) and WHAT each answer says. The container (use-shipments-acts.ts) runs the reads; nothing is guessed:
 * a read not made or failed says nothing (the row keeps its plainer words).
 *
 *   problems  a live row with open tracking problems → Warehouse's tracking-problems read → the open ones' kinds
 *   ddt       a PACKED Nexus row waiting for its DDT, whose reader may say it travels without one → the DDT preview → the company's
 *             missing legal details (`company/…` refusals: what no form on the DDT can fill, so the DDT cannot be issued)
 *   others    a row carrying other orders' garments → Warehouse's shipment read → those garments, by order, style and colour
 */
export type FactRead = 'problems' | 'ddt' | 'others'

export function factReadsOf(row: ShipmentRow, delivery: DeliveryRow | null, orderId: string): FactRead[] {
  const reads: FactRead[] = []
  const final = row.status === 'CANCELLED' || row.status === 'DELIVERED' || row.status === 'RETURNED'
  if (!final && delivery && delivery.openProblems > 0) reads.push('problems')
  const next = nextOf(row)
  if (next?.kind === 'step' && next.step === 'ddt' && row.may?.ddt === true && row.may.manage) reads.push('ddt')
  if (row.status !== 'CANCELLED' && (row.otherPieces ?? 0) > 0 && alsoCarries(row, orderId).length > 0) reads.push('others')
  return reads
}

/** The open problems' kinds, once each, in the order raised; none open: null. */
export function problemsOf(read: { readonly noScanDays: number; readonly problems: readonly { readonly kind: string; readonly resolvedAt: string | null }[] }): ShipmentFacts['problems'] | null {
  const kinds = [...new Set(read.problems.filter((problem) => problem.resolvedAt === null).map((problem) => problem.kind))]
  return kinds.length > 0 ? { kinds, noScanDays: read.noScanDays } : null
}

/** The company's legal details the DDT refuses without (factory-domain documents/legal.ts), in the catalogue's field names. */
export const DDT_COMPANY_FIELDS = ['legalName', 'address', 'vatNumber', 'fiscalCode', 'rea', 'shareCapital', 'currency'] as const

/** The DDT preview's refusals that make it impossible to issue (the company's own details); [] when it can be issued. */
export function ddtBlocksOf(problems: readonly { readonly path: string }[]): string[] {
  const fields = problems.flatMap((problem) => {
    const field = problem.path.startsWith('company/') ? problem.path.slice('company/'.length) : null
    return field !== null && (DDT_COMPANY_FIELDS as readonly string[]).includes(field) ? [field] : []
  })
  return [...new Set(fields)]
}

/**
 * The other orders' garments on a shared shipment: "+ 18 pcs of SEED-SO-0003 (SEED-JKT-02 Black 18)" — by order (the row's own
 * order list, so only orders the row names), then style and colour. A line without its order (the floor's read) is not counted.
 */
export function othersOf(
  lines: readonly { readonly salesOrderId?: string | undefined; readonly styleCode: string; readonly colourwayName: string; readonly quantity: number }[],
  row: ShipmentRow,
  orderId: string,
): NonNullable<ShipmentFacts['others']> {
  return alsoCarries(row, orderId).flatMap((other) => {
    const own = lines.filter((line) => line.salesOrderId === other.id)
    if (own.length === 0) return []
    const groups = new Map<string, number>()
    for (const line of own) {
      const key = `${line.styleCode} ${line.colourwayName}`
      groups.set(key, (groups.get(key) ?? 0) + line.quantity)
    }
    const pieces = own.reduce((sum, line) => sum + line.quantity, 0)
    return [{ number: other.number, pieces, what: [...groups].map(([key, quantity]) => `${key} ${quantity}`).join(', ') }]
  })
}
