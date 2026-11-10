import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { batchEvidence, retentionState, testPlan, type BatchEvidence, type Frequency, type TestFacts, type TestKind, type TestResult } from '@nexus/factory-domain/compliance/techfiles/rules'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { actorOf } from '../../../core/context'
import { dayOf, officeOf, techfilesClock, todayOf, type Reader } from './common'
import { readFile } from './store'

/**
 * Conformity to type per batch (B-W2b-251; PRD-302, QHS-048; design compliance.techfiles › Production control): per work order
 * of the style (made in series or to measure; drafts, cancelled runs, samples and repairs left out), its in-process checks
 * (counts only, never who), the production-control tests of its batch, the final inspection and the releases, and the state
 * of its evidence (factory-domain batchEvidence); and the plan of periodic tests (what, how often, next due).
 *
 *   GET /compliance/techfiles/:fileId/production?limit=   compliance.certificates.view over the file's company
 */

export const TEST_SELECT = {
  id: true,
  companyId: true,
  styleId: true,
  siteId: true,
  workOrderId: true,
  batchNumber: true,
  test: true,
  testName: true,
  standardClause: true,
  frequency: true,
  dueOn: true,
  sample: true,
  result: true,
  testedOn: true,
  testedBy: true,
  labReportFileId: true,
  reportNumber: true,
  resultNote: true,
  retainUntil: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  workOrder: { select: { number: true, batchNumber: true } },
  labReportFile: { select: { originalName: true, sha256: true } },
} as const satisfies Prisma.ProductionControlTestSelect
export type TestRow = Prisma.ProductionControlTestGetPayload<{ select: typeof TEST_SELECT }>

