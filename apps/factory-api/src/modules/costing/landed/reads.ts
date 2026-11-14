import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { LandedAllocationView, LandedChargeView, LandedQuery } from '@nexus/factory-domain/costing/landed/contracts'
import { COSTING_LANDED_MANAGE } from '@nexus/factory-domain/costing/landed/permissions'
import { LANDED_BASIS_WORDS, type LandedBasis, type LandedStatus } from '@nexus/factory-domain/costing/landed/rules'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { ACCOUNTANT_WAITS } from '@nexus/factory-domain/costing/ppv/settings'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { peopleNames } from '../../accounting/store'
import { contextOf } from '../../product/materials/store'
import { unique, type Reader } from '../actual/store'
import { actualSettingsOf, waitsOf } from '../ppv/settings'

/**
 * Landed cost reads (B-W2b-407; FIN-044), costing.view over the invoice's company and supplier: the supplier invoices'
 * charge lines (freight, duty, a broker's fee) with where each stands (waiting, a draft, posted), and one landed cost
 * with its shares per lot. Amounts are money.cost; who posted or reversed it is named only inside the one record.
 */

const SCOPE = { company: 'companyId', party: 'partyId' } as const
const LIMIT = 200

const day = (value: Date): string => value.toISOString().slice(0, 10)

/** One landed cost as the screens show it (404 when it is gone: a draft removed). */
export async function allocationView(db: Reader, context: RequestContext, allocationId: string): Promise<LandedAllocationView> {
  const row = await db.landedCostAllocation.findUnique({
    where: { id: allocationId },
    select: { id: true, companyId: true, partyId: true, supplierInvoiceLineId: true, basis: true, amount: true, currency: true, status: true, postedAt: true, postedById: true, reversedAt: true, reversedById: true, reverseReason: true, note: true, version: true },
  })
  if (!row) throw new NotFoundError('Landed cost not found.')
  const line = await db.supplierInvoiceLine.findUniqueOrThrow({ where: { id: row.supplierInvoiceLineId }, select: { id: true, seq: true, description: true, netAmount: true, invoiceId: true } })
  const invoice = await db.supplierInvoice.findUniqueOrThrow({ where: { id: line.invoiceId }, select: { id: true, number: true, issueDate: true, status: true } })
  const party = await db.party.findUnique({ where: { id: row.partyId }, select: { legalName: true, tradeName: true } })
  const shares = await db.landedCostShare.findMany({ where: { allocationId }, select: { id: true, lotId: true, siteId: true, itemId: true, basisAmount: true, amount: true }, orderBy: { key: 'asc' } })
  const lots = new Map((await db.lot.findMany({ where: { id: { in: shares.map((share) => share.lotId) } }, select: { id: true, code: true, receiptLineId: true } })).map((lot) => [lot.id, lot]))
  const items = new Map((await db.item.findMany({ where: { id: { in: unique(shares.map((share) => share.itemId)) } }, select: { id: true, code: true, name: true, baseUom: true } })).map((item) => [item.id, item]))
  const sites = new Map((await db.site.findMany({ where: { id: { in: unique(shares.map((share) => share.siteId)) } }, select: { id: true, code: true } })).map((site) => [site.id, site.code]))
  const receiptLines = new Map((await db.goodsReceiptLine.findMany({ where: { id: { in: unique([...lots.values()].map((lot) => lot.receiptLineId)) } }, select: { id: true, receiptId: true } })).map((line) => [line.id, line.receiptId]))
  const receipts = new Map((await db.goodsReceipt.findMany({ where: { id: { in: unique([...receiptLines.values()]) } }, select: { id: true, number: true } })).map((receipt) => [receipt.id, receipt.number]))
  const received = await db.stockMove.groupBy({ by: ['lotId'], where: { lotId: { in: shares.map((share) => share.lotId) }, reason: 'RECEIPT', reversalOfId: null }, _sum: { baseQuantity: true } })
  const receivedOf = new Map(received.map((group) => [group.lotId, group._sum.baseQuantity]))
  const names = await peopleNames(db, [row.postedById, row.reversedById])
  const settings = await actualSettingsOf(db, row.companyId)
  const manage = can(actorOf(context), COSTING_LANDED_MANAGE, { companyId: row.companyId, partyId: row.partyId })
  const status = row.status as LandedStatus
  const basis = row.basis as LandedBasis
  const total = shares.reduce((sum, share) => sum + share.amount, 0)
  return {
    id: row.id,
    companyId: row.companyId,
    supplier: { id: row.partyId, name: party ? (party.tradeName ?? party.legalName) : '' },
    invoice: { id: invoice.id, number: invoice.number, issueDate: day(invoice.issueDate), status: invoice.status },
    line: { id: line.id, seq: line.seq, description: line.description, netAmount: asMoney('cost', line.netAmount) },
    basis,
    basisWords: LANDED_BASIS_WORDS[basis],
    amount: asMoney('cost', row.amount),
    currency: row.currency,
    status,
    postedAt: row.postedAt ? toUtcIso(row.postedAt) : null,
    postedBy: row.postedById ? { id: row.postedById, name: names.get(row.postedById) ?? '' } : null,
    reversedAt: row.reversedAt ? toUtcIso(row.reversedAt) : null,
    reversedBy: row.reversedById ? { id: row.reversedById, name: names.get(row.reversedById) ?? '' } : null,
    reverseReason: row.reverseReason,
    note: row.note,
    version: row.version,
    shares: shares.map((share) => {
      const lot = lots.get(share.lotId)
      const item = items.get(share.itemId)
      const receiptId = lot?.receiptLineId ? receiptLines.get(lot.receiptLineId) : undefined
      const quantity = receivedOf.get(share.lotId)
      return {
        id: share.id,
        lot: { id: share.lotId, code: lot?.code ?? '' },
        item: { id: share.itemId, code: item?.code ?? '', name: item?.name ?? '', baseUom: (item?.baseUom ?? 'PCS') as Uom },
        site: { id: share.siteId, code: sites.get(share.siteId) ?? '' },
        receipt: receiptId ? { id: receiptId, number: receipts.get(receiptId) ?? '' } : null,
        receivedQuantity: quantity ? quantity.toFixed(4) : null,
        basisAmount: asMoney('cost', share.basisAmount.toFixed(4)),
        amount: asMoney('cost', share.amount),
      }
    }),
    words:
      status === 'POSTED'
        ? `Posted: each lot's cost carries its share from ${businessDate(row.postedAt!)} (what leaves a lot is valued with it).`
        : status === 'REVERSED'
          ? `Reversed${row.reverseReason ? `: ${row.reverseReason}` : '.'} The shares no longer count in the lots' cost.`
          : `A draft over ${shares.length} lot(s)${total === row.amount ? '' : ' (its shares do not add up to the charge yet)'}: nothing moves until it is posted.`,
    waits: settings.postingsOn ? null : ACCOUNTANT_WAITS,
    can: { change: manage && status === 'DRAFT', post: manage && status === 'DRAFT' && settings.postingsOn && shares.length > 0, reverse: manage && status === 'POSTED', remove: manage && status === 'DRAFT' },
  }
}

