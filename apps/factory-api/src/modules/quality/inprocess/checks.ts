import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { chipsMatch } from '@nexus/factory-domain/quality/plans/rules'
import { QUALITY_INPROCESS_RECORD, QUALITY_INPROCESS_VIEW } from '@nexus/factory-domain/quality/inprocess/permissions'
import {
  findingProblems,
  firstPieceHold,
  firstPieceSha256,
  isPassing,
  LIMITS,
  ONE_STEP_KINDS,
  placeProblems,
  reasonProblem,
  resultProblems,
  STAGE_OF_KIND,
  type Finding,
  type InProcessKind,
  type ResultInput,
} from '@nexus/factory-domain/quality/inprocess/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { workerGateFor } from '../../people/privacy/worker-gate'
import { readBundle, readBundleByCode } from '../../production/bundles/store'
import { devicePlaceOf } from '../../production/calls/store'
import { assertFloorReady } from '../../production/serials/facts'
import { customersOf, aqlPlanFor } from '../aql/chain'
import { chipsOf, contentOfCheck, readChecks } from '../plans/store'
// B-W2b-101's work-order lock (`factory.inprocess-check|tenant|<work order>`): a person here and a rule there never open two checks of one run at once.
import { lockWorkOrderChecks } from '../triggers/open'
import { assertOn, checkerOf, postedBy, refuse, signerOf, systemOf, type Checker } from './access'
import { firstPieceRows, kindOf, lockRun, outcomeOf, readCheck, readLine, readOperationsOf, readResults, readWorkOrder, statusOf, type CheckRow, type LineRow, type Reader, type WorkOrderRow } from './store'
import { checkViewOf } from './views'

/**
 * In-process checks (B-W2b-99; QHS-039 first piece, QHS-040 cutting, QHS-041 roving, QHS-042 end of line, MES-127; design
 * floor.inline SCR-176): every write is ONE command() with its audit row and events; the rules and words are factory-domain
 * quality/inprocess; the …_inspection_plans_w2b_guards triggers are the last word.
 *
 *   open      quality.inprocess.record over the work order's (or the line's) company and site, a floor device at its own
 *             site with its floor ready: a first piece (work order + its first bundle, at one operation or all; its run
 *             waits from this moment: the work order's issue lock is taken EXCLUSIVE so scans in flight end first; one open
 *             first piece per run; none once the run is approved), a cutting check (the work order), a roving or an
 *             end-of-line check (a line or a work order: the device's line, else the work order's). Opened OPEN on the
 *             APPROVED version of the plan that applies (the one named, else the most specific of the stage by its chips:
 *             style, category, operation, customer), with the AQL plan of its lot (`aqlPlanFor`, B-W2b-93) when it has a lot.
 *             With `decision` a cutting, roving or end-of-line check is recorded in ONE step (written DECIDED, no plan
 *             unless named: the design's one tap for a pass, three for a defect sent back).
 *   results   PUT the whole list of plan results while OPEN (each a check of the frozen version, once per sampled unit).
 *   decide    the outcome and the counts; on a plan a passing outcome needs every mandatory result and no failed critical
 *             check; a first piece is SIGNED (the floor's PIN or the office's fresh code, asked after every other check)
 *             and its SHA-256 kept: APPROVED lifts its run's hold, REJECTED keeps it.
 *   cancel    an OPEN check abandoned, with why; a first piece cancelled holds nothing.
 *
 * The operator (Statuto art. 4): a roving result, or an end-of-line defect charged to an operation, names the worker who did
 * that operation on that bundle ONLY where the site's PERFORMANCE gate is in force (`workerGateFor`, read in the tenant's
 * system view); then the one-step command runs in the system scope (the floor role writes no operator), the floor's worker
 * kept as the inspector and in the audit row. Elsewhere the check is per operation and names no one.
 */

const invalid = (message: string, problems: readonly Issue[], prefix = 'body') => new ValidationError(message, problems.map((problem) => ({ ...problem, path: `${prefix}/${problem.path}` })))

