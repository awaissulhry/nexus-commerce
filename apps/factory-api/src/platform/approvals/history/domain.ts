import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { PEOPLE_TIMESHEETS_HR, PEOPLE_TIMESHEETS_TEAM } from '@nexus/factory-domain/people/overtime/permissions'
import { PRODUCT_CHANGES_VIEW } from '@nexus/factory-domain/product/changes/permissions'
import { PRODUCTION_INSTRUCTIONS_VIEW } from '@nexus/factory-domain/production/instructions/permissions'
import { PRODUCTION_SCRAP_VIEW } from '@nexus/factory-domain/production/scrap/permissions'
import { QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import { QUALITY_PLANS_VIEW } from '@nexus/factory-domain/quality/plans/permissions'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
// B-W2b-403
import { PAYABLES_VIEW } from '@nexus/factory-domain/payables/permissions'
import { line, SOURCE_LIMIT, versionWords, type HistoryLine, type HistorySource, type Place } from './source'

/**
 * The domain approvals that keep their own tables (B-W2b-282; plan "A domain that already has its approval table keeps it"),
 * read for a record's history (PLT-104). Each says who asked and who decided, as its table records it; nothing is written.
 *
 *   Quote            QuoteApproval (per quote version): asked (createdById, the request's note), approved / rejected /
 *                    withdrawn (decidedById, the decision's note)                                   quotes.view
 *   ChangeOrder      ChangeApproval: each approver asked (who named them), their decision with why  product.changes.view
 *   Operation        OperationTimeVersion (an SMV change): proposed (with why), approved / rejected  product.routing.view
 *   Nonconformance   NcrDispositionLine needing a yes: decided (asks the yes), approved             quality.ncr.view
 *   OperationScan    ScrapApproval (scrap above the limit): asked by the scan, approved / refused   production.scrap.view
 *   TimesheetApproval  the lead's yes (Reviewed), HR's yes (Approved), sent back (with why)         people.timesheets.hr | team
 *   InspectionPlan   InspectionPlanVersion: drafted (with its change note), approved (signed)       quality.plans.view
 *   WorkInstruction  WorkInstructionVersion: drafted (with its change note), published             production.instructions.view
 */

const placeOf = (row: { companyId: string | null; siteId?: string | null; partyId?: string | null } | null): Place | null => (row ? { companyId: row.companyId, siteId: row.siteId ?? null, partyId: row.partyId ?? null } : null)
const onPlace = (permission: Parameters<typeof can>[1]) => (actor: Actor, place: Place) => can(actor, permission, { companyId: place.companyId, siteId: place.siteId, partyId: place.partyId ?? null })

const QUOTE: HistorySource = {
  recordType: 'Quote',
  place: async (db, id) => placeOf(await db.quote.findUnique({ where: { id }, select: { companyId: true, partyId: true } })),
  may: onPlace(QUOTES_VIEW),
  async lines(db, id) {
    const rows = await db.quoteApproval.findMany({
      where: { quoteVersion: { quoteId: id } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: SOURCE_LIMIT,
      select: { id: true, status: true, requestNote: true, createdAt: true, createdById: true, decidedAt: true, decidedById: true, decisionNote: true, quoteVersion: { select: { revision: true } } },
    })
    return rows.flatMap((row) => {
      const out: HistoryLine[] = [line({ id: `${row.id}:asked`, source: 'QuoteApproval', action: 'REQUESTED', at: row.createdAt, byId: row.createdById, words: versionWords(row.quoteVersion.revision, row.requestNote) })]
      if (row.decidedAt && row.status !== 'PENDING') out.push(line({ id: `${row.id}:decided`, source: 'QuoteApproval', action: row.status as 'APPROVED' | 'REJECTED' | 'WITHDRAWN', at: row.decidedAt, byId: row.decidedById, words: row.decisionNote }))
      return out
    })
  },
}

const CHANGE_ORDER: HistorySource = {
  recordType: 'ChangeOrder',
  place: async (db, id) => placeOf(await db.changeOrder.findUnique({ where: { id }, select: { companyId: true } })),
  may: onPlace(PRODUCT_CHANGES_VIEW),
  async lines(db, id) {
    const rows = await db.changeApproval.findMany({ where: { changeOrderId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: SOURCE_LIMIT, select: { id: true, approverId: true, decision: true, decidedAt: true, reason: true, createdAt: true, createdById: true } })
    return rows.flatMap((row) => {
      const out: HistoryLine[] = [line({ id: `${row.id}:asked`, source: 'ChangeApproval', action: 'REQUESTED', at: row.createdAt, byId: row.createdById, words: null })]
      if (row.decision && row.decidedAt) out.push(line({ id: `${row.id}:decided`, source: 'ChangeApproval', action: row.decision, at: row.decidedAt, byId: row.approverId, words: row.reason }))
      return out
    })
  },
}

const OPERATION: HistorySource = {
  recordType: 'Operation',
  place: async (db, id) => placeOf(await db.operation.findUnique({ where: { id }, select: { companyId: true } })),
  may: (actor, place) => can(actor, 'product.routing.view', { companyId: place.companyId }),
  async lines(db, id) {
    const rows = await db.operationTimeVersion.findMany({ where: { operationId: id }, orderBy: [{ number: 'desc' }, { id: 'desc' }], take: SOURCE_LIMIT, select: { id: true, number: true, status: true, reason: true, proposedById: true, createdAt: true, decidedAt: true, decidedById: true, decisionNote: true } })
    return rows.flatMap((row) => {
      const out: HistoryLine[] = [line({ id: `${row.id}:asked`, source: 'OperationTimeVersion', action: 'REQUESTED', at: row.createdAt, byId: row.proposedById, words: versionWords(row.number, row.reason) })]
      if (row.decidedAt) out.push(line({ id: `${row.id}:decided`, source: 'OperationTimeVersion', action: row.status === 'REJECTED' ? 'REJECTED' : 'APPROVED', at: row.decidedAt, byId: row.decidedById, words: row.decisionNote }))
      return out
    })
  },
}

const NCR: HistorySource = {
  recordType: 'Nonconformance',
  place: async (db, id) => placeOf(await db.nonconformance.findUnique({ where: { id }, select: { companyId: true, siteId: true } })),
  may: onPlace(QUALITY_NCR_VIEW),
  async lines(db, id) {
    const rows = await db.ncrDispositionLine.findMany({ where: { ncrId: id, approvalRequired: true }, orderBy: [{ seq: 'desc' }, { id: 'desc' }], take: SOURCE_LIMIT, select: { id: true, seq: true, note: true, decidedAt: true, decidedById: true, approvedAt: true, approvedById: true } })
    return rows.flatMap((row) => {
      const out: HistoryLine[] = [line({ id: `${row.id}:asked`, source: 'NcrDispositionLine', action: 'REQUESTED', at: row.decidedAt, byId: row.decidedById, words: row.note ? `#${row.seq}: ${row.note}` : `#${row.seq}` })]
      if (row.approvedAt) out.push(line({ id: `${row.id}:decided`, source: 'NcrDispositionLine', action: 'APPROVED', at: row.approvedAt, byId: row.approvedById, words: null }))
      return out
    })
  },
}

const SCAN: HistorySource = {
  recordType: 'OperationScan',
  async place(db, id) {
    const scan = await db.operationScan.findUnique({ where: { id }, select: { siteId: true } })
    if (!scan) return null
    const site = await db.site.findUnique({ where: { id: scan.siteId }, select: { companyId: true } })
    return site ? { companyId: site.companyId, siteId: scan.siteId } : null
  },
  may: onPlace(PRODUCTION_SCRAP_VIEW),
  async lines(db, id) {
    const rows = await db.scrapApproval.findMany({ where: { scanId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: SOURCE_LIMIT, select: { id: true, status: true, decidedAt: true, decidedById: true, reasonCode: true, note: true, createdAt: true, scan: { select: { workerId: true } } } })
    return rows.flatMap((row) => {
      const out: HistoryLine[] = [line({ id: `${row.id}:asked`, source: 'ScrapApproval', action: 'REQUESTED', at: row.createdAt, byId: null, byWorkerId: row.scan.workerId, words: null })]
      if (row.decidedAt && row.status !== 'WAITING') out.push(line({ id: `${row.id}:decided`, source: 'ScrapApproval', action: row.status === 'APPROVED' ? 'APPROVED' : 'REJECTED', at: row.decidedAt, byId: row.decidedById, words: row.note, reasonCode: row.status === 'REFUSED' ? row.reasonCode : null }))
      return out
    })
  },
}

const TIMESHEET: HistorySource = {
  recordType: 'TimesheetApproval',
  place: async (db, id) => placeOf(await db.timesheetApproval.findUnique({ where: { id }, select: { companyId: true } })),
  may: (actor, place) => can(actor, PEOPLE_TIMESHEETS_HR, { companyId: place.companyId }) || can(actor, PEOPLE_TIMESHEETS_TEAM, { companyId: place.companyId }),
  async lines(db, id) {
    const row = await db.timesheetApproval.findUnique({ where: { id }, select: { id: true, leadApprovedAt: true, leadApprovedById: true, hrApprovedAt: true, hrApprovedById: true, returnedAt: true, returnedById: true, returnReason: true } })
    if (!row) return []
    const out: HistoryLine[] = []
    if (row.leadApprovedAt) out.push(line({ id: `${row.id}:lead`, source: 'TimesheetApproval', action: 'APPROVED', at: row.leadApprovedAt, byId: row.leadApprovedById, words: null, meaning: 'REVIEWED' }))
    if (row.hrApprovedAt) out.push(line({ id: `${row.id}:hr`, source: 'TimesheetApproval', action: 'APPROVED', at: row.hrApprovedAt, byId: row.hrApprovedById, words: null, meaning: 'APPROVED' }))
    if (row.returnedAt) out.push(line({ id: `${row.id}:returned`, source: 'TimesheetApproval', action: 'REJECTED', at: row.returnedAt, byId: row.returnedById, words: row.returnReason }))
    return out
  },
}

const INSPECTION_PLAN: HistorySource = {
  recordType: 'InspectionPlan',
  place: async (db, id) => placeOf(await db.inspectionPlan.findUnique({ where: { id }, select: { companyId: true } })),
  may: onPlace(QUALITY_PLANS_VIEW),
  async lines(db, id) {
    const rows = await db.inspectionPlanVersion.findMany({ where: { planId: id }, orderBy: [{ number: 'desc' }, { id: 'desc' }], take: SOURCE_LIMIT, select: { id: true, number: true, changeNote: true, authorId: true, createdAt: true, approvedAt: true, approvedById: true } })
    return rows.flatMap((row) => {
      const out: HistoryLine[] = [line({ id: `${row.id}:asked`, source: 'InspectionPlanVersion', action: 'REQUESTED', at: row.createdAt, byId: row.authorId, words: versionWords(row.number, row.changeNote) })]
      if (row.approvedAt) out.push(line({ id: `${row.id}:decided`, source: 'InspectionPlanVersion', action: 'SIGNED', at: row.approvedAt, byId: row.approvedById, words: null, meaning: 'APPROVED' }))
      return out
    })
  },
}

const WORK_INSTRUCTION: HistorySource = {
  recordType: 'WorkInstruction',
  place: async (db, id) => placeOf(await db.workInstruction.findUnique({ where: { id }, select: { companyId: true } })),
  may: onPlace(PRODUCTION_INSTRUCTIONS_VIEW),
  async lines(db, id) {
    const rows = await db.workInstructionVersion.findMany({ where: { instructionId: id }, orderBy: [{ number: 'desc' }, { id: 'desc' }], take: SOURCE_LIMIT, select: { id: true, number: true, changeNote: true, authorId: true, createdAt: true, approvedById: true, publishedAt: true } })
    return rows.flatMap((row) => {
      const out: HistoryLine[] = [line({ id: `${row.id}:asked`, source: 'WorkInstructionVersion', action: 'REQUESTED', at: row.createdAt, byId: row.authorId, words: versionWords(row.number, row.changeNote) })]
      if (row.publishedAt && row.approvedById) out.push(line({ id: `${row.id}:decided`, source: 'WorkInstructionVersion', action: 'APPROVED', at: row.publishedAt, byId: row.approvedById, words: null, meaning: 'RELEASED' }))
      return out
    })
  },
}

// B-W2b-403 (FIN-142): a supplier invoice's and a payment proposal's dual approval are the engine's own lines (no table of
// their own): the first yes a REQUESTED line, the second an APPROVED one.
const SUPPLIER_INVOICE: HistorySource = {
  recordType: 'SupplierInvoice',
  place: async (db, id) => placeOf(await db.supplierInvoice.findUnique({ where: { id }, select: { companyId: true, partyId: true } })),
  may: onPlace(PAYABLES_VIEW),
}
const PAYMENT_PROPOSAL: HistorySource = {
  recordType: 'PaymentProposal',
  place: async (db, id) => placeOf(await db.paymentProposal.findUnique({ where: { id }, select: { companyId: true } })),
  may: onPlace(PAYABLES_VIEW),
}

export const DOMAIN_SOURCES: readonly HistorySource[] = Object.freeze([QUOTE, CHANGE_ORDER, OPERATION, NCR, SCAN, TIMESHEET, INSPECTION_PLAN, WORK_INSTRUCTION,
  // B-W2b-403
  SUPPLIER_INVOICE, PAYMENT_PROPOSAL])
