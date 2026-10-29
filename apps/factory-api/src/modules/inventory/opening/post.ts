import type { Uom } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import type { RowValues } from '@nexus/factory-domain/imports/importer'
import { openingMoveKey, planOpeningRow, type OpeningPlan, type PlannedResult } from '@nexus/factory-domain/inventory/opening/rules'
import { nextHideTags } from '@nexus/factory-domain/inventory/receipts/rules'
import { CR_VI_UNIT, type CrViMethod } from '@nexus/factory-domain/quality/lab/rules'
import type { CommandTools } from '../../../core/command'
import { addYears } from '../../../platform/files/rules'
import { retainFilesInCommand } from '../../../platform/files/files'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { processLabResults, type LabResultRow } from '../../quality/lab/results-store'
import { postMoves, type MoveDraft } from '../ledger/post-moves'
import { lockHideTags } from '../receipts/store'
import { readOpeningFacts } from './facts'

/**
 * One line of opening stock, written inside the import's apply batch (one command per batch; the imports engine,
 * platform/imports): the line is judged again on the facts as they are now (factory-domain inventory/opening/rules), then
 *
 *   1. the lot: the opening lot of the line's site, material, colour and lot code under its advisory lock (two imports
 *      never make it twice), its row locked when it exists (a release decided meanwhile is seen); else a new one numbered
 *      from the company's LOT series, started as the receipts rules say, its creator the importer (the person who
 *      applied the import, else the one who started it): the lab step's four-eyes check keeps them from releasing it;
 *   2. the existing report: the lot's Cr VI columns and the LabResult through the lab step's seam (processLabResults),
 *      on the report file of the company's opening-stock reports, kept ten years (REACH art. 36); never a release;
 *   3. the hides, tagged with the tenant's HIDE scan ids (the receipts' hide-tag lock);
 *   4. the OPENING moves through the ledger's postMoves, each with the line's own idempotency key (a line posts once,
 *      whatever import brings it again: the ledger refuses a key used before), valued at the given unit cost (MANUAL)
 *      or the standard cost;
 *   5. audit rows and the events inventory.opening_posted (and lot.test_recorded with a report).
 */

const REPORT_RETENTION_YEARS = 10
const RETENTION_WHY = 'REACH art. 36: the chromium VI evidence of a lot is kept at least ten years.'
const RELEASED_NOTE = 'Opening stock: released at import, no chromium VI test, certificate check or quality hold needed.'

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** The importer of a job: the person who applied it, else the one who started it (a job started to apply at once). */
async function importerOf(tools: CommandTools): Promise<{ jobId: string; importerId: string | null }> {
  const jobId = tools.record?.type === 'ImportJob' ? tools.record.id : null
  if (!jobId) throw new InvalidStateError('Opening stock is posted only by an import job.')
  const job = await tools.tx.importJob.findUniqueOrThrow({ where: { id: jobId }, select: { createdById: true, applyRequestedById: true } })
  return { jobId, importerId: job.applyRequestedById ?? job.createdById }
}