/** GET /costing/landed/:allocationId */
export async function landedDetail(caller: CommandCaller, allocationId: string): Promise<LandedAllocationView> {
  const context = contextOf(caller)
  return caller.withClient(async (db) => {
    const row = isUuid(allocationId) ? await db.landedCostAllocation.findUnique({ where: { id: allocationId }, select: { companyId: true, partyId: true } }) : null
    if (!row || !can(actorOf(context), COSTING_VIEW, { companyId: row.companyId, partyId: row.partyId })) throw new NotFoundError('Landed cost not found.')
    return allocationView(db, context, allocationId)
  })
}

/** GET /costing/landed: the charge lines of the supplier invoices in scope (not voided, above 0), newest invoice first. */
export async function landedCharges(caller: CommandCaller, query: LandedQuery): Promise<{ charges: LandedChargeView[]; truncated: boolean; waits: string | null; empty: string }> {
  const actor = actorOf(contextOf(caller))
  const limit = query.limit ?? LIMIT
  return caller.withClient(async (db) => {
    const invoices = await db.supplierInvoice.findMany({
      where: {
        AND: [
          scopeWhere(actor, COSTING_VIEW, SCOPE) as Prisma.SupplierInvoiceWhereInput,
          { status: { not: 'VOIDED' }, kind: 'INVOICE' },
          query.companyId ? { companyId: query.companyId } : {},
          query.partyId ? { partyId: query.partyId } : {},
          query.supplierInvoiceId ? { id: query.supplierInvoiceId } : {},
        ],
      },
      select: { id: true, companyId: true, partyId: true, number: true, issueDate: true, status: true, currency: true },
      orderBy: [{ issueDate: 'desc' }, { id: 'desc' }],
      take: 2_000,
    })
    const lines = await db.supplierInvoiceLine.findMany({ where: { invoiceId: { in: invoices.map((row) => row.id) }, kind: 'CHARGE', netAmount: { gt: 0 } }, select: { id: true, invoiceId: true, seq: true, description: true, netAmount: true }, orderBy: [{ invoiceId: 'asc' }, { seq: 'asc' }] })
    const allocations = await db.landedCostAllocation.findMany({ where: { supplierInvoiceLineId: { in: lines.map((row) => row.id) } }, select: { id: true, supplierInvoiceLineId: true, status: true, basis: true, version: true } })
    const parties = new Map((await db.party.findMany({ where: { id: { in: unique(invoices.map((row) => row.partyId)) } }, select: { id: true, legalName: true, tradeName: true } })).map((row) => [row.id, row.tradeName ?? row.legalName]))
    const order = new Map(invoices.map((row, index) => [row.id, index]))
    const charges: LandedChargeView[] = []
    for (const line of [...lines].sort((a, b) => order.get(a.invoiceId)! - order.get(b.invoiceId)! || a.seq - b.seq)) {
      const invoice = invoices[order.get(line.invoiceId)!]!
      const mine = allocations.filter((row) => row.supplierInvoiceLineId === line.id)
      const live = mine.find((row) => row.status === 'POSTED') ?? mine.find((row) => row.status === 'DRAFT') ?? null
      const state = live ? (live.status === 'POSTED' ? 'POSTED' : 'DRAFT') : 'WAITING'
      if (query.state && query.state !== state) continue
      charges.push({
        companyId: invoice.companyId,
        supplier: { id: invoice.partyId, name: parties.get(invoice.partyId) ?? '' },
        invoice: { id: invoice.id, number: invoice.number, issueDate: day(invoice.issueDate), status: invoice.status },
        line: { id: line.id, seq: line.seq, description: line.description, netAmount: asMoney('cost', line.netAmount) },
        currency: invoice.currency,
        state,
        allocation: live ? { id: live.id, status: live.status as LandedStatus, basis: live.basis as LandedBasis, version: live.version } : null,
        reversed: mine.filter((row) => row.status === 'REVERSED').length,
      })
    }
    return {
      charges: charges.slice(0, limit),
      truncated: charges.length > limit,
      waits: await waitsOf(db, query.companyId),
      empty: 'No charge to land: no supplier invoice in scope has a freight, duty or broker charge line.',
    }
  })
}
