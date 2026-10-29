import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandTools } from '../../../core/command'
import { allocateNumber, assertNumberUniqueInTenant } from '../../../platform/numbering/allocate'

/**
 * The numbers of a goods receipt and its lots (B-W1-32; the seam for B-W1-33's floor receiving): the receipt's from the
 * company's GOODS_RECEIPT series, each lot's from its LOT series, taken INSIDE the caller's command, office, system or
 * a floor tablet's (allocateNumber: the floor numbers these kinds of its own site's company, through the same gapless
 * series as the office). A lot number is unique in the tenant, so a number another company's series printed already is
 * refused in words (409) before the Lot's unique key would fail.
 *
 * Lock order: the caller's own locks (the order's row, its receiving lock) → the GOODS_RECEIPT series → each LOT series
 * (the same order as the office's receipt command). A command that rolls back takes no number.
 *
 *   // B-W1-33, inside the floor's receiving command (Idempotency-Key, inventory.receive at the device's site):
 *   const { number, lots } = await numberReceipt(tools, { companyId: order.companyId, receiptId, date, lotIds })
 */

export interface ReceiptNumbering {
  readonly companyId: string
  readonly receiptId: string
  /** The receipt's business date (Europe/Rome): the day the goods arrived. */
  readonly date: BusinessDate
  /** The ids the receipt's lots will have, in the order to number them. */
  readonly lotIds: readonly string[]
}

/** A number from the company's series, or why there is none (409 in words, not a 404 of the caller's record). */
async function issue(tools: CommandTools, kind: 'GOODS_RECEIPT' | 'LOT', companyId: string, record: { readonly type: string; readonly id: string; readonly date: BusinessDate }) {
  try {
    return await allocateNumber(tools, { companyId, kind }, record)
  } catch (error) {
    if (error instanceof NotFoundError) throw new InvalidStateError(`${error.message} (${kind === 'LOT' ? 'lots' : 'goods receipts'} are numbered from it).`)
    throw error
  }
}

/** The receipt's number (GR-2026-0042). */
export async function receiptNumber(tools: CommandTools, input: Pick<ReceiptNumbering, 'companyId' | 'receiptId' | 'date'>): Promise<string> {
  return (await issue(tools, 'GOODS_RECEIPT', input.companyId, { type: 'GoodsReceipt', id: input.receiptId, date: input.date })).formatted
}

/** One lot's number (LA-000042), unique in the tenant. */
export async function lotNumber(tools: CommandTools, input: { readonly companyId: string; readonly lotId: string; readonly date: BusinessDate }): Promise<string> {
  const issued = await issue(tools, 'LOT', input.companyId, { type: 'Lot', id: input.lotId, date: input.date })
  await assertNumberUniqueInTenant(tools, issued)
  // A lot made without the series (opening stock before it, a seed) is seen only within the caller's reach.
  if (await tools.tx.lot.findFirst({ where: { code: issued.formatted }, select: { id: true } })) {
    throw new InvalidStateError(`Lot number ${issued.formatted} is another company's lot already: give each company's LOT series its own prefix (an admin, under numbering).`)
  }
  return issued.formatted
}

/** The receipt's number and its lots' numbers, in one go (the floor's receiving command, B-W1-33). */
export async function numberReceipt(tools: CommandTools, input: ReceiptNumbering): Promise<{ number: string; lots: { lotId: string; code: string }[] }> {
  const number = await receiptNumber(tools, input)
  const lots: { lotId: string; code: string }[] = []
  for (const lotId of input.lotIds) lots.push({ lotId, code: await lotNumber(tools, { companyId: input.companyId, lotId, date: input.date }) })
  return { number, lots }
}
