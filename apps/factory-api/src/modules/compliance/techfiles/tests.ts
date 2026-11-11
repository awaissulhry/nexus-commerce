import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { TECHFILES_MANAGE, TECHFILES_VIEW } from '@nexus/factory-domain/compliance/techfiles/permissions'
import { retainUntilOf, testPlanProblems, testRecordProblems, type Frequency, type TestKind, type TestPlanInput, type TestRecordInput, type TestResult } from '@nexus/factory-domain/compliance/techfiles/rules'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { completeUpload, requestUpload, retainFilesInCommand } from '../../../platform/files/files'
import { normaliseContentType } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { assertMay, companyReach, dateOfDay, dayOf, guarded, officeOf, settings, techfilesClock, todayOf, type Reader } from './common'
import { TEST_SELECT, testView, type TestRow, type TestView } from './production'

/**
 * Production-control tests (B-W2b-251; QHS-048, PRD-302, QHS-110; design compliance.techfiles › Production control "Record
 * test" / "Schedule test"; PPE Reg. Annex VIII module C2, art. 8(2)): tests that show production still matches the certified
 * type, of a style — for a batch (a work order's, or a batch number typed) or for the style's production as a whole — due by
 * their frequency. Planned with the day they are due (removed while not needed), then recorded once: PASS or FAIL, the day,
 * who tested it (the lab or the person), the report number and the lab's report (a file of the test, uploaded first through
 * the test's own routes below: ProductionControlTest is module-owned in platform/files/owned.ts, B-W2b-278). A recorded test
 * and its report are kept ten years after the test day and change no more but the note and a later keep-until day; nothing
 * removes them before.
 *
 *   GET    /compliance/production-tests?styleId&workOrderId&state   certificates.view (the companies it reaches)
 *   POST   /compliance/production-tests                             techfiles.manage: plan one (or record it at once with `record`)
 *   PATCH  /compliance/production-tests/:testId                     techfiles.manage: a planned test's day, sample, clause, name, note; a recorded one's note and a later keep-until
 *   POST   /compliance/production-tests/:testId/report              techfiles.manage + files.upload: announce the lab report (B-W2b-278)
 *   POST   /compliance/production-tests/:testId/report/:fileId/complete   … and confirm it (only through these two routes)
 *   POST   /compliance/production-tests/:testId/record              techfiles.manage: the result (PASS | FAIL), once
 *   DELETE /compliance/production-tests/:testId?version=            techfiles.manage: a planned test (a recorded one only after its keep-until day)
 */

const NOT_FOUND = 'Production-control test not found.'
const LAB_REPORT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png'])

const testEvent = (tools: Pick<CommandTools, 'emit'>, row: Pick<TestRow, 'id' | 'styleId' | 'companyId' | 'workOrderId' | 'test' | 'result'>, change: 'PLANNED' | 'RECORDED' | 'EDITED' | 'REMOVED') =>
  tools.emit({ type: 'technical_file.test_changed', subject: row.styleId, companyId: row.companyId, payload: { testId: row.id, styleId: row.styleId, workOrderId: row.workOrderId, test: row.test as TestKind, result: row.result as TestResult | null, change } })

const testAudit = (row: Pick<TestRow, 'workOrderId' | 'batchNumber' | 'test' | 'testName' | 'frequency' | 'dueOn' | 'result' | 'testedOn' | 'testedBy' | 'reportNumber' | 'labReportFileId' | 'retainUntil' | 'note'>) => ({
  workOrderId: row.workOrderId,
  batchNumber: row.batchNumber,
  test: row.test,
  testName: row.testName,
  frequency: row.frequency,
  dueOn: dayOf(row.dueOn),
  result: row.result,
  testedOn: dayOf(row.testedOn),
  testedBy: row.testedBy,
  reportNumber: row.reportNumber,
  labReportFileId: row.labReportFileId,
  retainUntil: dayOf(row.retainUntil),
  note: row.note,
})

export interface ListTestsQuery {
  readonly styleId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly state?: 'DUE' | 'RECORDED' | 'ALL' | undefined
}

/** GET /compliance/production-tests */
export async function listTests(request: FastifyRequest, query: ListTestsQuery) {
  const actor = actorOf(officeOf(request))
  const now = techfilesClock().now()
  const today = todayOf(now)
  return request.withClient(async (db) => {
    const where: Prisma.ProductionControlTestWhereInput[] = [companyReach(actor) as Prisma.ProductionControlTestWhereInput]
    if (query.styleId) where.push({ styleId: query.styleId })
    if (query.workOrderId) where.push({ workOrderId: query.workOrderId })
    if (query.state === 'DUE') where.push({ result: null })
    if (query.state === 'RECORDED') where.push({ result: { not: null } })
    const rows = await db.productionControlTest.findMany({ where: { AND: where }, select: TEST_SELECT, orderBy: [{ dueOn: 'asc' }, { id: 'asc' }], take: 1000 })
    return { tests: rows.map((row) => testView(row, today)), asOf: toUtcIso(now) }
  })
}

