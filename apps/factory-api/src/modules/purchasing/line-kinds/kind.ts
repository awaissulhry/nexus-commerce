import type { Prisma } from '@nexus/factory-db'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { certificateWords, isPpeLine } from '@nexus/factory-domain/purchasing/line-kinds/certificates'
import { normalRolls, rollsOf, rollsProblems, rollsQuantity, type Rolls, type RollsInput } from '@nexus/factory-domain/purchasing/line-kinds/rolls'
import { PURCHASING_MANAGE } from '@nexus/factory-domain/purchasing/permissions'
import type { CommandCaller } from '../../../core/command'
import { computed, itemFor, lineAudit, linesChanged } from '../lines'
import { assertDraft, onOrder } from '../orders'
import { assertScheduledEdit, sameQuantity } from '../po-depth/hooks'
import { dayOf, decimal, LINE_COLUMNS, officeOrder, quantityText } from '../store'
import { lineKindsOf, type LineKindsView } from './read'
import { certificateCheckOf, KIND_COLUMNS, readKindFacts, variantOf, widthOfItem } from './store'

/**
 * A draft line by its kind (B-W2b-328; SCM-076, SCM-077, SCM-186; design purchasing.orders "Lines": "Fabric: roll length and
 * width; protectors: certificate reference EN 1621"), ONE command on the order (its version guards it), only while the
 * order is a draft (the triggers too):
 *
 *   rolls          a fabric or trim line's rolls, each roll's length (m) and usable width (cm; the material's own by
 *                  default). The line's quantity follows when its unit can say it (ROLL, a length, an area), with its base
 *                  quantity, amount and the order's total; a scheduled line's quantity is its deliveries' (409).
 *   certificateId  a protector's certificate: one of the PPE register's that covers the material from this supplier today
 *                  (B-W2b-255's bought-in rule); one that does not is a 409 in words.
 *   variantCode    the material's ACTIVE variant the line buys, of the line's colour; a line without a colour takes the
 *                  variant's (not a line that buys a line of the plan: its colour is the plan's).
 *
 *   PUT /purchasing/orders/:purchaseOrderId/lines/:lineId/kind {version, rolls?, certificateId?, variantCode?}  purchasing.manage
 */

export interface KindBody {
  readonly version: number
  readonly rolls?: RollsInput | null | undefined
  readonly certificateId?: string | null | undefined
  readonly variantCode?: string | null | undefined
}

const kindAudit = (row: { rolls: number | null; rollLengthM: { toString(): string } | null; rollWidthCm: { toString(): string } | null; certificateId: string | null; variantCode: string | null }) => ({
  rolls: rollsOf(row),
  certificateId: row.certificateId,
  variantCode: row.variantCode,
})

