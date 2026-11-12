import { arrivalDate, leadTimeWindow } from '@nexus/factory-domain/calendars/suppliers'
import { InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { supplyRulesFor } from '@nexus/factory-domain/planning/buy'
import { copiedNeedDate, copiedRequestedDate, copyLinesOf, givenNeedDateProblem } from '@nexus/factory-domain/purchasing/po-approvals/duplicate'
import { PURCHASING_MANAGE } from '@nexus/factory-domain/purchasing/permissions'
import { sourceFor } from '@nexus/factory-domain/purchasing/sources/sources'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import type { Prisma } from '@nexus/factory-db'
import { command, type CommandCaller } from '../../../core/command'
import { supplierCalendarsFor } from '../../../platform/calendars/service'
import { itemFor, insertLine } from '../lines'
import { assertBuyable, detailInCommand, insertDraft, refreshTotal } from '../orders'
import { dayOf, decimal, officeOrder, PARTY_COLUMNS, quantityText, readLines, readOrder, SITE_COLUMNS } from '../store'
import { activeSourcesOf } from '../supplier-items/store'
import type { OrderDetail } from '../views'

/**
 * Duplicate a purchase order, or reorder some of its lines (B-W2b-305; SCM-057; the rules: factory-domain
 * purchasing/po-approvals/duplicate.ts): a NEW draft to the same supplier for the same site, in ONE command (numbered from
 * the company's series, as any new draft). The supplier must still be one we buy from (W1's assertBuyable: blocked or
 * archived refused; B-W2b-311's supplier status when it lands there); a material or colour archived since is refused for
 * its line in words. Each line takes the defaults of a new line (B-W2a-10: the supplier's approved source's unit price
 * today), else the old line's price; its specification, codes and note as they were.
 *
 *   POST /purchasing/orders/:purchaseOrderId/duplicate {lineIds?, needDate?}    purchasing.manage over the company, site, supplier
 */

export interface DuplicateBody {
  /** The lines to copy (in the order's own order); none: every line not cancelled. */
  readonly lineIds?: readonly string[] | undefined
  /** One need date for every copied line; none: each line's own (see the rules). */
  readonly needDate?: string | null | undefined
}

export async function duplicateOrder(caller: CommandCaller, orderId: string, body: DuplicateBody, idempotencyKey?: string): Promise<{ order: OrderDetail; copiedFrom: { id: string; number: string }; lines: { fromLineId: string; lineId: string; seq: number; needDate: string; priceFrom: 'SOURCE' | 'COPIED' }[] }> {
  const source = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  const { result } = await command(caller, { name: 'purchasing.duplicate', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const today = businessDate(now)
    const given = body.needDate ?? null
    const dateProblem = givenNeedDateProblem(given, today)
    if (dateProblem) throw new ValidationError(dateProblem, [{ path: 'body/needDate', message: dateProblem }])
    const order = (await readOrder(tx, source.id))!
    const lines = await readLines(tx, order.id)
    const chosen = copyLinesOf(
      lines.map((line) => ({ id: line.id, seq: line.seq, cancelled: line.cancelledAt !== null })),
      body.lineIds ? [...body.lineIds] : null,
    )
    if (chosen.problems.length > 0) throw new ValidationError(chosen.problems[0]!.message, chosen.problems)
    const site = await tx.site.findUniqueOrThrow({ where: { id: order.siteId }, select: SITE_COLUMNS })
    if (site.status !== 'ACTIVE') throw new InvalidStateError('The site is archived: nothing is delivered there.')
    const party = await tx.party.findUnique({ where: { id: order.partyId }, select: PARTY_COLUMNS })
    if (!party) throw new NotFoundError('Supplier not found.')
    assertBuyable(party, 'partyId')
    const copied = lines.filter((line) => chosen.ids.includes(line.id))
    const items = new Map<string, Awaited<ReturnType<typeof itemFor>>>()
    for (const line of copied) if (!items.has(line.itemId)) items.set(line.itemId, await itemFor(tools, order, line.itemId))
    const colours = new Map((await tx.itemColour.findMany({ where: { id: { in: copied.flatMap((line) => (line.itemColourId ? [line.itemColourId] : [])) } }, select: { id: true, status: true } })).map((row) => [row.id, row.status]))
    const issues: Issue[] = []
    copied.forEach((line) => {
      const index = (body.lineIds ?? chosen.ids).indexOf(line.id)
      const path = body.lineIds ? `body/lineIds/${index}` : 'body'
      if (items.get(line.itemId)!.status !== 'ACTIVE') issues.push({ path, message: `Line ${line.seq}: its material is archived since; it is not ordered again.` })
      else if (line.itemColourId && colours.get(line.itemColourId) !== 'ACTIVE') issues.push({ path, message: `Line ${line.seq}: its colour is archived since; it is not ordered again.` })
    })
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)

    // The earliest day the supplier can deliver each material: today plus its lead time, around its closed days.
    const leads = new Map(copied.map((line) => {
      const item = items.get(line.itemId)!
      const rules = supplyRulesFor({ defaultSupplierId: item.defaultSupplierId, leadTimeDays: item.leadTimeDays, minOrderQty: decimal(item.minOrderQty), orderMultiple: decimal(item.orderMultiple) }, { id: party.id, leadTimeDays: party.leadTimeDays })
      return [line.id, rules.leadTimeDays ?? 0] as const
    }))
    const longest = Math.min(400, Math.max(0, ...leads.values()))
    const calendar = (await supplierCalendarsFor(tx as Prisma.TransactionClient, [party.id], leadTimeWindow(today, longest, 'forward'))).get(party.id)?.calendar ?? null
    const contact = order.contactId ? await tx.partyContact.findUnique({ where: { id: order.contactId }, select: { partyId: true, status: true } }) : null
    const made = await insertDraft(tools, {
      companyId: order.companyId,
      siteId: order.siteId,
      party,
      header: {
        ...(contact && contact.partyId === party.id && contact.status === 'ACTIVE' ? { contactId: order.contactId } : {}),
        currency: order.currency,
        requestedDate: copiedRequestedDate(dayOf(order.requestedDate), today),
        incoterms: order.incoterms,
        paymentTerms: order.paymentTerms,
        note: order.note,
      },
      source: 'OFFICE',
    })
    const draft = (await readOrder(tx, made.id))!
    const sources = await activeSourcesOf(tx, [...items.keys()])
    const answer: { fromLineId: string; lineId: string; seq: number; needDate: string; priceFrom: 'SOURCE' | 'COPIED' }[] = []
    for (const line of copied) {
      const item = items.get(line.itemId)!
      const own = sourceFor(sources, { companyId: order.companyId, itemId: item.id, itemColourId: line.itemColourId }, party.id)
      const fromSource = own !== null && own.partyId === party.id
      const needDate = copiedNeedDate(dayOf(line.needDate)!, arrivalDate(calendar, today, leads.get(line.id) ?? 0).date, given)
      const copiedLine = await insertLine(tools, draft, item, {
        itemColourId: line.itemColourId,
        description: line.description,
        supplierArticleCode: line.supplierArticleCode,
        supplierColourCode: line.supplierColourCode,
        note: line.note,
        quantity: quantityText(line.quantity),
        uom: line.uom as Uom,
        needDate,
        grade: line.grade,
        thicknessMinMm: decimal(line.thicknessMinMm),
        thicknessMaxMm: decimal(line.thicknessMaxMm),
        oneDyeBatch: line.oneDyeBatch,
        areaTolerancePct: decimal(line.areaTolerancePct),
        ...(fromSource ? {} : { unitPrice: line.unitPrice.toFixed(6) }),
      })
      answer.push({ fromLineId: line.id, lineId: copiedLine.id, seq: copiedLine.seq, needDate, priceFrom: fromSource ? 'SOURCE' : 'COPIED' })
    }
    await refreshTotal(tools, draft.id)
    tools.audit({
      action: 'purchasing.duplicate',
      recordType: 'PurchaseOrder',
      recordId: draft.id,
      companyId: draft.companyId,
      siteId: draft.siteId,
      after: { number: draft.number, copiedFrom: { id: order.id, number: order.number, revision: order.revision }, lines: answer.map((entry) => ({ fromLineId: entry.fromLineId, lineId: entry.lineId, needDate: entry.needDate, priceFrom: entry.priceFrom })) },
    })
    tools.emit({ type: 'purchase_order.copied', subject: draft.id, companyId: draft.companyId, siteId: draft.siteId, payload: { purchaseOrderId: draft.id, number: draft.number, fromPurchaseOrderId: order.id, fromNumber: order.number, lines: answer.length } })
    return { ...(await detailInCommand(tools, draft.id)), copiedFrom: { id: order.id, number: order.number }, lines: answer }
  })
  return result
}