async function readTest(db: Reader, testId: string): Promise<TestRow> {
  const row = isUuid(testId) ? await db.productionControlTest.findUnique({ where: { id: testId }, select: TEST_SELECT }) : null
  if (!row) throw new NotFoundError(NOT_FOUND)
  return row
}

async function lockedTest(tx: CommandTx, context: OfficeContext, testId: string): Promise<TestRow> {
  const row = await readTest(tx, testId)
  if (!can(actorOf(context), TECHFILES_VIEW, { companyId: row.companyId })) throw new NotFoundError(NOT_FOUND)
  assertMay(context, TECHFILES_MANAGE, row.companyId, 'Keeping a production-control test')
  return row
}

const answerOf = async (caller: CommandCaller, testId: string): Promise<{ test: TestView }> => ({ test: testView(await caller.withClient((db) => readTest(db, testId))) })

/** The lab report of a test being recorded: an available PDF or picture uploaded as a file of this test, of its company. */
async function checkLabReport(tx: Reader, test: Pick<TestRow, 'id' | 'companyId'>, fileId: string): Promise<void> {
  const row = await tx.storedFile.findUnique({ where: { id: fileId }, select: { recordType: true, recordId: true, companyId: true, status: true, contentType: true, originalName: true } })
  const path = 'body/labReportFileId'
  if (!row || row.recordType !== 'ProductionControlTest' || row.recordId !== test.id) {
    throw new ValidationError('The lab report is not a file of this test.', [{ path, message: 'Upload the lab report as a file of this test first (POST /compliance/production-tests/:testId/report, then …/report/:fileId/complete), then record the result.' }])
  }
  if (row.status !== 'AVAILABLE') throw new ValidationError('The lab report is not available yet.', [{ path, message: `"${row.originalName}" is ${row.status.toLowerCase()}: finish its upload first.` }])
  if (!LAB_REPORT_TYPES.has(row.contentType)) throw new ValidationError('The lab report is a PDF or a picture.', [{ path, message: 'A lab report is a PDF, a JPEG or a PNG.' }])
  if (row.companyId !== null && row.companyId !== test.companyId) throw new ValidationError('The lab report is of another company.', [{ path, message: `"${row.originalName}" is another company's.` }])
}

export interface RecordBody extends TestRecordInput {
  readonly labReportFileId?: string | null | undefined
}

/** The recorded columns and their ten years (QHS-110), checked as the database will. */
function recordedData(body: RecordBody, today: BusinessDate) {
  const problems = testRecordProblems(body, today)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The result is not valid.', problems)
  const retainUntil = retainUntilOf(body.testedOn!)
  return {
    data: { result: body.result as TestResult, testedOn: dateOfDay(body.testedOn!), testedBy: body.testedBy!.trim(), reportNumber: body.reportNumber ?? null, resultNote: body.resultNote ?? null, labReportFileId: body.labReportFileId ?? null, retainUntil: dateOfDay(retainUntil) },
    retainUntil,
  }
}

export interface PlanBody extends TestPlanInput {
  readonly styleId: string
  readonly companyId?: string | undefined
  /** Recorded at once (a test done without being planned): the result. A lab report is attached by POST …/record after upload. */
  readonly record?: Omit<RecordBody, 'labReportFileId'> | undefined
}