/** The work order states a check runs in (a first piece: only while the run can start). */
const RUNNING = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
const STARTABLE = ['RELEASED', 'IN_PROGRESS'] as const

export interface DecisionBody {
  readonly outcome: Finding['outcome']
  readonly pieces: number
  readonly defectivePieces?: number | undefined
  readonly defects?: number | undefined
  readonly defectCodeId?: string | null | undefined
}

const findingOf = (body: DecisionBody): Finding => ({ outcome: body.outcome, pieces: body.pieces, defectivePieces: body.defectivePieces ?? 0, defects: body.defects ?? 0, defectCodeId: body.defectCodeId ?? null })

export interface OpenBody {
  readonly kind: InProcessKind
  readonly workOrderId?: string | undefined
  readonly bundleId?: string | undefined
  /** A scanned ticket instead of the bundle's id (the floor). */
  readonly bundleCode?: string | undefined
  readonly workOrderOperationId?: string | undefined
  readonly lineId?: string | undefined
  /** The APPROVED version to run on; null: none; left out: the plan that applies (none for a one-step check). */
  readonly planVersionId?: string | null | undefined
  /** A cutting, roving or end-of-line check recorded in one step. */
  readonly decision?: DecisionBody | undefined
  readonly note?: string | null | undefined
}

interface Where {
  readonly companyId: string
  readonly siteId: string
  readonly workOrder: WorkOrderRow | null
  readonly line: LineRow | null
  readonly bundle: { readonly id: string; readonly code: string; readonly quantity: number } | null
  readonly workOrderOperationId: string | null
}

/** The place a check is about, as the caller may reach it, and its company and site (404 / 403 / 400 in words). */
async function whereOf(caller: CommandCaller, context: Checker, body: OpenBody): Promise<Where> {
  return caller.withClient(async (db) => {
    let bundle = body.bundleId ? await readBundle(db, body.bundleId) : null
    if (body.bundleId && !bundle) throw invalid('Not a bundle of this site.', [{ path: 'bundleId', message: 'Not a bundle of this site.' }])
    if (!bundle && body.bundleCode) {
      bundle = await readBundleByCode(db, body.bundleCode.trim().toUpperCase())
      if (!bundle) throw invalid('Not a bundle ticket of this site.', [{ path: 'bundleCode', message: 'Not a bundle ticket of this site.' }])
    }
    const workOrderId = body.workOrderId ?? bundle?.workOrderId
    if (bundle && body.workOrderId && bundle.workOrderId !== body.workOrderId) throw invalid('The bundle is of another work order.', [{ path: 'bundleId', message: 'The bundle is of another work order.' }])
    const workOrder = workOrderId ? await readWorkOrder(db, workOrderId) : null
    if (workOrderId && !workOrder) throw invalid('Work order not found.', [{ path: 'workOrderId', message: 'Work order not found.' }])
    let lineId = body.lineId ?? null
    if (!lineId && (body.kind === 'ROVING' || body.kind === 'END_OF_LINE')) lineId = (context.audience === 'floor' ? (await devicePlaceOf(db, context.deviceId)).lineId : null) ?? workOrder?.lineId ?? null
    const line = lineId ? await readLine(db, lineId) : null
    if (lineId && !line) throw invalid('Line not found.', [{ path: 'lineId', message: 'Line not found.' }])
    const place = { lineId: line?.id ?? null, workOrderId: workOrder?.id ?? null, bundleId: bundle?.id ?? null, workOrderOperationId: body.workOrderOperationId ?? null }
    const problems = placeProblems(body.kind, place)
    if (problems.length > 0) throw invalid('Say what the check is about.', problems)
    const owner = workOrder ?? line!
    if (workOrder && line && line.siteId !== workOrder.siteId) throw invalid('The line is of another site than the work order.', [{ path: 'lineId', message: 'The line is of another site than the work order.' }])
    assertOn(context, QUALITY_INPROCESS_VIEW, QUALITY_INPROCESS_RECORD, owner, workOrder ? 'Work order' : 'Line')
    if (place.workOrderOperationId) {
      const operations = await readOperationsOf(db, [workOrder!.id])
      if (!operations.some((operation) => operation.id === place.workOrderOperationId)) throw invalid('Not an operation of this work order.', [{ path: 'workOrderOperationId', message: 'Not an operation of this work order.' }])
    }
    return { companyId: owner.companyId, siteId: owner.siteId, workOrder, line, bundle: bundle ? { id: bundle.id, code: bundle.code, quantity: bundle.quantity } : null, workOrderOperationId: place.workOrderOperationId }
  })
}

