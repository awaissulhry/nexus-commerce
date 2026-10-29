import { ConflictError, InvalidStateError, isDomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_LOTS_TEST } from '@nexus/factory-domain/quality/lab/permissions'
import { CR_VI_UNIT, LAB_LAW, resultEffect, resultProblems, type CrViMethod, type CrViResultInput, type LabTest } from '@nexus/factory-domain/quality/lab/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { openRegisterEntryFor } from '../../compliance/register/hook'
import { addYears } from '../../../platform/files/rules'
import { completeUpload, requestUpload, retainFilesInCommand } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { checklistOf, lotView, ruleFor, today } from './read'
import { processLabResults, type LabResultRow } from './results-store'
import { factsOf, lockLotStock, lotFor, officeOf, readLot, type LotRow } from './store'
import { workOrdersOf } from './trace'

/**
 * A lot's chromium VI result with its report (B-W1-34; QHS-029, SCM-117; REACH Annex XVII entry 47; design lt-crvi,
 * ts-record, ts-later-fail). quality.lots.test over the lot's company and site, and files.upload.
 *
 *   announce  POST /quality/lots/:lotId/results/report → files.requestUpload (kind CERTIFICATE of the Lot: module-owned,
 *             platform/files/owned.ts) → the presigned PUT. Not for a lot that takes no result (rejected, no test
 *             needed, a FAIL already).
 *   record    POST /quality/lots/:lotId/results {version, fileId, …}: the result checked first (every problem at once:
 *             method, value or "below the detection limit", lab, test day, the evidence and what the rule in force
 *             accepts, a supplier report's article and period); the report confirmed (files.completeUpload, the
 *             store's HEAD) unless it is an available supplier report of another lot of the same article and supplier
 *             (reused); then ONE command on the Lot (its version is the edit-conflict guard and its bump locks the
 *             row): the verdict computed against the lot's limit, the lot's Cr VI columns (the trigger checks the
 *             verdict again), the result (the results seam), the report kept ten years (REACH art. 36), the event.
 *             A later FAIL on a PASS supersedes it; a RELEASED lot is BLOCKED under its stock locks and the work
 *             orders it went to come back (and in `lot.blocked`); when its stock went to work orders, the PPE register
 *             entry of their garments is opened in the same command (B-W1-43's hook, source LabResult).
 */

const REPORT_RETENTION_YEARS = 10
const RETENTION_WHY = 'REACH art. 36: the chromium VI evidence of a lot is kept at least ten years.'

export interface ReportUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** Refuses a lot that can take no result at all (whatever its verdict). */
function assertTakesResults(lot: LotRow): void {
  const refusal = resultEffect(factsOf(lot), 'FAIL')
  if (typeof refusal === 'string') throw new InvalidStateError(refusal)
}

/** POST /quality/lots/:lotId/results/report. */
export async function announceReport(caller: CommandCaller, lotId: string, body: ReportUpload, idempotencyKey?: string) {
  const lot = await lotFor(caller, lotId, QUALITY_LOTS_TEST)
  assertTakesResults(lot)
  return requestUpload(
    processFiles(),
    caller,
    { companyId: lot.companyId, recordType: 'Lot', recordId: lot.id, kind: 'CERTIFICATE', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 },
    idempotencyKey,
    { viaModule: true },
  )
}

export interface RecordResultBody extends CrViResultInput {
  readonly version: number
  readonly test: LabTest
  readonly fileId: string
}

const blank = (value: string | null | undefined): string | null => (value?.trim() ? value.trim() : null)

/** The report the result rests on: this lot's CERTIFICATE file, or (a supplier report) one recorded for a lot of the same article. */
async function reportFile(caller: CommandCaller, lot: LotRow, body: RecordResultBody, idempotencyKey?: string) {
  const file = isUuid(body.fileId)
    ? await caller.withClient((client) => client.storedFile.findFirst({ where: { id: body.fileId, kind: 'CERTIFICATE', status: { not: 'DELETED' } }, select: { id: true, recordType: true, recordId: true, status: true, contentType: true } }))
    : null
  if (!file) throw new NotFoundError('Report file not found.')
  if (file.recordType === 'Lot' && file.recordId === lot.id) {
    const confirmed = await completeUpload(processFiles(), caller, file.id, idempotencyKey, { viaModule: true })
    if (confirmed.status !== 'AVAILABLE') throw new ConflictError(`The report did not arrive as announced (${confirmed.quarantineReason ?? confirmed.status}): announce it again and send the file.`)
    return { id: file.id, reused: false }
  }
  // Another lot's supplier report: the same article (item) and supplier, the report already recorded as one, available.
  const reused = await caller.withClient(async (client) => {
    if (body.evidence !== 'SUPPLIER_REPORT' || file.recordType !== 'Lot' || file.status !== 'AVAILABLE') return false
    const source = await readLot(client, file.recordId)
    if (!source || source.companyId !== lot.companyId || source.itemId !== lot.itemId || source.supplierId !== lot.supplierId) return false
    return (await processLabResults().byFile(client, file.id)).some((row) => row.evidence === 'SUPPLIER_REPORT')
  })
  if (!reused) {
    throw new ValidationError('The result is not valid.', [
      { path: 'body/fileId', message: "Not a report of this lot: upload the lab's report here, or name a supplier report already recorded for a lot of the same article and supplier." },
    ])
  }
  return { id: file.id, reused: true }
}

