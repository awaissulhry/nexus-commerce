import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { samplingPlan } from '@nexus/factory-domain/quality/aql/sampling'
import { levelOf } from '@nexus/factory-domain/quality/aql/sampling'
import { QUALITY_INPROCESS_VIEW } from '@nexus/factory-domain/quality/inprocess/permissions'
import { dhuOf, firstPieceHold, KIND_WORDS, OUTCOME_WORDS, rovingColourOf, STATUS_WORDS } from '@nexus/factory-domain/quality/inprocess/rules'
import type { CommandCaller } from '../../../core/command'
import { workerGateFor, type WorkerGate, workerGate } from '../../people/privacy/worker-gate'
import { contentOfCheck, readChecks } from '../plans/store'
import { checkerOf, mayOn, type Checker } from './access'
import { firstPieceRows, kindOf, outcomeOf, readCheck, readResults, statusOf, type CheckRow, type Reader } from './store'

/**
 * How a check reads (B-W2b-99). A LIST row is per line and operation: no inspector, no operator, no person. ONE record names
 * its inspector and its operator only through modules/people/privacy/worker-gate.ts (Statuto art. 4 c.1): the office sees a
 * worker where the site's PERFORMANCE gate is in force, else `workerHidden`; a floor device sees whether it is its own, never
 * another worker's id. Words in Italian and English beside every code.
 */

const ref = <Row extends { readonly id: string }, Out extends object>(row: Row | null | undefined, pick: (row: Row) => Out): (Out & { readonly id: string }) | null => (row ? { ...pick(row), id: row.id } : null)

/** Lookups for rows: lines, work orders, bundles, operations, defects, plan versions (one query each). */
export async function lookupsOf(db: Reader, rows: readonly CheckRow[]) {
  const ids = (pick: (row: CheckRow) => string | null) => [...new Set(rows.map(pick).filter((id): id is string => id !== null))]
  const [lines, orders, bundles, operations, defects, versions] = await Promise.all([
    db.line.findMany({ where: { id: { in: ids((row) => row.lineId) } }, select: { id: true, code: true, name: true } }),
    db.workOrder.findMany({ where: { id: { in: ids((row) => row.workOrderId) } }, select: { id: true, number: true, status: true } }),
    db.bundle.findMany({ where: { id: { in: ids((row) => row.bundleId) } }, select: { id: true, code: true, quantity: true } }),
    db.workOrderOperation.findMany({ where: { id: { in: ids((row) => row.workOrderOperationId) } }, select: { id: true, seq: true, code: true, name: true } }),
    db.defectCode.findMany({ where: { id: { in: ids((row) => row.defectCodeId) } }, select: { id: true, code: true, labelIt: true, labelEn: true, severity: true } }),
    db.inspectionPlanVersion.findMany({ where: { id: { in: ids((row) => row.planVersionId) } }, select: { id: true, number: true, planId: true, plan: { select: { code: true, name: true } } } }),
  ])
  const map = <Row extends { readonly id: string }>(list: readonly Row[]) => new Map(list.map((row) => [row.id, row]))
  return { lines: map(lines), orders: map(orders), bundles: map(bundles), operations: map(operations), defects: map(defects), versions: map(versions) }
}
export type Lookups = Awaited<ReturnType<typeof lookupsOf>>

/** One row of a list: per line and operation, no person. */
export function checkRowOf(row: CheckRow, look: Lookups) {
  const kind = kindOf(row)
  const outcome = outcomeOf(row)
  const defect = row.defectCodeId ? look.defects.get(row.defectCodeId) : null
  return {
    id: row.id,
    kind,
    kindWords: KIND_WORDS[kind],
    status: statusOf(row),
    statusWords: STATUS_WORDS[statusOf(row)],
    outcome,
    outcomeWords: outcome ? OUTCOME_WORDS[outcome] : null,
    siteId: row.siteId,
    companyId: row.companyId,
    line: ref(row.lineId ? look.lines.get(row.lineId) : null, (line) => ({ code: line.code, name: line.name })),
    workOrder: ref(row.workOrderId ? look.orders.get(row.workOrderId) : null, (order) => ({ number: order.number })),
    bundle: ref(row.bundleId ? look.bundles.get(row.bundleId) : null, (bundle) => ({ code: bundle.code, quantity: bundle.quantity })),
    operation: ref(row.workOrderOperationId ? look.operations.get(row.workOrderOperationId) : null, (operation) => ({ seq: operation.seq, code: operation.code, name: operation.name })),
    pieces: row.pieces,
    defectivePieces: row.defectivePieces,
    defects: row.defects,
    dhu: row.status === 'DECIDED' ? dhuOf(row.defects, row.pieces) : null,
    defect: defect ? { id: defect.id, code: defect.code, labelIt: defect.labelIt, labelEn: defect.labelEn, critical: defect.severity === 'CRITICAL' } : null,
    hasPlan: row.planVersionId !== null,
    decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
    createdAt: toUtcIso(row.createdAt),
    version: row.version,
  }
}

/** The gate for one record: the office reads the site's gate; a floor device never names another worker. */
async function gateOf(caller: CommandCaller, context: Checker, siteId: string): Promise<WorkerGate | null> {
  if (context.audience === 'floor') return null
  return caller.withClient((db) => workerGateFor(db, siteId))
}