/** A defect of the library a check names: active, not a category (400 in words). Its class, for the roving light. */
async function defectOf(db: Pick<Reader, 'defectCode'>, defectCodeId: string | null | undefined, prefix: string): Promise<{ readonly critical: boolean } | null> {
  const path = 'defectCodeId'
  if (!defectCodeId) return null
  const found = await db.defectCode.findUnique({ where: { id: defectCodeId }, select: { code: true, parentId: true, active: true, severity: true } })
  if (!found) throw invalid('Not a defect of the library.', [{ path, message: 'Not a defect of the library.' }], prefix)
  if (found.parentId === null) throw invalid(`${found.code} is a category: pick one of its defects.`, [{ path, message: `${found.code} is a category: pick one of its defects.` }], prefix)
  if (!found.active) throw invalid(`${found.code} is retired: it is no longer picked.`, [{ path, message: `${found.code} is retired: it is no longer picked.` }], prefix)
  return { critical: found.severity === 'CRITICAL' }
}

/** A finding in words, then its defect; a critical defect is never a green or amber roving light (QHS-002). */
async function assertFinding(db: Pick<Reader, 'defectCode'>, kind: InProcessKind, finding: Finding, prefix: string): Promise<void> {
  const problems = findingProblems(kind, finding)
  if (problems.length > 0) throw invalid('The finding is not valid.', problems, prefix)
  const defect = await defectOf(db, finding.defectCodeId, prefix)
  if (defect?.critical && kind === 'ROVING' && finding.outcome !== 'RED') throw invalid('A critical defect is red.', [{ path: 'outcome', message: 'A critical defect (safety or compliance) is red, whatever the count (QHS-002).' }], prefix)
}

/** The APPROVED version a check runs on: the one named (of the stage and company), else the plan that applies. */
async function planVersionFor(db: Reader, body: OpenBody, where: Where): Promise<string | null> {
  const stage = STAGE_OF_KIND[body.kind]
  if (body.planVersionId === null || (body.planVersionId === undefined && body.decision)) return null
  if (body.planVersionId) {
    const version = await db.inspectionPlanVersion.findUnique({ where: { id: body.planVersionId }, select: { status: true, plan: { select: { companyId: true, stage: true, code: true } } } })
    if (!version || version.plan.companyId !== where.companyId) throw invalid('Not a plan version of this company.', [{ path: 'planVersionId', message: 'Not a plan version of this company.' }])
    if (version.status !== 'APPROVED') throw invalid(`This version of ${version.plan.code} is not in force: a check runs on the APPROVED version.`, [{ path: 'planVersionId', message: 'Not the version in force.' }])
    if (version.plan.stage !== stage) throw invalid(`${version.plan.code} is a plan of another stage.`, [{ path: 'planVersionId', message: `A ${body.kind.toLowerCase().replace(/_/g, ' ')} check runs on a plan of stage ${stage}.` }])
    return body.planVersionId
  }
  const plans = await db.inspectionPlan.findMany({ where: { companyId: where.companyId, stage }, select: { id: true, code: true, appliesTo: true, versions: { where: { status: 'APPROVED' }, select: { id: true } } } })
  if (plans.length === 0) return null
  const style = where.workOrder ? await db.style.findUnique({ where: { id: where.workOrder.styleId }, select: { id: true, productType: true, brandPartyId: true } }) : null
  const customers = where.workOrder ? await customersOf(db, where.workOrder.id) : []
  const operation = where.workOrderOperationId ? await db.workOrderOperation.findUnique({ where: { id: where.workOrderOperationId }, select: { operationId: true } }) : null
  const facts = {
    ...(style ? { STYLE: [style.id], CATEGORY: [style.productType] } : {}),
    ...(where.workOrder ? { CUSTOMER: [...customers, style?.brandPartyId ?? null] } : {}),
    ...(operation ? { OPERATION: [operation.operationId] } : {}),
  }
  const candidates = plans
    .filter((plan) => plan.versions.length > 0)
    .map((plan) => ({ plan, match: chipsMatch(chipsOf(plan.appliesTo), facts) }))
    .filter((candidate) => candidate.match.matches)
    .sort((a, b) => b.match.because.length - a.match.because.length || a.plan.code.localeCompare(b.plan.code))
  return candidates[0]?.plan.versions[0]?.id ?? null
}