/** The tenant's lock of one opening lot (its company, site, material, colour and lot code), so two imports make it once. */
async function lockOpeningLot(tools: CommandTools, tenantId: string, companyId: string, values: RowValues): Promise<void> {
  const key = ['factory.opening-lot', tenantId, companyId, text(values.site), text(values.item), text(values.colour) ?? '-', text(values.lot)].join('|')
  await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

async function lotNumber(tools: CommandTools, companyId: string, lotId: string, day: string): Promise<string> {
  try {
    return (await allocateNumber(tools, { companyId, kind: 'LOT' }, { type: 'Lot', id: lotId, date: day })).formatted
  } catch (error) {
    if (error instanceof NotFoundError) throw new InvalidStateError(`${error.message} (lots are numbered from it).`)
    throw error
  }
}

/** Writes one planned line; answers the line's lot (or, untracked, its move). */
export async function postOpeningLine(tools: CommandTools, line: string, values: RowValues, companyId: string): Promise<{ recordId: string }> {
  const { tx, now, context } = tools
  // The import's apply runs as the tenant's system (the worker); never a floor, partner or link session.
  if (context.audience !== 'system' && context.audience !== 'office') throw new ForbiddenError('Opening stock is posted by the office or its import.')
  const tenantId = context.tenantId
  const { jobId, importerId } = await importerOf(tools)
  const today = businessDate(now)
  const options = { tenantId, companyId, today, reaches: () => true }
  if (text(values.lot) !== null) await lockOpeningLot(tools, tenantId, companyId, values)
  let [facts] = await readOpeningFacts(tx, [values], options)
  if (facts!.lot) {
    // The lot's row first: a release or a rejection that committed meanwhile is read below, under the lock.
    await tx.$queryRaw`SELECT "id" FROM "Lot" WHERE "id" = ${facts!.lot.id}::uuid FOR UPDATE`
    ;[facts] = await readOpeningFacts(tx, [values], options)
  }
  const { problems, plan } = planOpeningRow(values, facts!)
  if (!plan) throw new ConflictError(`Line ${line} no longer fits: ${problems.map((problem) => problem.message).join(' ')} Run the dry run again.`)

  const site = facts!.site!
  const item = facts!.item!
  const colourId = text(values.colour) ? (item.colours.find((colour) => colour.code === text(values.colour))?.id ?? null) : null
  const at = (day: string | null) => (day ? businessDayStart(day) : now)

  // 1. The lot.
  let lot: { id: string; code: string; newLot: boolean; qualityStatus: string; crViStatus: string; shade: string | null } | null = null
  if (plan.lot?.kind === 'NEW') {
    const id = newId()
    const code = await lotNumber(tools, companyId, id, today)
    if (await tx.lot.findFirst({ where: { code }, select: { id: true } })) {
      throw new InvalidStateError(`Lot number ${code} is another company's lot already: give each company's LOT series its own prefix (an admin, under numbering).`)
    }
    const { start } = plan.lot
    const released = start.qualityStatus === 'RELEASED'
    await tx.lot.create({
      data: {
        id,
        companyId,
        siteId: site.id,
        itemId: item.id,
        itemColourId: colourId,
        code,
        supplierId: plan.lot.supplierId,
        supplierLotRef: plan.lot.supplierLotRef,
        dyeBatch: plan.lot.dyeBatch,
        shade: plan.lot.shade,
        receiptLineId: null,
        receivedAt: at(plan.lot.receivedOn),
        qualityStatus: start.qualityStatus,
        qualityNote: released ? RELEASED_NOTE : null,
        qualityDecidedAt: released ? now : null,
        qualityDecidedById: released ? importerId : null,
        requiresCrViTest: start.requiresCrViTest,
        crViLimitMgKg: start.crViLimitMgKg,
        crViStatus: start.crViStatus,
        createdAt: now,
        updatedAt: now,
        createdById: importerId,
      },
      select: { id: true },
    })
    tools.audit({
      action: 'inventory.importOpeningLot',
      recordType: 'Lot',
      recordId: id,
      companyId,
      siteId: site.id,
      after: { code, line, jobId, itemId: item.id, itemColourId: colourId, supplierId: plan.lot.supplierId, supplierLotRef: plan.lot.supplierLotRef, dyeBatch: plan.lot.dyeBatch, shade: plan.lot.shade, receivedOn: plan.lot.receivedOn, ...start, certificate: text(values.certificate) },
    })
    lot = { id, code, newLot: true, qualityStatus: start.qualityStatus, crViStatus: start.crViStatus, shade: plan.lot.shade }
  } else if (plan.lot?.kind === 'JOIN') {
    const row = await tx.lot.findUniqueOrThrow({ where: { id: plan.lot.lotId }, select: { id: true, code: true, qualityStatus: true, crViStatus: true, shade: true } })
    lot = { ...row, newLot: false }
  }

  // 2. The existing report.
  let resultId: string | null = null
  if (plan.result && lot) {
    resultId = await recordResult(tools, plan.result, { lotId: lot.id, code: lot.code, siteId: site.id, itemId: item.id, companyId, line, jobId, importerId })
    lot = { ...lot, crViStatus: plan.result.effect.crViStatus, qualityStatus: plan.result.effect.qualityStatus }
  }

  // 3. The hides.
  const hideIds: string[] = []
  if (plan.hides.length > 0 && lot) {
    const tags = nextHideTags(tenantId, await lockHideTags(tx, tenantId), plan.hides.length)
    for (const [index, hide] of plan.hides.entries()) {
      const id = newId()
      await tx.hide.create({
        data: {
          id,
          siteId: site.id,
          lotId: lot.id,
          itemId: item.id,
          code: tags[index]!,
          supplierCode: hide.supplierCode,
          area: hide.area,
          areaUom: plan.unit,
          baseArea: hide.baseArea,
          grade: hide.grade,
          shade: lot.shade,
          thicknessMm: hide.thicknessMm,
          defects: hide.defects,
          createdAt: now,
          updatedAt: now,
          createdById: importerId,
        },
        select: { id: true },
      })
      tools.audit({
        action: 'inventory.importOpeningHide',
        recordType: 'Hide',
        recordId: id,
        companyId,
        siteId: site.id,
        after: { code: tags[index]!, lotId: lot.id, line, supplierCode: hide.supplierCode, area: hide.area, areaUom: plan.unit, baseArea: hide.baseArea, grade: hide.grade, thicknessMm: hide.thicknessMm },
      })
      hideIds.push(id)
    }
  }

  // 4. The OPENING moves, each with the line's own key.
  const moves = await postMoves(tools, draftsOf(plan, { siteId: site.id, itemId: item.id, colourId, lotId: lot?.id ?? null, hideIds, locationId: facts!.location!.id, companyId, line, occurredAt: at(plan.stockDate) }), {
    issuePath: (index) => `line/${line}/moves/${index}`,
  })

  tools.emit({
    type: 'inventory.opening_posted',
    subject: lot?.id ?? moves[0]!.id,
    companyId,
    siteId: site.id,
    payload: {
      jobId,
      line,
      itemId: item.id,
      lotId: lot?.id ?? null,
      lotCode: lot?.code ?? null,
      newLot: lot?.newLot ?? false,
      qualityStatus: (lot?.qualityStatus ?? null) as 'QUARANTINE' | 'RELEASED' | 'REJECTED' | 'BLOCKED' | null,
      crViStatus: (lot?.crViStatus ?? null) as 'NOT_REQUIRED' | 'PENDING' | 'PASS' | 'FAIL' | null,
      resultId,
      hideIds,
      moveIds: moves.map((move) => move.id),
      baseQuantity: plan.baseQuantity,
    },
  })
  return { recordId: lot?.id ?? moves[0]!.id }
}

function draftsOf(
  plan: OpeningPlan,
  at: { siteId: string; itemId: string; colourId: string | null; lotId: string | null; hideIds: readonly string[]; locationId: string; companyId: string; line: string; occurredAt: Date },
): MoveDraft[] {
  const move = (n: number, fields: Pick<MoveDraft, 'hideId' | 'quantity' | 'baseQuantity'>): MoveDraft => ({
    siteId: at.siteId,
    reason: 'OPENING',
    itemId: at.itemId,
    itemColourId: at.colourId,
    lotId: at.lotId,
    toLocationId: at.locationId,
    uom: plan.unit as Uom,
    reference: at.line,
    occurredAt: at.occurredAt,
    idempotencyKey: openingMoveKey(at.companyId, at.line, n),
    cost: plan.cost,
    ...fields,
  })
  if (plan.hides.length > 0) return plan.hides.map((hide, index) => move(index + 1, { hideId: at.hideIds[index]!, quantity: hide.area, baseQuantity: hide.baseArea }))
  return [move(1, { hideId: null, quantity: plan.quantity, baseQuantity: plan.baseQuantity })]
}

/** The lot's Cr VI columns and its LabResult (the lab step's seam), the report kept ten years, lot.test_recorded. */
async function recordResult(
  tools: CommandTools,
  planned: PlannedResult,
  lot: { lotId: string; code: string; siteId: string; itemId: string; companyId: string; line: string; jobId: string; importerId: string | null },
): Promise<string> {
  const { tx, now } = tools
  const { input, verdict, effect, fileId } = planned
  const before = await tx.lot.findUniqueOrThrow({ where: { id: lot.lotId }, select: { crViStatus: true, qualityStatus: true } })
  await tx.lot.update({
    where: { id: lot.lotId },
    data: { crViStatus: effect.crViStatus, crViMgKg: verdict.valueMgKg, crViEvidence: input.evidence, crViTestedAt: new Date(`${input.testedOn}T00:00:00.000Z`), version: { increment: 1 } },
    select: { id: true },
  })
  const row: LabResultRow = {
    id: newId(),
    lotId: lot.lotId,
    companyId: lot.companyId,
    siteId: lot.siteId,
    itemId: lot.itemId,
    test: 'CR_VI',
    method: input.method as CrViMethod,
    valueMgKg: verdict.valueMgKg,
    belowDetectionLimit: verdict.belowDetectionLimit,
    detectionLimitMgKg: verdict.detectionLimitMgKg,
    unit: CR_VI_UNIT,
    limitMgKg: verdict.limitMgKg,
    verdict: verdict.verdict,
    lab: input.lab.trim(),
    reportNumber: input.reportNumber ?? null,
    testedOn: input.testedOn,
    evidence: input.evidence,
    article: input.article ?? null,
    periodFrom: input.periodFrom ?? null,
    periodTo: input.periodTo ?? null,
    fileId,
    supersedesId: null,
    note: `Existing report, brought with the opening stock (line ${lot.line}).`,
    createdAt: toUtcIso(now),
    createdById: lot.importerId,
  }
  await processLabResults().record(tools, row)
  await retainFilesInCommand(tools, [fileId], addYears(now, REPORT_RETENTION_YEARS), RETENTION_WHY)
  tools.audit({
    action: 'inventory.importOpeningResult',
    recordType: 'Lot',
    recordId: lot.lotId,
    companyId: lot.companyId,
    siteId: lot.siteId,
    before: { crViStatus: before.crViStatus, qualityStatus: before.qualityStatus },
    after: { crViStatus: effect.crViStatus, crViMgKg: verdict.valueMgKg, crViEvidence: input.evidence, crViTestedAt: input.testedOn, qualityStatus: effect.qualityStatus, resultId: row.id, verdict: verdict.verdict, line: lot.line, jobId: lot.jobId },
  })
  tools.emit({
    type: 'lot.test_recorded',
    subject: lot.lotId,
    companyId: lot.companyId,
    siteId: lot.siteId,
    payload: { lotId: lot.lotId, code: lot.code, resultId: row.id, test: 'CR_VI', verdict: verdict.verdict, evidence: input.evidence, fileId, crViStatus: effect.crViStatus, qualityStatus: effect.qualityStatus, laterFail: false },
  })
  return row.id
}