/** POST /compliance/production-tests */
export async function planTest(caller: CommandCaller, body: PlanBody, key: string | null | undefined): Promise<{ test: TestView }> {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const problems = testPlanProblems(body)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The test is not valid.', problems)
  const style = await caller.withClient((db) => db.style.findUnique({ where: { id: body.styleId }, select: { id: true, code: true, companyId: true } }))
  if (!style || !can(actor, TECHFILES_VIEW, { companyId: style.companyId })) throw new NotFoundError('Style not found.')
  const companyId = style.companyId ?? body.companyId ?? null
  if (companyId === null) throw new ValidationError('Say which company the test is of.', [{ path: 'body/companyId', message: `Style ${style.code} is every company's: say which company's production was tested.` }])
  assertMay(context, TECHFILES_MANAGE, companyId, 'Planning a production-control test')
  const { result } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.planTest', idempotencyKey: key, input: body },
      async (tools) => {
        const { tx, now, audit } = tools
        let siteId: string | null = null
        if (body.workOrderId) {
          const order = await tx.workOrder.findUnique({ where: { id: body.workOrderId }, select: { siteId: true, styleId: true, companyId: true, number: true } })
          if (!order || order.styleId !== style.id) throw new ValidationError('The work order is not of this style.', [{ path: 'body/workOrderId', message: `Name a work order of style ${style.code}.` }])
          if (order.companyId !== companyId) throw new ValidationError('The work order is of another company.', [{ path: 'body/workOrderId', message: `Work order ${order.number} is another company's.` }])
          siteId = order.siteId
        }
        const recorded = body.record ? recordedData(body.record, todayOf(now)) : null
        const id = newId()
        const row = await tx.productionControlTest.create({
          data: {
            id,
            companyId,
            styleId: style.id,
            siteId,
            workOrderId: body.workOrderId ?? null,
            batchNumber: body.batchNumber ?? null,
            test: body.test as TestKind,
            testName: body.testName ?? null,
            standardClause: body.standardClause ?? null,
            frequency: body.frequency as Frequency,
            dueOn: dateOfDay(body.dueOn!),
            sample: body.sample ?? null,
            note: body.note ?? null,
            ...(recorded ? recorded.data : {}),
            createdAt: now,
            updatedAt: now,
            createdById: context.actorId,
          },
          select: TEST_SELECT,
        })
        audit({ recordType: 'ProductionControlTest', recordId: id, companyId, after: testAudit(row) })
        testEvent(tools, row, recorded ? 'RECORDED' : 'PLANNED')
        return { id }
      },
      settings(),
    ),
  )
  return answerOf(caller, result.id)
}

// ---- the lab report (B-W2b-278, FU4:02: only through these routes; platform/files/owned.ts) ---------------------------------

export interface LabReportUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** The test a lab report goes onto: in reach, kept by this person, not recorded yet (a recorded test's report was named then). */
async function reportable(caller: CommandCaller, testId: string): Promise<TestRow> {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => readTest(db, testId))
  if (!can(actorOf(context), TECHFILES_VIEW, { companyId: row.companyId })) throw new NotFoundError(NOT_FOUND)
  assertMay(context, TECHFILES_MANAGE, row.companyId, 'Keeping a production-control test')
  if (row.result !== null) throw new ConflictError(`This test is recorded already (${row.result} on ${dayOf(row.testedOn)}): its lab report was named when it was recorded. Plan and record another test.`)
  return row
}

/** POST /compliance/production-tests/:testId/report: the lab report announced as a CERTIFICATE file of the test (a PDF or a picture). */
export async function announceLabReport(caller: CommandCaller, testId: string, body: LabReportUpload, key: string | null | undefined) {
  const row = await reportable(caller, testId)
  if (!LAB_REPORT_TYPES.has(normaliseContentType(body.contentType))) throw new ValidationError('The lab report is a PDF or a picture.', [{ path: 'body/contentType', message: 'A lab report is a PDF, a JPEG or a PNG.' }])
  return requestUpload(
    processFiles(),
    caller,
    { companyId: row.companyId, recordType: 'ProductionControlTest', recordId: testId, kind: 'CERTIFICATE', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 },
    key ?? undefined,
    { viaModule: true },
  )
}

/** POST /compliance/production-tests/:testId/report/:fileId/complete: the lab report's upload confirmed (then named by POST …/record). */
export async function completeLabReport(caller: CommandCaller, testId: string, fileId: string, key: string | null | undefined) {
  await reportable(caller, testId)
  const known = isUuid(fileId) ? await caller.withClient((db) => db.storedFile.findFirst({ where: { id: fileId, recordType: 'ProductionControlTest', recordId: testId }, select: { id: true } })) : null
  if (!known) throw new NotFoundError('File not found.')
  return { file: await completeUpload(processFiles(), caller, fileId, key ?? undefined, { viaModule: true }) }
}

/** POST /compliance/production-tests/:testId/record {version, result, testedOn, testedBy, reportNumber?, resultNote?, labReportFileId?} */
export async function recordTest(caller: CommandCaller, testId: string, body: RecordBody & { readonly version: number }, key: string | null | undefined): Promise<{ test: TestView }> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.recordTest', idempotencyKey: key, input: { testId, ...body }, record: { type: 'ProductionControlTest', id: testId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const before = await lockedTest(tx, context, testId)
        if (before.result !== null) throw new ConflictError(`This test is recorded already (${before.result} on ${dayOf(before.testedOn)}): a result changes no more. Plan and record another test.`)
        if (body.labReportFileId) await checkLabReport(tx, before, body.labReportFileId)
        const { data, retainUntil } = recordedData(body, todayOf(now))
        const row = await tx.productionControlTest.update({ where: { id: testId }, data: { ...data, updatedAt: now }, select: TEST_SELECT })
        if (body.labReportFileId) await retainFilesInCommand(tools, [body.labReportFileId], dateOfDay(retainUntil), `The lab report of a production-control test is kept until ${retainUntil} (QHS-110, PPE Reg. art. 8(3)).`)
        audit({ recordType: 'ProductionControlTest', recordId: testId, companyId: row.companyId, before: testAudit(before), after: testAudit(row) })
        testEvent(tools, row, 'RECORDED')
        return { id: testId }
      },
      settings(),
    ),
  )
  return answerOf(caller, testId)
}