/** The lot an AQL plan samples: the bundle's pieces, else the work order's (none: a check of a line). */
async function lotOf(db: Reader, where: Where): Promise<number | null> {
  if (where.bundle) return where.bundle.quantity
  if (!where.workOrder) return null
  const cells = await db.workOrderSize.findMany({ where: { workOrderId: where.workOrder.id }, select: { quantity: true } })
  const pieces = cells.reduce((sum, cell) => sum + cell.quantity, 0)
  return pieces > 0 ? pieces : null
}

/**
 * The operator a one-step roving result or end-of-line defect names, behind the gate: the worker of the bundle's latest
 * standing scan at that operation (a start or a report), read in the tenant's system view. Null where the gate is not in
 * force, or nobody can be told (no bundle, no operation, a site that records stations).
 */
async function operatorOf(caller: CommandCaller, body: OpenBody, where: Where): Promise<{ readonly workerId: string; readonly employeeId: string | null } | null> {
  if (!body.decision || !where.bundle || !where.workOrderOperationId) return null
  if (body.kind !== 'ROVING' && !(body.kind === 'END_OF_LINE' && body.decision.outcome === 'FAIL')) return null
  return systemOf(caller).withClient(async (db) => {
    if (!(await workerGateFor(db, where.siteId)).open) return null
    const scan = await db.operationScan.findFirst({
      where: { bundleId: where.bundle!.id, workOrderOperationId: where.workOrderOperationId!, kind: { in: ['REPORT', 'START', 'RESUME', 'PARTIAL'] }, workerId: { not: null }, correctedBy: { none: {} } },
      select: { workerId: true },
      orderBy: [{ serverTime: 'desc' }, { id: 'desc' }],
    })
    if (!scan?.workerId) return null
    const worker = await db.worker.findUnique({ where: { id: scan.workerId }, select: { employeeId: true } })
    return { workerId: scan.workerId, employeeId: worker?.employeeId ?? null }
  })
}

/** The run's hold after a first piece's change, for its event. */
async function runHeld(tx: CommandTx, row: Pick<CheckRow, 'workOrderId' | 'workOrderOperationId'>): Promise<boolean> {
  return firstPieceHold(await firstPieceRows(tx, row.workOrderId!), { bundleId: '', workOrderOperationId: row.workOrderOperationId }).held
}

function changedEvent(tools: CommandTools, row: CheckRow, change: 'OPENED' | 'RESULTS' | 'DECIDED' | 'RECORDED' | 'CANCELLED') {
  tools.emit({
    type: 'in_process_check.changed',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: { checkId: row.id, kind: kindOf(row), change, status: statusOf(row), outcome: outcomeOf(row), siteId: row.siteId, lineId: row.lineId, workOrderId: row.workOrderId, bundleId: row.bundleId, workOrderOperationId: row.workOrderOperationId, pieces: row.pieces, defects: row.defects },
  })
}

async function firstPieceEvent(tools: CommandTools, row: CheckRow) {
  if (row.kind !== 'FIRST_PIECE') return
  tools.emit({
    type: 'in_process_check.first_piece',
    subject: row.workOrderId!,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: { checkId: row.id, workOrderId: row.workOrderId!, workOrderOperationId: row.workOrderOperationId, bundleId: row.bundleId!, status: statusOf(row), outcome: outcomeOf(row), held: await runHeld(tools.tx, row) },
  })
}

