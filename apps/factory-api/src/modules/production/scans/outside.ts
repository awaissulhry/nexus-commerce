import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { outsidePlan, receiptLineClientId, rootReport } from '@nexus/factory-domain/production/scans/outside'
import { scrapReasonColumn, standingKey, standingScans, type DefectLine } from '@nexus/factory-domain/production/scans/rules'
import { PURCHASING_SUBCONTRACT_RECEIVE } from '@nexus/factory-domain/purchasing/subcontracting/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { holdOnScan } from '../../quality/holds/checks'
import { bundleFlowOf } from '../bundles/flow'
import { lockBundleForScan } from '../bundles/store'
import { officeOf } from './access'
import { readDefects, writeDefects } from './defects-store'
import { scanEvent } from './scans'
import { lockBundleScans, readBundleScans, readHeader, readOperations, readScan, scanWorkOrderLock } from './store'

/**
 * The outside operation reported at receive back (B-W2b-10; the follow-up of B-W2a-25 and B-W2a-76: "receiving bundles
 * back from a subcontractor does not post the scan at the outside operation"): factory-domain production/scans/outside.ts
 * decides, this writes. Called INSIDE the receive command (modules/purchasing/subcontracting receive-back.ts) once the
 * receipt's lines exist, and by the office's "Report at the operation" for a line that could not be reported then.
 *
 *   who      the REPORT names the receipt line (OperationScan.subcontractReceiptLineId) and no worker, station or device:
 *            the workshop did the work; the line's receipt and order say which workshop and where. The person who
 *            received is the scan's createdById (the office user; null for the floor's kit task, which runs as the
 *            tenant's system caller and whose receipt audit row names the tablet and its worker).
 *   locks    as every scan write (store.ts): the work order's issue lock SHARED → the bundle FOR SHARE → the bundle's scan
 *            lock → the hold checks (quality/holds holdOnScan: a hold is said in words, never a failed receipt) → the
 *            trigger's own lock per bundle and operation.
 *   lines    the scrap and rework lines are written where the receipt line's reason is an active code of that kind's list
 *            (the defect trigger's rule); otherwise the scan's counts stand without a line.
 *   costs    the scan posts no labour (costing/actual post.ts leaves a receipt line's scan out: the workshop's fee is the
 *            SUBCONTRACT entry); its scrap is recorded per material as any scan's.
 */

export interface OutsideLine {
  readonly lineId: string
  readonly receiptSeq: number
  readonly bundleId: string | null
  readonly workOrderOperationId: string
  readonly good: number
  readonly defective: number
  readonly scrapped: number
  readonly reasonCode: string | null
}

export interface OutsideOrder {
  readonly workOrderId: string
  readonly number: string
}

export interface OutsideReport {
  readonly receiptLineId: string
  readonly bundleId: string | null
  readonly bundleCode: string | null
  readonly operation: { readonly id: string; readonly seq: number; readonly code: string; readonly name: string }
  readonly scanId: string | null
  readonly kind: 'REPORT' | 'CORRECTION' | null
  readonly goodQuantity: number
  readonly scrapQuantity: number
  readonly reworkQuantity: number
  readonly words: string | null
}

/** The receipt line's scrap and rework lines: its reason where it is an active code of that kind's list. */
async function defectLinesOf(tools: CommandTools, line: OutsideLine): Promise<DefectLine[]> {
  if (!line.reasonCode) return []
  const codes = await tools.tx.scrapReason.findMany({ where: { code: line.reasonCode, active: true }, select: { kind: true } })
  const kinds = new Set(codes.map((row) => row.kind))
  return [
    ...(line.scrapped > 0 && kinds.has('SCRAP') ? [{ kind: 'SCRAP' as const, reason: line.reasonCode, quantity: line.scrapped }] : []),
    ...(line.defective > 0 && kinds.has('REWORK') ? [{ kind: 'REWORK' as const, reason: line.reasonCode, quantity: line.defective }] : []),
  ]
}

const merged = (a: readonly DefectLine[], b: readonly DefectLine[]): DefectLine[] => {
  const sum = new Map<string, DefectLine>()
  for (const line of [...a, ...b]) {
    const key = `${line.kind}|${line.reason}`
    sum.set(key, { kind: line.kind, reason: line.reason, quantity: (sum.get(key)?.quantity ?? 0) + line.quantity })
  }
  return [...sum.values()].sort((x, y) => (x.kind === y.kind ? x.reason.localeCompare(y.reason) : x.kind === 'SCRAP' ? -1 : 1))
}

