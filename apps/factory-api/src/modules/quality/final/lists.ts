import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { inspectionLabel, type InspectionStatus } from '@nexus/factory-domain/quality/final/rules'
import { inspectionHold } from '@nexus/factory-domain/quality/release/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeOf } from './access'
import { INSPECTION_COLUMNS, type InspectionRow } from './store'

/**
 * The Inspections list (B-W1-45; A2 SCR-075; design quality.inspections qi-grid; Owner answer Q3 (a): goods on hold are
 * reached from here before the Holds page of W2a): newest first, within the caller's companies and sites; `onHold`
 * keeps the inspections through which a work order's garments are on hold (its newest decided inspection FAILED, or its
 * released garments were taken back since), `waitingRelease` the four-eyes queue (PASSED with garments still to release).
 */

export interface InspectionQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly status?: InspectionStatus | undefined
  readonly onHold?: boolean | undefined
  readonly waitingRelease?: boolean | undefined
  readonly limit: number
}

export async function listInspections(caller: CommandCaller, query: InspectionQuery) {
  const context = officeOf(caller)
  const scope = scopeWhere(actorOf(context), QUALITY_INSPECTIONS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.InspectionWhereInput
  const filter: Prisma.InspectionWhereInput = {
    ...(query.companyId ? { companyId: query.companyId } : {}),
    ...(query.siteId ? { siteId: query.siteId } : {}),
    ...(query.workOrderId ? { workOrderId: query.workOrderId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.onHold ? { status: { in: ['PASSED', 'FAILED'] } } : {}),
    ...(query.waitingRelease ? { status: 'PASSED' } : {}),
  }
  const filtered = Boolean(query.onHold || query.waitingRelease)
  return caller.withClient(async (db) => {
    const rows = await db.inspection.findMany({ where: { AND: [scope, filter] }, select: INSPECTION_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: filtered ? 1000 : query.limit })
    const orderIds = [...new Set(rows.map((row) => row.workOrderId))]
    const numbers = new Map((await db.workOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
    // Each work order's inspections (their place, and the newest decided one).
    const siblings = new Map<string, Pick<InspectionRow, 'id' | 'status' | 'decidedAt' | 'createdAt'>[]>()
    for (const row of await db.inspection.findMany({ where: { workOrderId: { in: orderIds } }, select: { id: true, workOrderId: true, status: true, decidedAt: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) {
      siblings.set(row.workOrderId, [...(siblings.get(row.workOrderId) ?? []), row])
    }
    const releases = await db.qualityRelease.findMany({ where: { inspectionId: { in: rows.map((row) => row.id) } }, select: { id: true, inspectionId: true, quantity: true } })
    const reversals = releases.length ? await db.qualityReleaseReversal.groupBy({ by: ['releaseId'], where: { releaseId: { in: releases.map((release) => release.id) } }, _sum: { quantity: true } }) : []
    const reversedOf = new Map(reversals.map((row) => [row.releaseId, row._sum.quantity ?? 0]))
    const out = []
    for (const row of rows) {
      const list = siblings.get(row.workOrderId) ?? []
      const decided = list.filter((entry) => entry.status === 'PASSED' || entry.status === 'FAILED').sort((a, b) => (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0))
      const own = releases.filter((release) => release.inspectionId === row.id)
      const released = own.reduce((sum, release) => sum + release.quantity, 0)
      const reversed = own.reduce((sum, release) => sum + (reversedOf.get(release.id) ?? 0), 0)
      const hold = inspectionHold({ status: row.status, reversed, newestDecided: decided.at(-1)?.id === row.id })
      const toRelease = row.status === 'PASSED' ? Math.max(0, row.lotSize - released) : 0
      if (query.onHold && !hold.onHold) continue
      if (query.waitingRelease && (toRelease === 0 || hold.onHold)) continue
      out.push({
        id: row.id,
        label: inspectionLabel(numbers.get(row.workOrderId) ?? '', list.findIndex((entry) => entry.id === row.id) + 1),
        workOrderId: row.workOrderId,
        number: numbers.get(row.workOrderId) ?? '',
        companyId: row.companyId,
        siteId: row.siteId,
        status: row.status,
        lotSize: row.lotSize,
        sampleSize: row.sampleSize,
        computedResult: row.computedResult,
        overridden: row.overrideReason !== null,
        inspector: { kind: row.inspectorWorkerId ? ('FLOOR' as const) : ('OFFICE' as const), workerId: row.inspectorWorkerId, userId: row.inspectorUserId },
        released,
        reversed,
        toRelease,
        onHold: hold.onHold,
        holdWords: hold.words,
        decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
        createdAt: toUtcIso(row.createdAt),
      })
      if (out.length >= query.limit) break
    }
    return { inspections: out }
  })
}