/** purchasing.manage: the line's rolls, certificate and variant (each sent replaces the one before; null clears it). */
export async function putLineKind(caller: CommandCaller, orderId: string, lineId: string, body: KindBody, idempotencyKey?: string): Promise<{ kinds: LineKindsView }> {
  if (body.rolls === undefined && body.certificateId === undefined && body.variantCode === undefined) {
    throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send the rolls, the certificate or the variant.' }])
  }
  const order = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  return onOrder(caller, order, { name: 'purchasing.lines.kind', idempotencyKey, input: { orderId, lineId, ...body }, version: body.version }, async (tools, current) => {
    assertDraft(current)
    const { tx, now } = tools
    const line = isUuid(lineId) ? await tx.purchaseOrderLine.findUnique({ where: { id: lineId }, select: LINE_COLUMNS }) : null
    if (!line || line.purchaseOrderId !== current.id) throw new NotFoundError('Line not found.')
    if (line.cancelledAt !== null) throw new ConflictError(`Line ${line.seq} is cancelled: it changes no more.`)
    const item = await itemFor(tools, current, line.itemId)
    const before = (await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: line.id }, select: KIND_COLUMNS }))
    const facts = await readKindFacts(tx, current, [line])
    const kindItem = facts.items.get(line.itemId)!
    const today = businessDate(now)
    const data: Prisma.PurchaseOrderLineUncheckedUpdateInput = { version: { increment: 1 } }

    // Rolls: the line's quantity follows when its unit can say it.
    let rolls: Rolls | null = rollsOf(before)
    if (body.rolls !== undefined) {
      if (body.rolls === null) rolls = null
      else {
        const input: RollsInput = { ...body.rolls, widthCm: body.rolls.widthCm === undefined ? widthOfItem(kindItem) : body.rolls.widthCm }
        const problems = rollsProblems(input, item)
        if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
        rolls = normalRolls(input)
      }
      data.rolls = rolls?.count ?? null
      data.rollLengthM = rolls?.lengthM ?? null
      data.rollWidthCm = rolls?.widthCm ?? null
      const made = rolls ? rollsQuantity(rolls, line.uom as Uom) : null
      if (made !== null && !sameQuantity(line.quantity, made)) {
        await assertScheduledEdit(tx, line, { quantity: true, uom: false, needDate: false })
        const numbers = computed(current, item, {
          quantity: made,
          uom: line.uom as Uom,
          unitPrice: line.unitPrice.toString(),
          needDate: dayOf(line.needDate)!,
          grade: line.grade,
          thicknessMinMm: decimal(line.thicknessMinMm),
          thicknessMaxMm: decimal(line.thicknessMaxMm),
          oneDyeBatch: line.oneDyeBatch,
          areaTolerancePct: decimal(line.areaTolerancePct),
        })
        data.quantity = made
        data.baseQuantity = numbers.baseQuantity
        data.netAmount = numbers.netAmount
        data.estimatedHides = numbers.estimatedHides
      }
    }

    // The certificate: one of the register's that covers the material from this supplier today.
    if (body.certificateId !== undefined) {
      if (body.certificateId !== null) {
        if (!isPpeLine(kindItem)) {
          throw new ValidationError(`${item.code} is no PPE component: only a protector's line names a certificate.`, [{ path: 'body/certificateId', message: 'Only on a protector line.' }])
        }
        if (!facts.certificates.has(body.certificateId)) {
          const known = await tx.certificate.findUnique({ where: { id: body.certificateId }, select: { id: true, companyId: true } })
          if (!known || (known.companyId !== null && known.companyId !== current.companyId)) {
            throw new ValidationError('Not a certificate of the PPE register.', [{ path: 'body/certificateId', message: 'A certificate of the register, of this company or of every company.' }])
          }
        }
        const named = certificateCheckOf(facts, line, body.certificateId, current.partyId, today)!
        if (named.check.state !== 'HOLDS') {
          const words = certificateWords(named.check, named.facts ?? (await certificateFacts(tx, body.certificateId)), item.code)
          throw new DomainError('conflict', `${words} Name a certificate that covers ${item.code} from this supplier today.`, [{ path: 'body/certificateId', message: words }])
        }
      }
      data.certificateId = body.certificateId
    }

    // The variant: ACTIVE, of the line's colour; a line without a colour takes the variant's.
    if (body.variantCode !== undefined) {
      if (body.variantCode !== null) {
        const variant = variantOf(facts, { itemId: line.itemId, itemColourId: line.itemColourId }, body.variantCode)!
        if (!variant.row) throw new ValidationError(`${item.code} has no variant ${body.variantCode}.`, [{ path: 'body/variantCode', message: 'A variant of the line’s material.' }])
        if (variant.row.status !== 'ACTIVE') throw new DomainError('conflict', variant.problem!, [{ path: 'body/variantCode', message: variant.problem! }])
        if (variant.row.itemColourId !== null && line.itemColourId === null) {
          if ((await tx.materialRequirement.count({ where: { purchaseOrderLineId: line.id } })) > 0) {
            throw new ConflictError(`Line ${line.seq} buys a line of the plan without a colour: variant ${body.variantCode} is of one colour; add a line in that colour instead.`)
          }
          const colour = await tx.itemColour.findUniqueOrThrow({ where: { id: variant.row.itemColourId }, select: { id: true, status: true, supplierColourCode: true } })
          if (colour.status !== 'ACTIVE') throw new ConflictError(`Variant ${body.variantCode} is of an archived colour of ${item.code}.`)
          data.itemColourId = colour.id
          if (line.supplierColourCode === null) data.supplierColourCode = colour.supplierColourCode
        } else if (variant.problem) {
          throw new DomainError('conflict', variant.problem, [{ path: 'body/variantCode', message: variant.problem }])
        }
      }
      data.variantCode = body.variantCode
    }

    await tx.purchaseOrderLine.update({ where: { id: line.id }, data, select: { id: true } })
    const after = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: line.id }, select: { ...LINE_COLUMNS, ...KIND_COLUMNS } })
    await linesChanged(tools, current, { changed: 1 }, {
      action: 'purchasing.lines.kind',
      before: { lineId: line.id, line: lineAudit(line), kind: kindAudit(before) },
      after: { lineId: line.id, line: lineAudit(after), kind: kindAudit(after), quantity: quantityText(after.quantity) },
    })
    return { kinds: await lineKindsOf(tx, tools.context, current.id, now) }
  })
}

async function certificateFacts(tx: Parameters<typeof readKindFacts>[0], id: string) {
  const row = await tx.certificate.findUnique({ where: { id }, select: { id: true, number: true, standard: true, status: true, validFrom: true, validTo: true } })
  return row ? { id: row.id, number: row.number, standard: row.standard, status: row.status, validFrom: dayOf(row.validFrom)!, validTo: dayOf(row.validTo)! } : null
}