/** Reports each receipt line at its outside operation inside the caller's command (one after another, in line order). */
export async function reportOutsideInCommand(tools: CommandTools, order: OutsideOrder, lines: readonly OutsideLine[]): Promise<OutsideReport[]> {
  const { tx, context } = tools
  if (context.audience !== 'office' && context.audience !== 'system') throw new ConflictError('An outside operation is reported by the office or the system, never a floor session.')
  const tenantId = context.tenantId!
  const person = context.audience === 'office' ? context.actorId : null
  const operations = await readOperations(tx, order.workOrderId)
  const reports: OutsideReport[] = []
  let locked = false
  for (const line of lines) {
    const operation = operations.find((row) => row.id === line.workOrderOperationId)!
    const ref = { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name }
    const none = (words: string, bundleCode: string | null = null): OutsideReport => ({ receiptLineId: line.lineId, bundleId: line.bundleId, bundleCode, operation: ref, scanId: null, kind: null, goodQuantity: 0, scrapQuantity: 0, reworkQuantity: 0, words })
    if (!line.bundleId) {
      reports.push(none(planWords(outsidePlan({ line, bundle: null, workOrder: { number: '', status: 'IN_PROGRESS' }, operation, standing: null, held: null, byPerson: person !== null }))))
      continue
    }
    if (!locked) {
      await scanWorkOrderLock(tx, tenantId, order.workOrderId)
      locked = true
    }
    const bundle = await lockBundleForScan(tx, line.bundleId)
    if (!bundle) throw new NotFoundError('Bundle not found.')
    await lockBundleScans(tx, tenantId, bundle.bundle.siteId, bundle.bundle.id)
    const hold = await holdOnScan(tx, context, { bundleId: bundle.bundle.id, workOrderId: order.workOrderId })
    const workOrder = (await readHeader(tx, order.workOrderId))!
    const scans = await readBundleScans(tx, bundle.bundle.id)
    const own = standingScans(scans)
    const flow = await bundleFlowOf(tx, bundle.bundle, operations, own)
    const standing = own.get(standingKey(bundle.bundle.id, operation.id)) ?? null
    const plan = outsidePlan({
      line,
      bundle: { code: bundle.bundle.code, status: bundle.bundle.status as 'ACTIVE' | 'VOID', live: flow.quantity },
      workOrder: { number: workOrder.number, status: workOrder.status },
      operation,
      standing: standing ? { ...standing, fromReceipt: (rootReport(scans, standing.id)?.subcontractReceiptLineId ?? null) !== null } : null,
      // A work order ON_HOLD is said by the plan in its own words; a quality hold here.
      held: hold && hold.holdId ? hold.message : null,
      byPerson: person !== null,
    })
    if (plan.action === 'NONE') {
      reports.push(none(plan.words, bundle.bundle.code))
      continue
    }
    const id = newId()
    const fresh = await defectLinesOf(tools, line)
    const defects = plan.action === 'CORRECTION' ? merged((await readDefects(tx, [plan.correctsId])).get(plan.correctsId) ?? [], fresh) : fresh
    await tx.operationScan.create({
      data: {
        id,
        siteId: workOrder.siteId,
        workOrderId: workOrder.id,
        workOrderOperationId: operation.id,
        bundleId: bundle.bundle.id,
        kind: plan.action,
        correctsId: plan.action === 'CORRECTION' ? plan.correctsId : null,
        goodQuantity: plan.counts.good,
        scrapQuantity: plan.counts.scrap,
        reworkQuantity: plan.counts.rework,
        scrapReason: scrapReasonColumn(defects),
        reason: plan.action === 'CORRECTION' ? `Receipt ${line.receiptSeq} of subcontract order ${order.number}: ${plan.added} more garment(s) back from the workshop.` : null,
        approvedById: plan.action === 'CORRECTION' ? person : null,
        workerId: null,
        stationId: null,
        deviceId: null,
        subcontractReceiptLineId: plan.action === 'REPORT' ? line.lineId : null,
        clientScanId: receiptLineClientId(line.lineId),
        deviceTime: null,
        serverTime: tools.now,
        createdById: person,
      },
      select: { id: true },
    })
    await writeDefects(tools, { scanId: id, siteId: workOrder.siteId, createdById: person }, defects)
    const row = (await readScan(tx, id))!
    tools.audit({
      action: 'production.reportOutsideOperation',
      recordType: 'OperationScan',
      recordId: id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      after: { kind: plan.action, subcontractReceiptLineId: line.lineId, correctsId: row.correctsId, goodQuantity: row.goodQuantity, scrapQuantity: row.scrapQuantity, reworkQuantity: row.reworkQuantity },
    })
    tools.emit(scanEvent(workOrder, row, operation.seq, person ? 'OFFICE' : 'SYSTEM'))
    reports.push({ receiptLineId: line.lineId, bundleId: bundle.bundle.id, bundleCode: bundle.bundle.code, operation: ref, scanId: id, kind: plan.action, goodQuantity: row.goodQuantity, scrapQuantity: row.scrapQuantity, reworkQuantity: row.reworkQuantity, words: null })
  }
  return reports
}