export interface EditTestBody {
  readonly version: number
  readonly dueOn?: BusinessDate | undefined
  readonly sample?: string | null | undefined
  readonly standardClause?: string | null | undefined
  readonly testName?: string | null | undefined
  readonly note?: string | null | undefined
  readonly retainUntil?: BusinessDate | undefined
}

/** PATCH /compliance/production-tests/:testId */
export async function editTest(caller: CommandCaller, testId: string, body: EditTestBody, key: string | null | undefined): Promise<{ test: TestView }> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.editTest', idempotencyKey: key, input: { testId, ...body }, record: { type: 'ProductionControlTest', id: testId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const before = await lockedTest(tx, context, testId)
        const data: Prisma.ProductionControlTestUncheckedUpdateInput = { updatedAt: now }
        if (before.result !== null) {
          if (body.dueOn !== undefined || body.sample !== undefined || body.standardClause !== undefined || body.testName !== undefined) {
            throw new ConflictError(`This test is recorded (${before.result} on ${dayOf(before.testedOn)}): only its note and a later keep-until day change.`)
          }
          if (body.retainUntil !== undefined) {
            if (body.retainUntil < dayOf(before.retainUntil)!) throw new ValidationError('A keep-until day only moves later.', [{ path: 'body/retainUntil', message: `This test is kept until ${dayOf(before.retainUntil)}; give that day or a later one.` }])
            data.retainUntil = dateOfDay(body.retainUntil)
          }
        } else {
          if (body.retainUntil !== undefined) throw new ValidationError('A planned test has no keep-until day.', [{ path: 'body/retainUntil', message: 'The keep-until day is set when the result is recorded.' }])
          const merged = { test: before.test, testName: body.testName !== undefined ? body.testName : before.testName, frequency: before.frequency, dueOn: body.dueOn ?? dayOf(before.dueOn)!, standardClause: body.standardClause !== undefined ? body.standardClause : before.standardClause, sample: body.sample !== undefined ? body.sample : before.sample, note: body.note !== undefined ? body.note : before.note }
          const problems = testPlanProblems(merged)
          if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
          if (body.dueOn !== undefined) data.dueOn = dateOfDay(body.dueOn)
          if (body.sample !== undefined) data.sample = body.sample
          if (body.standardClause !== undefined) data.standardClause = body.standardClause
          if (body.testName !== undefined) data.testName = body.testName
        }
        if (body.note !== undefined) data.note = body.note
        const row = await tx.productionControlTest.update({ where: { id: testId }, data, select: TEST_SELECT })
        audit({ recordType: 'ProductionControlTest', recordId: testId, companyId: row.companyId, before: testAudit(before), after: testAudit(row) })
        testEvent(tools, row, 'EDITED')
        return { id: testId }
      },
      settings(),
    ),
  )
  return answerOf(caller, testId)
}

/** DELETE /compliance/production-tests/:testId?version= — a planned test; a recorded one only after its keep-until day (the database says so in words). */
export async function removeTest(caller: CommandCaller, testId: string, version: number, key: string | null | undefined): Promise<{ removed: string }> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.removeTest', idempotencyKey: key, input: { testId, version } },
      async (tools) => {
        const { tx, audit } = tools
        await tx.$queryRaw`SELECT id FROM "ProductionControlTest" WHERE id = ${testId}::uuid FOR UPDATE`
        const row = await lockedTest(tx, context, testId)
        if (row.version !== version) throw new ConflictError(`This test changed since it was read (version ${version}); it is now at version ${row.version}. Reload it.`)
        if (row.result !== null && dayOf(row.retainUntil)! >= todayOf(tools.now)) {
          throw new ConflictError(`This test is recorded and kept until ${dayOf(row.retainUntil)} (QHS-110, PPE Reg. art. 8(3)): it is not removed before.`)
        }
        await tx.productionControlTest.delete({ where: { id: testId } })
        audit({ recordType: 'ProductionControlTest', recordId: testId, companyId: row.companyId, before: testAudit(row) })
        testEvent(tools, row, 'REMOVED')
        return { removed: testId }
      },
      settings(),
    ),
  )
  return { removed: testId }
}