/** One check as its record shows it: the row, its plan's checks and results, the sample, the hold, the people behind the gate. */
export async function checkViewOf(caller: CommandCaller, checkId: string) {
  const context = checkerOf(caller)
  const row = await caller.withClient((db) => readCheck(db, checkId))
  if (!row || !mayOn(context, QUALITY_INPROCESS_VIEW, row)) {
    // The writer may hold `record` alone (a floor role holds both; an office custom role may not).
    if (!row || !mayOn(context, 'quality.inprocess.record', row)) throw new NotFoundError('Check not found.')
  }
  const gate = (await gateOf(caller, context, row.siteId)) ?? workerGate(false)
  return caller.withClient(async (db) => {
    const look = await lookupsOf(db, [row])
    const base = checkRowOf(row, look)
    const version = row.planVersionId ? look.versions.get(row.planVersionId) : null
    const checks = row.planVersionId ? (await readChecks(db, [row.planVersionId])).map((check) => ({ id: check.id, ...contentOfCheck(check) })) : []
    const results = await readResults(db, row.id)
    const codeOf = new Map(checks.map((check) => [check.id, check]))
    const profile = row.aqlProfileId ? await db.aqlProfile.findUnique({ where: { id: row.aqlProfileId }, select: { id: true, code: true, inspectionLevel: true, aqlMajor: true, aqlMinor: true } }) : null
    const lot = base.bundle?.quantity ?? null
    const level = profile ? levelOf(profile.inspectionLevel) : null
    const plan = profile && level && lot ? samplingPlan({ lotSize: lot, level, aqlMajor: profile.aqlMajor.toString(), aqlMinor: profile.aqlMinor.toString() }) : null
    let holdsRun: boolean | null = null
    if (row.kind === 'FIRST_PIECE') holdsRun = firstPieceHold(await firstPieceRows(db, row.workOrderId!), { bundleId: '', workOrderOperationId: row.workOrderOperationId }).held
    const names = gate.open ? new Map((await db.worker.findMany({ where: { id: { in: gate.lookup([row.workerId, row.inspectorWorkerId]) } }, select: { id: true, displayName: true } })).map((worker) => [worker.id, worker.displayName])) : new Map<string, string>()
    const own = context.audience === 'floor' && row.inspectorWorkerId === context.actorId
    return {
      ...base,
      plan: version ? { versionId: version.id, planId: version.planId, code: version.plan.code, name: version.plan.name, number: version.number } : null,
      checks: checks.map((check) => ({ id: check.id, code: check.code, labelIt: check.labelIt, labelEn: check.labelEn, labelI18n: check.labelI18n, type: check.type, checkClass: check.checkClass, mandatory: check.mandatory, photoRequired: check.photoRequired, nominal: check.nominal, tolerance: check.tolerance, uom: check.uom, choices: [...check.choices] })),
      results: results.map((result) => ({ id: result.id, code: codeOf.get(result.planCheckId)?.code ?? '?', sampleIndex: result.sampleIndex, outcome: result.outcome as 'PASS' | 'FAIL' | 'NOT_APPLICABLE', value: result.value, note: result.note, recordedAt: toUtcIso(result.recordedAt) })),
      /** Mandatory checks still without a result (a passing outcome waits for them). */
      blockers: checks.filter((check) => check.mandatory && check.type !== 'INSTRUCTION' && !results.some((result) => result.planCheckId === check.id)).map((check) => check.code),
      sample: profile ? { aqlProfileId: profile.id, profileCode: profile.code, codeLetter: row.codeLetter, sampleSize: plan?.sampleSize ?? null, words: plan?.words ?? null } : null,
      /** A roving check: the traffic light the counts give (the inspector says the colour). */
      suggested: row.kind === 'ROVING' && row.status === 'DECIDED' ? rovingColourOf({ defectivePieces: row.defectivePieces, critical: base.defect?.critical ?? false }) : null,
      /** A first piece: whether its run waits now. */
      holdsRun,
      /** An end-of-line defect charged to an operation: what goes back there (the rework loop opens it, POST /production/rework). */
      sendBack: row.kind === 'END_OF_LINE' && row.outcome === 'FAIL' && row.workOrderOperationId && row.bundleId ? { workOrderOperationId: row.workOrderOperationId, bundleId: row.bundleId, pieces: row.defectivePieces } : null,
      inspector: {
        kind: row.inspectorWorkerId ? ('FLOOR' as const) : ('OFFICE' as const),
        workerId: context.audience === 'office' ? gate.id(row.inspectorWorkerId) : null,
        name: context.audience === 'office' ? gate.name(row.inspectorWorkerId, names) : null,
        workerHidden: context.audience === 'office' ? gate.hidden(row.inspectorWorkerId) : row.inspectorWorkerId !== null && !own,
        userId: row.inspectorUserId,
        own,
      },
      /** The operator, only behind the gate (Statuto art. 4): a floor device never sees it. */
      operator: context.audience === 'office' ? gate.person(row.workerId, names) : null,
      operatorHidden: context.audience === 'office' ? gate.hidden(row.workerId) : row.workerId !== null,
      signatureSha256: row.signatureSha256,
      cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
      cancelReason: row.cancelReason,
      note: row.note,
    }
  })
}