const CHECK_SELECT = { id: true } as const

// ---- open ---------------------------------------------------------------------------------------------------------------------

export async function openCheck(caller: CommandCaller, body: OpenBody, idempotencyKey: string | undefined) {
  const context = checkerOf(caller)
  if (body.decision && !ONE_STEP_KINDS.includes(body.kind)) throw invalid('A first piece is decided after its checklist, signed with the PIN.', [{ path: 'decision', message: 'A first piece is opened first, then decided and signed.' }])
  if (body.note && body.note.length > LIMITS.note) throw invalid('The note is too long.', [{ path: 'note', message: `At most ${LIMITS.note} characters.` }])
  const where = await whereOf(caller, context, body)
  if (where.workOrder) {
    const allowed: readonly string[] = body.kind === 'FIRST_PIECE' ? STARTABLE : RUNNING
    if (!allowed.includes(where.workOrder.status)) refuse({ code: 'WORK_ORDER_NOT_RUNNING', message: `Work order ${where.workOrder.number} is ${where.workOrder.status.toLowerCase().replace(/_/g, ' ')}: ${body.kind === 'FIRST_PIECE' ? 'a first piece is asked while it is released or in progress' : 'its work is checked while it is released, in progress or on hold'}.`, fix: 'Check a work order the line is running.' })
  }
  if (body.decision) await caller.withClient((db) => assertFinding(db, body.kind, findingOf(body.decision!), 'body/decision'))
  if (context.audience === 'floor') await assertFloorReady(caller, where.siteId)
  const operator = await operatorOf(caller, body, where)
  const signer = signerOf(context)
  // The operator is written only by the tenant's system scope (the floor reads no legal basis); everything else as the caller.
  const writer = operator ? systemOf(caller) : caller
  const { result } = await command(writer, { name: 'quality.inprocess.open', idempotencyKey, input: { ...body, by: postedBy(context), actorId: context.actorId } }, async (tools) => {
    const { tx, now } = tools
    // The same lock as a rule's open (B-W2b-101): a person and a rule never open two checks of one run at once.
    if (where.workOrder) await lockWorkOrderChecks(tx, where.workOrder.id)
    if (body.kind === 'FIRST_PIECE') {
      await lockRun(tx, context.tenantId, where.workOrder!.id)
      const rows = await firstPieceRows(tx, where.workOrder!.id)
      const sameRun = rows.filter((row) => row.status !== 'CANCELLED' && row.workOrderOperationId === where.workOrderOperationId)
      if (sameRun.some((row) => row.status === 'OPEN')) refuse({ code: 'FIRST_PIECE_OPEN', message: `A first piece of this run of ${where.workOrder!.number} is open already.`, fix: 'Decide or cancel the open first piece first.' })
      if (firstPieceHold(rows, { bundleId: '', workOrderOperationId: where.workOrderOperationId }).approved) {
        refuse({ code: 'ALREADY_APPROVED', message: `The first piece of this run of ${where.workOrder!.number} is approved already: nothing waits for it.`, fix: 'Record a roving or end-of-line check instead.' })
      }
    }
    const planVersionId = await planVersionFor(tx, body, where)
    let aqlProfileId: string | null = null
    let codeLetter: string | null = null
    const lot = body.kind === 'FIRST_PIECE' || body.decision ? null : await lotOf(tx, where)
    if (lot !== null && where.workOrder) {
      const answer = await aqlPlanFor(tx, { companyId: where.companyId, planVersionId, styleId: where.workOrder.styleId, customerIds: await customersOf(tx, where.workOrder.id), lotSize: lot })
      if (answer.profile && answer.plan) {
        aqlProfileId = answer.profile.id
        codeLetter = answer.plan.codeLetter ?? null
      }
    }
    const decided = body.decision ? findingOf(body.decision) : null
    const id = newId()
    await tx.inProcessCheck.create({
      data: {
        id,
        companyId: where.companyId,
        siteId: where.siteId,
        kind: body.kind,
        status: decided ? 'DECIDED' : 'OPEN',
        outcome: decided?.outcome ?? null,
        lineId: where.line?.id ?? null,
        workOrderId: where.workOrder?.id ?? null,
        bundleId: where.bundle?.id ?? null,
        workOrderOperationId: where.workOrderOperationId,
        planVersionId,
        aqlProfileId,
        codeLetter,
        pieces: decided?.pieces ?? 0,
        defectivePieces: decided?.defectivePieces ?? 0,
        defects: decided?.defects ?? 0,
        defectCodeId: decided?.defectCodeId ?? null,
        inspectorWorkerId: signer.workerId,
        inspectorUserId: signer.userId,
        workerId: operator?.workerId ?? null,
        employeeId: operator?.employeeId ?? null,
        decidedAt: decided ? now : null,
        note: body.note?.trim() || null,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: CHECK_SELECT,
    })
    const row = (await readCheck(tx, id))!
    tools.audit({
      recordType: 'InProcessCheck',
      recordId: id,
      companyId: where.companyId,
      siteId: where.siteId,
      after: { kind: body.kind, status: row.status, outcome: row.outcome, lineId: row.lineId, workOrderId: row.workOrderId, bundleId: row.bundleId, workOrderOperationId: row.workOrderOperationId, planVersionId, aqlProfileId, codeLetter, pieces: row.pieces, defectivePieces: row.defectivePieces, defects: row.defects, defectCodeId: row.defectCodeId, inspector: signer, postedBy: postedBy(context), ...(context.audience === 'floor' ? { deviceId: context.deviceId } : {}), operatorNamed: operator !== null },
    })
    changedEvent(tools, row, decided ? 'RECORDED' : 'OPENED')
    await firstPieceEvent(tools, row)
    return { id }
  })
  return { check: await checkViewOf(caller, result.id) }
}

// ---- record the plan results ----------------------------------------------------------------------------------------------------

/** The check's row FOR UPDATE inside a command, then its version and its state (an OPEN one only: 409 in words). */
async function lockCheck(tx: CommandTx, checkId: string, expectedVersion: number): Promise<CheckRow> {
  await tx.$queryRaw`SELECT "id" FROM "InProcessCheck" WHERE "id" = ${checkId}::uuid FOR UPDATE`
  const row = await readCheck(tx, checkId)
  if (!row) refuse({ code: 'NOT_FOUND', message: 'Check not found.', fix: 'Reload the line.' })
  if (row!.version !== expectedVersion) throw new StaleVersionError('InProcessCheck', row!.id, row!.version, expectedVersion)
  assertOpen(row!)
  return row!
}

function assertOpen(row: Pick<CheckRow, 'status'>): void {
  if (row.status !== 'OPEN') refuse({ code: 'NOT_OPEN', message: `This check is ${row.status.toLowerCase()}: a decided or cancelled check never changes (a correction is an amendment).`, fix: 'Open a new check.' })
}

/** The check as the caller may act on it with the permission (404 / 403). */
async function checkFor(caller: CommandCaller, context: Checker, checkId: string): Promise<CheckRow> {
  const row = await caller.withClient((db) => readCheck(db, checkId))
  if (!row) throw new NotFoundError('Check not found.')
  assertOn(context, QUALITY_INPROCESS_VIEW, QUALITY_INPROCESS_RECORD, row, 'Check')
  return row
}

export interface ResultsBody {
  readonly version: number
  readonly results: readonly ResultInput[]
}

export async function saveResults(caller: CommandCaller, checkId: string, body: ResultsBody, idempotencyKey: string | undefined) {
  const context = checkerOf(caller)
  const row = await checkFor(caller, context, checkId)
  assertOpen(row)
  if (!row.planVersionId) refuse({ code: 'NO_PLAN', message: 'This check runs on no plan: it has no checklist to answer.', fix: 'Record what you found when you decide it.' })
  const checks = await caller.withClient((db) => readChecks(db, [row.planVersionId!]))
  const problems = resultProblems(body.results, checks.map((check) => { const content = contentOfCheck(check); return { code: content.code, type: content.type, nominal: content.nominal, tolerance: content.tolerance, choices: content.choices } }))
  if (problems.length > 0) throw invalid('The results are not valid.', problems)
  const signer = signerOf(context)
  const { result } = await command(caller, { name: 'quality.inprocess.results', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const current = await lockCheck(tx, row.id, body.version)
    const byCode = new Map(checks.map((check) => [check.code, check.id]))
    const existing = await readResults(tx, current.id)
    const key = (planCheckId: string, unit: number) => `${planCheckId}|${unit}`
    const wanted = new Map(body.results.map((entry) => [key(byCode.get(entry.code)!, entry.sampleIndex ?? 1), entry]))
    for (const old of existing) if (!wanted.has(key(old.planCheckId, old.sampleIndex))) await tx.inspectionCheckResult.delete({ where: { id: old.id }, select: { id: true } })
    for (const [wantedKey, entry] of wanted) {
      const found = existing.find((old) => key(old.planCheckId, old.sampleIndex) === wantedKey)
      const data = { outcome: entry.outcome, value: entry.outcome === 'NOT_APPLICABLE' ? null : entry.value?.trim() || null, note: entry.note?.trim() || null, recordedById: signer.userId, recordedByWorkerId: signer.workerId, deviceId: context.audience === 'floor' ? context.deviceId : null, recordedAt: now }
      if (found) {
        if (found.outcome !== data.outcome || found.value !== data.value || found.note !== data.note) await tx.inspectionCheckResult.update({ where: { id: found.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      } else {
        await tx.inspectionCheckResult.create({ data: { id: newId(), siteId: current.siteId, inProcessCheckId: current.id, planCheckId: byCode.get(entry.code)!, sampleIndex: entry.sampleIndex ?? 1, ...data, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
      }
    }
    await tx.inProcessCheck.update({ where: { id: current.id }, data: { version: { increment: 1 }, updatedAt: now }, select: CHECK_SELECT })
    tools.audit({ recordType: 'InProcessCheck', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { results: existing.length }, after: { results: body.results.map((entry) => ({ code: entry.code, sampleIndex: entry.sampleIndex ?? 1, outcome: entry.outcome, value: entry.value ?? null })), recordedBy: signer } })
    changedEvent(tools, (await readCheck(tx, current.id))!, 'RESULTS')
    return { id: current.id }
  })
  return { check: await checkViewOf(caller, result.id) }
}

// ---- decide ---------------------------------------------------------------------------------------------------------------------

export interface DecideBody extends DecisionBody {
  readonly version: number
  readonly note?: string | null | undefined
}

/** What stops a passing outcome on a plan, in words (the database refuses the same): a mandatory check unanswered, a critical failed. */
async function planBlockers(db: Reader, row: CheckRow): Promise<string | null> {
  if (!row.planVersionId) return null
  const checks = (await readChecks(db, [row.planVersionId])).map((check) => ({ id: check.id, ...contentOfCheck(check) }))
  const results = await readResults(db, row.id)
  const missing = checks.find((check) => check.mandatory && check.type !== 'INSTRUCTION' && !results.some((result) => result.planCheckId === check.id))
  if (missing) return `Mandatory check ${missing.code} (${missing.labelEn}) has no result.`
  const failed = checks.find((check) => check.checkClass === 'CRITICAL' && results.some((result) => result.planCheckId === check.id && result.outcome === 'FAIL'))
  return failed ? `Critical check ${failed.code} (${failed.labelEn}) failed: the check cannot pass (QHS-002).` : null
}

export async function decideCheck(caller: CommandCaller, checkId: string, body: DecideBody, options: { readonly sign: () => void | Promise<void>; readonly idempotencyKey?: string | undefined }) {
  const context = checkerOf(caller)
  const row = await checkFor(caller, context, checkId)
  assertOpen(row)
  const kind = kindOf(row)
  const finding = findingOf(body)
  await caller.withClient((db) => assertFinding(db, kind, finding, 'body'))
  if (isPassing(finding.outcome)) {
    const blocker = await caller.withClient((db) => planBlockers(db, row))
    if (blocker) refuse({ code: 'PLAN_RESULTS', message: blocker, fix: 'Answer the plan first, or record what failed.' })
  }
  if (context.audience === 'floor') await assertFloorReady(caller, row.siteId)
  // A first piece is a signing act: the PIN or the fresh code, asked after every other check.
  if (kind === 'FIRST_PIECE') await options.sign()
  const signer = signerOf(context)
  const { result } = await command(caller, { name: 'quality.inprocess.decide', idempotencyKey: options.idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (kind === 'FIRST_PIECE') {
      await lockWorkOrderChecks(tx, row.workOrderId!)
      await lockRun(tx, context.tenantId, row.workOrderId!)
    }
    const current = await lockCheck(tx, row.id, body.version)
    const results = await readResults(tx, current.id)
    const codes = new Map((current.planVersionId ? await readChecks(tx, [current.planVersionId]) : []).map((check) => [check.id, check.code]))
    const signature =
      kind === 'FIRST_PIECE'
        ? firstPieceSha256({
            checkId: current.id,
            workOrderId: current.workOrderId!,
            bundleId: current.bundleId!,
            workOrderOperationId: current.workOrderOperationId,
            planVersionId: current.planVersionId,
            outcome: finding.outcome,
            pieces: finding.pieces,
            defectivePieces: finding.defectivePieces,
            defects: finding.defects,
            results: results.map((entry) => ({ code: codes.get(entry.planCheckId) ?? '?', sampleIndex: entry.sampleIndex, outcome: entry.outcome, value: entry.value })),
            signer,
            at: toUtcIso(now),
          })
        : null
    await tx.inProcessCheck.update({
      where: { id: current.id },
      data: {
        status: 'DECIDED',
        outcome: finding.outcome,
        pieces: finding.pieces,
        defectivePieces: finding.defectivePieces,
        defects: finding.defects,
        defectCodeId: finding.defectCodeId ?? null,
        decidedAt: now,
        signatureSha256: signature,
        inspectorWorkerId: signer.workerId,
        inspectorUserId: signer.userId,
        ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}),
        version: { increment: 1 },
        updatedAt: now,
      },
      select: CHECK_SELECT,
    })
    const after = (await readCheck(tx, current.id))!
    tools.audit({ recordType: 'InProcessCheck', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { status: 'OPEN' }, after: { status: 'DECIDED', outcome: finding.outcome, pieces: finding.pieces, defectivePieces: finding.defectivePieces, defects: finding.defects, defectCodeId: finding.defectCodeId ?? null, signatureSha256: signature, signedBy: signer, postedBy: postedBy(context) } })
    changedEvent(tools, after, 'DECIDED')
    await firstPieceEvent(tools, after)
    return { id: current.id }
  })
  return { check: await checkViewOf(caller, result.id) }
}

// ---- cancel ---------------------------------------------------------------------------------------------------------------------

export async function cancelCheck(caller: CommandCaller, checkId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey: string | undefined) {
  const context = checkerOf(caller)
  const row = await checkFor(caller, context, checkId)
  assertOpen(row)
  const problem = reasonProblem(body.reason)
  if (problem) throw invalid('Say why the check is cancelled.', [problem])
  const { result } = await command(caller, { name: 'quality.inprocess.cancel', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (row.kind === 'FIRST_PIECE') {
      await lockWorkOrderChecks(tx, row.workOrderId!)
      await lockRun(tx, context.tenantId, row.workOrderId!)
    }
    const current = await lockCheck(tx, row.id, body.version)
    await tx.inProcessCheck.update({ where: { id: current.id }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: body.reason.trim(), version: { increment: 1 }, updatedAt: now }, select: CHECK_SELECT })
    const after = (await readCheck(tx, current.id))!
    tools.audit({ recordType: 'InProcessCheck', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { status: 'OPEN' }, after: { status: 'CANCELLED', by: signerOf(context) }, reason: body.reason.trim() })
    changedEvent(tools, after, 'CANCELLED')
    await firstPieceEvent(tools, after)
    return { id: current.id }
  })
  return { check: await checkViewOf(caller, result.id) }
}

