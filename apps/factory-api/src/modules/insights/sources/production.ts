import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { actingPermission, type AttentionCandidate, type Viewer } from '@nexus/factory-domain/insights/attention'
import { heldWorkOrderSeverity } from '@nexus/factory-domain/insights/states'
import { scanCorrectionWords, scanRefusalWords, workOrderHeldWords } from '@nexus/factory-domain/insights/words'
import { PRODUCTION_SCAN_CORRECT } from '@nexus/factory-domain/production/scans/permissions'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { readCorrectionRequests } from '../../production/scans/corrections-store'
import { readRefusals } from '../../production/scans/refusals-store'
import { workerUsers } from '../../production/scans/store'
import { checklistOf, readBasics, readReleaseFacts } from '../../production/work-orders/facts'
import { HEADER } from '../../production/work-orders/store'
import { capped, CHECK_LIMIT, dayOrNull, SOURCE_LIMIT, type Source } from './common'

/**
 * Production (B-W1-38 work orders, B-W1-42 scans): draft work orders the release check holds (THE check of the work
 * orders module, `checklistOf`, run only for drafts the viewer may release), scan corrections waiting for a decision
 * (never shown to the worker who scanned or asked, nor to their office user; the decision itself re-checks every
 * person involved) and refused floor scans still open, at the sites the viewer decides corrections for.
 */

/** WORK_ORDER_HELD: DRAFT work orders whose release check has a BLOCKED check, soonest due first. */
export const workOrderHeld: Source = async ({ caller, viewer }) => {
  const scope = scopeWhere(viewer.actor, WORKORDERS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput
  return caller.withClient(async (db) => {
    const found = await db.workOrder.findMany({ where: { AND: [scope, { status: 'DRAFT' }] }, orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }], take: SOURCE_LIMIT + 1, select: HEADER })
    const { rows, complete } = capped(found, SOURCE_LIMIT)
    // The release check reads much: only for drafts this viewer may release, at most CHECK_LIMIT of them.
    const mine = rows.filter((row) => actingPermission(viewer, { kind: 'WORK_ORDER_HELD', scope: { companyId: row.companyId, siteId: row.siteId, partyId: null } }) !== null)
    const candidates: AttentionCandidate[] = []
    for (const row of mine.slice(0, CHECK_LIMIT)) {
      const basics = await readBasics(db, row)
      // B-W2a-46: W1's material check here (the plan's readiness nets the whole site: too slow for every Today read).
      const checklist = checklistOf(await readReleaseFacts(db, basics, viewer.today, undefined, 'never'), null)
      if (checklist.releasable) continue
      const blocked = checklist.checks.filter((check) => check.state === 'BLOCKED').map((check) => check.code)
      const dueDate = dayOrNull(row.dueDate)
      candidates.push({
        kind: 'WORK_ORDER_HELD',
        state: 'HELD',
        severity: heldWorkOrderSeverity(dueDate, viewer.today),
        record: { type: 'WorkOrder', id: row.id, label: row.number },
        scope: { companyId: row.companyId, siteId: row.siteId, partyId: null },
        ...workOrderHeldWords({ number: row.number, style: basics.style.code, checks: blocked, orders: basics.orders.map((order) => order.number) }),
        due: dueDate,
        since: row.createdAt,
        condition: blocked,
      })
    }
    return { kind: 'WORK_ORDER_HELD', candidates, complete: complete && mine.length <= CHECK_LIMIT }
  })
}

/** The sites whose scan corrections and refusals the viewer looks after (company and site scope). */
async function correctionSites(db: FactoryClient, viewer: Viewer) {
  const where = scopeWhere(viewer.actor, PRODUCTION_SCAN_CORRECT, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput
  return db.site.findMany({ where, select: { id: true, companyId: true } })
}

/** SCAN_CORRECTION: correction requests PENDING at the viewer's sites. */
export const scanCorrection: Source = async ({ caller, viewer }) =>
  caller.withClient(async (db) => {
    const sites = await correctionSites(db, viewer)
    const pending = await readCorrectionRequests(db, { siteIds: sites.map((site) => site.id), status: 'PENDING' })
    const { rows, complete } = capped(pending, SOURCE_LIMIT)
    if (rows.length === 0) return { kind: 'SCAN_CORRECTION', candidates: [], complete }
    const scans = await db.operationScan.findMany({ where: { id: { in: rows.map((row) => row.scanId) } }, select: { id: true, workerId: true, createdById: true } })
    const orders = new Map((await db.workOrder.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.workOrderId))] } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
    const bundles = new Map((await db.bundle.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.bundleId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const operations = new Map(
      (await db.workOrderOperation.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.workOrderOperationId))] } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]),
    )
    const candidates: AttentionCandidate[] = []
    for (const row of rows) {
      const scan = scans.find((entry) => entry.id === row.scanId)
      const involved = [row.askedById, scan?.workerId ?? null, scan?.createdById ?? null].filter((id): id is string => id !== null)
      const notBy = [...new Set([...involved, ...(await workerUsers(db, involved))])]
      const workOrder = orders.get(row.workOrderId) ?? 'the work order'
      candidates.push({
        kind: 'SCAN_CORRECTION',
        state: 'PENDING',
        severity: 'MEDIUM',
        record: { type: 'ScanCorrectionRequest', id: row.id, label: workOrder },
        scope: { companyId: row.companyId, siteId: row.siteId, partyId: null },
        ...scanCorrectionWords({ workOrder, operation: operations.get(row.workOrderOperationId) ?? 'an operation', bundle: bundles.get(row.bundleId) ?? 'a bundle' }),
        due: null,
        since: new Date(row.serverTime),
        notBy,
      })
    }
    return { kind: 'SCAN_CORRECTION', candidates, complete }
  })

/** SCAN_REFUSAL: refused floor scans not discarded nor resolved, at the viewer's sites. */
export const scanRefusal: Source = async ({ caller, viewer }) =>
  caller.withClient(async (db) => {
    const sites = await correctionSites(db, viewer)
    const open = await readRefusals(db, { siteIds: sites.map((site) => site.id), open: true })
    const { rows, complete } = capped(open, SOURCE_LIMIT)
    const companyOf = new Map(sites.map((site) => [site.id, site.companyId]))
    const devices = new Map((await db.device.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.deviceId))] } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]))
    const orderIds = [...new Set(rows.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))]
    const orders = new Map((orderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } }) : []).map((row) => [row.id, row.number]))
    const candidates: AttentionCandidate[] = rows.map((row) => ({
      kind: 'SCAN_REFUSAL',
      state: row.final ? 'FINAL' : 'RETRYABLE',
      severity: 'LOW',
      record: { type: 'FloorScanRefusal', id: row.id, label: row.scanned ?? row.code },
      scope: { companyId: companyOf.get(row.siteId) ?? null, siteId: row.siteId, partyId: null },
      ...scanRefusalWords({ device: devices.get(row.deviceId) ?? 'a floor device', message: row.message, workOrder: row.workOrderId ? (orders.get(row.workOrderId) ?? null) : null }),
      due: null,
      since: new Date(row.serverTime),
    }))
    return { kind: 'SCAN_REFUSAL', candidates, complete }
  })