const planWords = (plan: ReturnType<typeof outsidePlan>): string => (plan.action === 'NONE' ? plan.words : '')

/** The receipt line with its receipt's order (read in the caller's scope; null: not found). */
async function readReceiptLine(caller: CommandCaller, lineId: string) {
  return caller.withClient(async (db) => {
    const line = await db.subcontractReceiptLine.findUnique({
      where: { id: lineId },
      select: { id: true, seq: true, bundleId: true, goodQuantity: true, defectiveQuantity: true, scrappedQuantity: true, reasonCode: true, subcontractOperationId: true, receiptId: true, workOrderId: true },
    })
    if (!line) return null
    const receipt = await db.subcontractReceipt.findUnique({ where: { id: line.receiptId }, select: { seq: true, subcontractOrderId: true } })
    const operation = await db.subcontractOperation.findUnique({ where: { id: line.subcontractOperationId }, select: { workOrderOperationId: true } })
    const order = receipt ? await db.subcontractOrder.findUnique({ where: { id: receipt.subcontractOrderId }, select: { id: true, number: true, companyId: true, siteId: true, workOrderId: true } }) : null
    if (!receipt || !operation || !order) return null
    return { line, receipt, operation, order }
  })
}

/**
 * POST /production/scans/receipt-lines/:lineId/report (office; purchasing.subcontract.receive over the order): the outside
 * operation of one receipt line, reported now (a line received while its work order was on hold, a quality hold stood,
 * or the floor's kit task could not add a later receipt to an earlier one). 409 in words when it is reported already
 * or still cannot be.
 */
export async function reportReceiptLine(caller: CommandCaller, lineId: string, idempotencyKey?: string): Promise<{ report: OutsideReport; replayed: boolean }> {
  const context = officeOf(caller)
  const found = await readReceiptLine(caller, lineId)
  if (!found || !can(actorOf(context), PURCHASING_SUBCONTRACT_RECEIVE, { companyId: found.order.companyId, siteId: found.order.siteId })) throw new NotFoundError('Receipt line not found.')
  const { result, replayed } = await command(caller, { name: 'production.reportReceiptLine', idempotencyKey, input: { lineId } }, async (tools) => {
    // One report of a line at a time (a second one waits, then finds the first).
    await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.receipt-line-report', ${context.tenantId}::uuid, ${lineId}::uuid), 0))`
    const already = await tools.tx.operationScan.findFirst({ where: { workOrderId: found.order.workOrderId, clientScanId: receiptLineClientId(lineId), deviceId: null }, select: { id: true } })
    if (already) throw new ConflictError('This receipt line is reported at its operation already.')
    const [report] = await reportOutsideInCommand(tools, { workOrderId: found.order.workOrderId, number: found.order.number }, [
      {
        lineId,
        receiptSeq: found.receipt.seq,
        bundleId: found.line.bundleId,
        workOrderOperationId: found.operation.workOrderOperationId,
        good: found.line.goodQuantity,
        defective: found.line.defectiveQuantity,
        scrapped: found.line.scrappedQuantity,
        reasonCode: found.line.reasonCode,
      },
    ])
    if (!report!.scanId) throw new ConflictError(report!.words ?? 'This receipt line cannot be reported now.')
    return report!
  })
  return { report: result, replayed }
}