export function testView(row: TestRow, today = todayOf()) {
  const retainUntil = dayOf(row.retainUntil)
  return {
    id: row.id,
    companyId: row.companyId,
    styleId: row.styleId,
    workOrder: row.workOrderId && row.workOrder ? { id: row.workOrderId, number: row.workOrder.number } : null,
    batchNumber: row.batchNumber ?? row.workOrder?.batchNumber ?? null,
    test: row.test as TestKind,
    testName: row.testName,
    standardClause: row.standardClause,
    frequency: row.frequency as Frequency,
    dueOn: dayOf(row.dueOn)!,
    sample: row.sample,
    result: row.result as TestResult | null,
    testedOn: dayOf(row.testedOn),
    testedBy: row.testedBy,
    reportNumber: row.reportNumber,
    resultNote: row.resultNote,
    labReportFile: row.labReportFileId && row.labReportFile ? { id: row.labReportFileId, name: row.labReportFile.originalName, sha256: row.labReportFile.sha256 } : null,
    retainUntil,
    retention: retentionState(retainUntil, today),
    overdue: row.result === null && dayOf(row.dueOn)! < today,
    note: row.note,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}
export type TestView = ReturnType<typeof testView>

export const testFactsOf = (row: TestRow): TestFacts => ({
  id: row.id,
  test: row.test as TestKind,
  testName: row.testName,
  frequency: row.frequency as Frequency,
  dueOn: dayOf(row.dueOn)!,
  result: row.result as TestResult | null,
  testedOn: dayOf(row.testedOn),
  workOrderId: row.workOrderId,
  batchNumber: row.batchNumber,
})

const PRODUCTION_KINDS = ['SIZE_GRID', 'MADE_TO_MEASURE'] as const
const FAILED_OUTCOMES = new Set(['REJECTED', 'FAIL', 'RED'])

export interface BatchRow {
  readonly workOrder: { readonly id: string; readonly number: string; readonly batchNumber: string | null; readonly status: string; readonly siteId: string; readonly releasedAt: string | null; readonly completedAt: string | null }
  readonly done: boolean
  readonly inProcess: { readonly decided: number; readonly failed: number; readonly open: number }
  readonly tests: readonly { readonly id: string; readonly test: TestKind; readonly testName: string | null; readonly result: TestResult | null; readonly testedOn: string | null; readonly dueOn: string }[]
  readonly finalInspection: { readonly id: string; readonly number: string | null; readonly status: string; readonly decidedAt: string | null } | null
  readonly releases: { readonly count: number; readonly quantity: number; readonly lastAt: string | null }
  readonly evidence: BatchEvidence
}

/** The style's batches (newest first, at most `limit` per style) with their evidence, and every test of the styles. */
export async function batchesOf(db: Reader, styleIds: readonly string[], limit = 500): Promise<{ readonly batches: Map<string, BatchRow[]>; readonly tests: Map<string, TestRow[]> }> {
  const batches = new Map<string, BatchRow[]>()
  const tests = new Map<string, TestRow[]>()
  if (styleIds.length === 0) return { batches, tests }
  const testRows = await db.productionControlTest.findMany({ where: { styleId: { in: [...styleIds] } }, select: TEST_SELECT, orderBy: [{ dueOn: 'desc' }, { id: 'desc' }] })
  for (const row of testRows) tests.set(row.styleId, [...(tests.get(row.styleId) ?? []), row])
  const orders = await db.workOrder.findMany({
    where: { styleId: { in: [...styleIds] }, kind: { in: [...PRODUCTION_KINDS] }, status: { notIn: ['DRAFT', 'CANCELLED'] } },
    select: { id: true, number: true, batchNumber: true, status: true, siteId: true, styleId: true, releasedAt: true, completedAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  const kept = styleIds.flatMap((styleId) => orders.filter((order) => order.styleId === styleId).slice(0, limit))
  const ids = kept.map((order) => order.id)
  if (ids.length === 0) return { batches, tests }
  const inspections = await db.inspection.findMany({ where: { workOrderId: { in: ids }, status: { not: 'CANCELLED' } }, select: { id: true, number: true, status: true, workOrderId: true, decidedAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const releases = await db.qualityRelease.findMany({ where: { workOrderId: { in: ids } }, select: { workOrderId: true, quantity: true, releasedAt: true } })
  const checks = await db.inProcessCheck.findMany({ where: { workOrderId: { in: ids } }, select: { workOrderId: true, status: true, outcome: true } })
  for (const order of kept) {
    const own = inspections.filter((row) => row.workOrderId === order.id)
    const released = releases.filter((row) => row.workOrderId === order.id)
    const checked = checks.filter((row) => row.workOrderId === order.id)
    const styleTests = tests.get(order.styleId) ?? []
    const batchTests = styleTests.filter((row) => row.workOrderId === order.id || (row.workOrderId === null && order.batchNumber !== null && row.batchNumber === order.batchNumber))
    const required = new Map<string, { test: TestKind; testName: string | null }>()
    for (const row of styleTests) if (row.frequency === 'EVERY_BATCH') required.set(`${row.test}|${(row.testName ?? '').trim().toLowerCase()}`, { test: row.test as TestKind, testName: row.testName })
    const recorded = batchTests
      .filter((row) => row.result !== null && row.testedOn !== null)
      .sort((a, b) => b.testedOn!.getTime() - a.testedOn!.getTime() || (a.id < b.id ? 1 : -1))
      .map((row) => ({ test: row.test as TestKind, testName: row.testName, result: row.result as TestResult }))
    const done = order.status === 'COMPLETED' || order.status === 'CLOSED' || released.length > 0
    const newest = own[0] ?? null
    const evidence = batchEvidence({ done, finalStatus: newest?.status ?? null, passedInspections: own.filter((row) => row.status === 'PASSED').length, releases: released.length, required: [...required.values()], recorded })
    const lastRelease = released.reduce<Date | null>((latest, row) => (latest === null || row.releasedAt > latest ? row.releasedAt : latest), null)
    const row: BatchRow = {
      workOrder: { id: order.id, number: order.number, batchNumber: order.batchNumber, status: order.status, siteId: order.siteId, releasedAt: order.releasedAt ? toUtcIso(order.releasedAt) : null, completedAt: order.completedAt ? toUtcIso(order.completedAt) : null },
      done,
      inProcess: { decided: checked.filter((check) => check.status === 'DECIDED').length, failed: checked.filter((check) => check.outcome !== null && FAILED_OUTCOMES.has(check.outcome)).length, open: checked.filter((check) => check.status === 'OPEN').length },
      tests: batchTests.map((test) => ({ id: test.id, test: test.test as TestKind, testName: test.testName, result: test.result as TestResult | null, testedOn: dayOf(test.testedOn), dueOn: dayOf(test.dueOn)! })),
      finalInspection: newest ? { id: newest.id, number: newest.number, status: newest.status, decidedAt: newest.decidedAt ? toUtcIso(newest.decidedAt) : null } : null,
      releases: { count: released.length, quantity: released.reduce((sum, entry) => sum + entry.quantity, 0), lastAt: lastRelease ? toUtcIso(lastRelease) : null },
      evidence,
    }
    batches.set(order.styleId, [...(batches.get(order.styleId) ?? []), row])
  }
  return { batches, tests }
}

/** The list's and the tile's numbers: done batches, how many with their evidence complete, missing, failed, running. */
export function productionSummary(rows: readonly BatchRow[]) {
  return {
    made: rows.filter((row) => row.done).length,
    withEvidence: rows.filter((row) => row.evidence.state === 'COMPLETE').length,
    missing: rows.filter((row) => row.evidence.state === 'MISSING').length,
    failed: rows.filter((row) => row.evidence.state === 'FAILED').length,
    inProgress: rows.filter((row) => row.evidence.state === 'IN_PROGRESS').length,
  }
}

/** GET /compliance/techfiles/:fileId/production */
export async function productionOf(request: FastifyRequest, fileId: string, query: { readonly limit?: number | undefined }) {
  const actor = actorOf(officeOf(request))
  const now = techfilesClock().now()
  const today = todayOf(now)
  return request.withClient(async (db) => {
    const file = await readFile(db, actor, fileId)
    const { batches, tests } = await batchesOf(db, [file.styleId], query.limit ?? 50)
    const rows = batches.get(file.styleId) ?? []
    const styleTests = tests.get(file.styleId) ?? []
    return {
      technicalFileId: file.id,
      styleId: file.styleId,
      batches: rows.map((row) => ({ ...row, tests: [...row.tests], evidence: { state: row.evidence.state, missing: [...row.evidence.missing], failed: [...row.evidence.failed] } })),
      summary: productionSummary(rows),
      plan: testPlan(styleTests.map(testFactsOf), today),
      tests: styleTests.map((row) => testView(row, today)),
      asOf: toUtcIso(now),
    }
  })
}