/** POST /quality/lots/:lotId/results. */
export async function recordResult(caller: CommandCaller, lotId: string, body: RecordResultBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const lot = await lotFor(caller, lotId, QUALITY_LOTS_TEST)
  // Only what never changes on the lot is checked before the command (its limit, its receipt day): a repeat of the same
  // Idempotency-Key must reach command()'s stored answer. The lot's state is judged inside, under its row lock.
  const facts = factsOf(lot)
  if (!lot.requiresCrViTest || facts.crViLimitMgKg === null) throw new InvalidStateError(`Lot ${lot.code} needs no chromium VI test: its material does not ask for one.`)
  const { rule } = await caller.withClient((client) => ruleFor(client, context.tenantId, lot.companyId))
  const checked = resultProblems(body, { limitMgKg: facts.crViLimitMgKg, rule, lotCode: lot.code, receivedDay: facts.receivedDay, today: today() })
  if (checked.problems.length > 0) throw new ValidationError('The result is not valid.', checked.problems.map((problem) => ({ path: `body/${problem.path}`, message: problem.message })))
  const file = await reportFile(caller, lot, body, idempotencyKey)

  const { result } = await command(
    caller,
    { name: 'quality.lots.recordResult', idempotencyKey, input: { lotId, ...body }, record: { type: 'Lot', id: lot.id, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const current = (await readLot(tx, lot.id))!
      const inside = factsOf(current)
      // The rule and the lot again, in the transaction: what the result is judged against.
      const { rule: ruleNow } = await ruleFor(tx, context.tenantId, current.companyId)
      const again = resultProblems(body, { limitMgKg: inside.crViLimitMgKg!, rule: ruleNow, lotCode: current.code, receivedDay: inside.receivedDay, today: businessDate(now) })
      if (again.problems.length > 0) throw new ValidationError('The result is not valid.', again.problems.map((problem) => ({ path: `body/${problem.path}`, message: problem.message })))
      const verdict = again.verdict!
      const change = resultEffect(inside, verdict.verdict)
      if (typeof change === 'string') throw new InvalidStateError(change)

      const previous = change.laterFail ? ((await processLabResults().list(tx, current.id)).find((row) => row.verdict === 'PASS') ?? null) : null
      let trace: Awaited<ReturnType<typeof workOrdersOf>> | null = null
      if (change.laterFail && change.qualityStatus === 'BLOCKED') {
        await lockLotStock(tx, context.tenantId, current)
        trace = await workOrdersOf(tx, current.id)
      }
      const blocks = change.qualityStatus !== current.qualityStatus
      const note = blocks ? `Chromium VI FAIL on later evidence (${body.lab.trim()}${blank(body.reportNumber) ? `, report ${blank(body.reportNumber)}` : ''}): ${verdict.words}` : undefined
      await tx.lot.update({
        where: { id: current.id },
        data: {
          crViStatus: change.crViStatus,
          crViMgKg: verdict.valueMgKg,
          crViEvidence: body.evidence,
          crViTestedAt: new Date(`${body.testedOn}T00:00:00.000Z`),
          ...(blocks ? { qualityStatus: change.qualityStatus, qualityNote: note, qualityDecidedAt: now, qualityDecidedById: context.actorId } : {}),
        },
        select: { id: true },
      })
      const row: LabResultRow = {
        id: newId(),
        lotId: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        itemId: current.itemId,
        test: body.test,
        method: body.method as CrViMethod,
        valueMgKg: verdict.valueMgKg,
        belowDetectionLimit: verdict.belowDetectionLimit,
        detectionLimitMgKg: verdict.detectionLimitMgKg,
        unit: CR_VI_UNIT,
        limitMgKg: verdict.limitMgKg,
        verdict: verdict.verdict,
        lab: body.lab.trim(),
        reportNumber: blank(body.reportNumber),
        testedOn: body.testedOn,
        evidence: body.evidence,
        article: blank(body.article),
        periodFrom: blank(body.periodFrom),
        periodTo: blank(body.periodTo),
        fileId: file.id,
        supersedesId: previous?.id ?? null,
        note: blank(body.note),
        createdAt: toUtcIso(now),
        createdById: context.actorId,
      }
      await processLabResults().record(tools, row)
      // The garments made from it: a register entry (Reg. 2016/425 art. 8(4)) when its stock went to work orders.
      const register = trace && trace.length > 0 ? await registerEntryFor(tools, current, row, verdict.words, trace) : null
      if (!file.reused) await retainFilesInCommand(tools, [file.id], addYears(now, REPORT_RETENTION_YEARS), RETENTION_WHY)
      tools.audit({
        recordType: 'Lot',
        recordId: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        ...(note ? { reason: note } : {}),
        before: { crViStatus: current.crViStatus, qualityStatus: current.qualityStatus },
        after: { crViStatus: change.crViStatus, crViMgKg: verdict.valueMgKg, crViEvidence: body.evidence, crViTestedAt: body.testedOn, qualityStatus: change.qualityStatus, resultId: row.id, verdict: verdict.verdict, ...(trace ? { workOrderIds: trace.map((use) => use.workOrderId) } : {}) },
      })
      tools.emit({
        type: 'lot.test_recorded',
        subject: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        payload: { lotId: current.id, code: current.code, resultId: row.id, test: row.test, verdict: row.verdict, evidence: row.evidence, fileId: file.id, crViStatus: change.crViStatus, qualityStatus: change.qualityStatus, laterFail: change.laterFail },
      })
      if (blocks) {
        tools.emit({
          type: 'lot.blocked',
          subject: current.id,
          companyId: current.companyId,
          siteId: current.siteId,
          payload: { lotId: current.id, code: current.code, itemId: current.itemId, cause: 'CR_VI_FAIL', workOrderIds: (trace ?? []).map((use) => use.workOrderId) },
        })
      }
      const updated = (await readLot(tx, current.id))!
      return {
        result: { ...row, words: verdict.words },
        effect: change.words,
        lot: await lotView(tx, updated),
        checklist: await checklistOf(tx, context.tenantId, updated, businessDate(now), context.actorId),
        trace: trace && { law: LAB_LAW, workOrders: trace, register },
      }
    },
  )
  return result
}

/**
 * A later FAIL on a released lot whose stock went to work orders: the PPE register entry of the garments made from it
 * (modules/compliance/register `openRegisterEntryFor`, B-W1-43), NON_CONFORMITY, risk being assessed, its source this
 * lab result, in the same command. One entry concerns one style: when the lot went to work orders of several styles,
 * no entry is opened and the answer says so (one per style is opened by hand). A register that cannot number the entry
 * (no PPE_REGISTER series) never stops the FAIL from being recorded and the lot blocked: the answer says why.
 */
async function registerEntryFor(tools: CommandTools, lot: LotRow, result: LabResultRow, words: string, trace: Awaited<ReturnType<typeof workOrdersOf>>) {
  const workOrderIds = trace.map((use) => use.workOrderId)
  const styles = new Set((await tools.tx.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { styleId: true } })).map((order) => order.styleId))
  const numbers = trace.map((use) => use.number ?? use.workOrderId).join(', ')
  if (styles.size !== 1) {
    return { opened: false, entryId: null, reference: null, shippedGoods: null, words: `Lot ${lot.code} went to work orders of ${styles.size} styles (${numbers}): open one PPE register entry per style by hand.` }
  }
  try {
    const entry = await openRegisterEntryFor(tools, {
      companyId: lot.companyId,
      kind: 'NON_CONFORMITY',
      workOrderIds,
      description: `Material lot ${lot.code}: chromium VI FAIL on later evidence (${result.lab}${result.reportNumber ? `, report ${result.reportNumber}` : ''}): ${words} Its stock went to work orders ${numbers}.`,
      risk: 'ASSESSING',
      source: { type: 'LabResult', id: result.id },
    })
    return { ...entry, words: `PPE register entry ${entry.reference} ${entry.opened ? 'opened' : 'already open'} for the garments of work orders ${numbers}.` }
  } catch (error) {
    if (isDomainError(error) && ['not_found', 'invalid_state', 'conflict', 'validation_failed'].includes(error.code)) {
      return { opened: false, entryId: null, reference: null, shippedGoods: null, words: `No PPE register entry was opened (${error.message}): open it by hand for work orders ${numbers}.` }
    }
    throw error
  }
}
