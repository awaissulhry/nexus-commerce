import { ConflictError } from '@nexus/factory-domain/core/errors'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { defaultCertificateOf, isPpeLine, lineCertificateCheck, receiptHoldWords } from '@nexus/factory-domain/purchasing/line-kinds/certificates'
import { rollsOf, rollsQuantity, rollsWords } from '@nexus/factory-domain/purchasing/line-kinds/rolls'
import type { CommandTx } from '../../../core/command'
import { coveragesOf, KIND_COLUMNS, namedOf } from './store'

/**
 * B-W2b-328: what other commands call so a line's kind stays true (each a small step INSIDE the caller's command; this file
 * imports no command module, so W1's files import it without a cycle).
 *
 *   certificateDefaultFor  a new line of a PPE component (insertLine: by hand, from the plan, from a request): it names the
 *                          certificate the incoming check would pick today, when the register has one
 *   assertKindEdit         a draft line edited (W1's editLine): a quantity or unit its rolls make, or a colour its variant
 *                          is not of, is a 409 in words (change the rolls or the variant first)
 *   receiptKindsOf         a goods receipt (the office's or a goods-in tablet's): each order line's variant (its lots carry
 *                          it: the database's rule) and, for a line that names a certificate, the check again on the day
 *                          the goods come — when it no longer holds, the reason its lots wait in quarantine
 *   withReceiptHolds       the receipt's lots of such a line start in quarantine with that reason (a line that comes
 *                          without lots — a material not tracked — cannot wait: 409 in words)
 */

/** The certificate a new line of this material names by default (`{}` when none, or not a PPE component). */
export async function certificateDefaultFor(tx: CommandTx, order: { readonly companyId: string; readonly partyId: string }, itemId: string, day: BusinessDate): Promise<{ certificateId?: string }> {
  const item = await tx.item.findUnique({ where: { id: itemId }, select: { kind: true, isPpeComponent: true } })
  if (!item || !isPpeLine(item)) return {}
  const { coverages } = await coveragesOf(tx, order.companyId, [itemId])
  const certificateId = defaultCertificateOf(coverages.get(itemId) ?? [], order.partyId, day)
  return certificateId ? { certificateId } : {}
}

/** A 409 in words when an edit of a draft line changes what its rolls make, or takes it out of its variant's colour. */
export async function assertKindEdit(
  tx: CommandTx,
  line: { readonly id: string; readonly seq: number; readonly uom: string; readonly itemId: string },
  change: { readonly quantity: boolean; readonly uom: Uom | null; readonly itemColourId: string | null | undefined },
): Promise<void> {
  const kind = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: line.id }, select: KIND_COLUMNS })
  const rolls = rollsOf(kind)
  if (rolls && (change.quantity || change.uom !== null)) {
    const made = rollsQuantity(rolls, line.uom as Uom) ?? (change.uom ? rollsQuantity(rolls, change.uom) : null)
    if (made !== null) throw new ConflictError(`Line ${line.seq} is bought by rolls (${rollsWords(rolls)}): change its rolls, or clear them first (its kind).`)
  }
  if (kind.variantCode && change.itemColourId !== undefined) {
    const variant = await tx.itemVariant.findFirst({ where: { itemId: line.itemId, code: kind.variantCode }, select: { itemColourId: true } })
    if (variant?.itemColourId && variant.itemColourId !== change.itemColourId) {
      throw new ConflictError(`Line ${line.seq} buys variant ${kind.variantCode}, which is of another colour: clear the variant first, or choose one of the new colour (its kind).`)
    }
  }
}

export interface ReceiptKind {
  /** The variant the order line buys: its lots carry it. */
  readonly variantCode: string | null
  /** Why its lots wait in quarantine (its certificate no longer holds on the day the goods come), or null. */
  readonly hold: string | null
}

/** Each order line's variant and certificate hold for a receipt on `day` (by order line id). */
export async function receiptKindsOf(tx: CommandTx, order: { readonly id: string; readonly companyId: string; readonly partyId: string }, day: BusinessDate): Promise<Map<string, ReceiptKind>> {
  const rows = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: order.id }, select: { id: true, itemId: true, certificateId: true, variantCode: true, item: { select: { code: true } } } })
  const named = rows.filter((row) => row.certificateId !== null)
  const { coverages, certificates } = await coveragesOf(tx, order.companyId, named.map((row) => row.itemId))
  const missing = [...new Set(named.flatMap((row) => (certificates.has(row.certificateId!) ? [] : [row.certificateId!])))]
  if (missing.length > 0) {
    for (const row of await tx.certificate.findMany({ where: { id: { in: missing } }, select: { id: true, companyId: true, number: true, standard: true, ppeClass: true, status: true, validFrom: true, validTo: true } })) certificates.set(row.id, namedOf(row))
  }
  const kinds = new Map<string, ReceiptKind>()
  for (const row of rows) {
    const hold = row.certificateId ? receiptHoldWords(lineCertificateCheck(coverages.get(row.itemId) ?? [], row.certificateId, order.partyId, day), certificates.get(row.certificateId) ?? null, row.item.code) : null
    kinds.set(row.id, { variantCode: row.variantCode, hold })
  }
  return kinds
}

interface HeldLine {
  readonly purchaseOrderLineId: string
  readonly lots?: readonly { readonly holdReason?: string | undefined }[] | undefined
}

/** The receipt's body with the certificate's hold reason on each lot of such a line (the body itself when none). */
export function withReceiptHolds<Body extends { readonly lines: readonly HeldLine[] }>(body: Body, kinds: ReadonlyMap<string, ReceiptKind>): Body {
  if (![...kinds.values()].some((kind) => kind.hold !== null)) return body
  const lines = body.lines.map((line) => {
    const hold = kinds.get(line.purchaseOrderLineId)?.hold ?? null
    if (!hold) return line
    if (!line.lots || line.lots.length === 0) throw new ConflictError(`${hold} The material is not received by lot, so it cannot wait in quarantine: ask quality before receiving it.`)
    return { ...line, lots: line.lots.map((lot) => ({ ...lot, holdReason: lot.holdReason?.trim() ? `${lot.holdReason.trim()} · ${hold}` : hold })) }
  })
  return { ...body, lines } as Body
}
