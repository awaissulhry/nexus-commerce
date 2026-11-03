import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { areaIn, type AreaUom } from '@nexus/factory-domain/inventory/hides/area'
import { gradeChoiceProblem, shadeChoiceProblem } from '@nexus/factory-domain/inventory/hides/grading'
import { areaCheck, measureRefusal } from '@nexus/factory-domain/inventory/hides/measure'
import { activeRules, gradesForArticle } from '@nexus/factory-domain/inventory/hides/usable'
import { QUALITY_INCOMING_RECORD } from '@nexus/factory-domain/quality/incoming/permissions'
import { foundOf, hideDraftProblems, markProblems, resultProblems, type CheckOutcome, type HideDraft, type MarkDraft, type ResultDraft, type UnitDecision } from '@nexus/factory-domain/quality/incoming/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { areaUom, gradesOf, HIDE_SELECT, ruleFactsOf, rulesOf, toleranceOfLot } from '../../inventory/hides/facts'
import { insertMeasureInCommand } from '../../inventory/hides/measures'
import { assertFloorReady } from '../../production/serials/facts'
import { postedBy, signerOf, type Inspector } from '../final/access'
import { checkFactsOf, classOfDefect, defectsByCode, marksOf, readAnswers, readChecks } from './facts'
import { viewOf } from './views'
import { assertOpen, assertOwn, incomingFor, lockIncoming, lotOf, readResults, RESULT_COLUMNS, takeOver, type IncomingRow, type LotRow, type Subject } from './store'
import type { RecordedWhat } from '@nexus/factory-domain/quality-incoming/events'

/**
 * Recording an incoming inspection hide by hide (B-W2b-98; QHS-025 area against the tannery, QHS-028 shade group against
 * the swatch, MES-054 defect marks and zones on the hide map; design floor.incoming "Hide by hide": "Measured area against
 * the tannery's declared area", "Shade group tiles against the master swatch (1, 2, 3, out of shade)", "HideMap: tap the
 * hide's outline or photo to place defect marks and draw zones A, B, C", "Accept or Reject the hide"). Office and the
 * site's inspection tablet, its inspector only (anyone with the permission takes an inspection nobody took). Each write is
 * ONE command at the inspection's version (its row FOR UPDATE), with its audit row and event.
 *
 *   PUT    …/:inspectionId/hides/:hideId   a hide of the lot into the sample, or its result changed: a WHOLE hide (only a full
 *                                          hide is measured against the tannery) while the sample is not full; the area
 *                                          measured now (a HideMeasure naming the inspection, the one writer of the
 *                                          append-only table, inventory/hides `insertMeasureInCommand`: the lot's area
 *                                          check counts it at once), else the area it was received with stands; its shade
 *                                          group (the article's, of its colour and lot) and grade (the article's) as
 *                                          records; its marks (defects of the library, zones of a grade); accepted,
 *                                          rejected or to sort. The found counts follow from every hide's marks (a hide
 *                                          once, under its worst class).
 *   DELETE …/:inspectionId/hides/:hideId   a hide taken out of the sample (a measure taken stays: it is a true measure).
 *   PUT    …/:inspectionId/results         the plan checks' answers, the whole list (kept by check and unit).
 *
 * The hide's own grade and shade, and its marks as HideMark rows, are written when the decision is signed (./decide.ts).
 */

export const invalid = (problems: readonly Issue[], words: string) =>
  new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: problem.path.startsWith('body/') ? problem.path : `body/${problem.path}` })))

/** The inspection, its lot or workshop receipt, and the caller, checked for a write (its inspector, OPEN, the floor ready at the site). */
export async function writable(caller: CommandCaller, inspectionId: string): Promise<{ row: IncomingRow; lot: LotRow | null; receipt: Subject['receipt']; context: Inspector }> {
  const found = await incomingFor(caller, inspectionId, QUALITY_INCOMING_RECORD)
  assertOwn(found.context, found.row)
  assertOpen(found.row)
  if (found.context.audience === 'floor') await assertFloorReady(caller, found.row.siteId)
  return found
}

/** The found counts from every hide's marks, written on the inspection with the caller taking it, and the version bumped. */
async function afterUnits(tools: CommandTools, context: Inspector, row: IncomingRow): Promise<void> {
  const results = await readResults(tools.tx, row.id)
  const marks = results.map((result) => marksOf(result.marks))
  const defects = await defectsByCode(tools.tx, marks.flat().flatMap((mark) => (mark.kind === 'DEFECT' && mark.code ? [mark.code] : [])))
  const found = foundOf(marks.map((list) => ({ classes: list.flatMap((mark) => (mark.kind === 'DEFECT' && mark.code ? [classOfDefect(defects.get(mark.code))] : [])) })))
  await tools.tx.incomingInspection.update({
    where: { id: row.id },
    data: { foundCritical: found.critical, foundMajor: found.major, foundMinor: found.minor, ...takeOver(context, row), version: { increment: 1 }, updatedAt: tools.now },
    select: { id: true },
  })
}

export const recorded = (tools: CommandTools, row: IncomingRow, what: RecordedWhat, hideId: string | null, done: number) =>
  tools.emit({ type: 'incoming_inspection.recorded', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { incomingInspectionId: row.id, number: row.number, lotId: row.lotId, subcontractReceiptId: row.subcontractReceiptId, what, hideId, done, sampleSize: row.sampleSize } })

/** The marks against the library and the grades: a defect of the library (never a category), a zone of a grade in use. */
async function markIssues(tools: CommandTools, marks: readonly MarkDraft[], kept: readonly MarkDraft[]): Promise<Issue[]> {
  const issues: Issue[] = []
  const defects = await defectsByCode(tools.tx, marks.flatMap((mark) => (mark.kind === 'DEFECT' && mark.code ? [mark.code.trim()] : [])))
  const zoneCodes = [...new Set(marks.flatMap((mark) => (mark.zone ? [mark.zone.trim()] : [])))]
  const grades = new Map((zoneCodes.length ? await tools.tx.leatherGrade.findMany({ where: { code: { in: zoneCodes } }, select: { code: true, active: true } }) : []).map((grade) => [grade.code, grade]))
  const keptDefects = new Set(kept.flatMap((mark) => (mark.code ? [mark.code] : [])))
  const keptZones = new Set(kept.flatMap((mark) => (mark.zone ? [mark.zone] : [])))
  marks.forEach((mark, index) => {
    const code = mark.code?.trim()
    if (mark.kind === 'DEFECT' && code) {
      const defect = defects.get(code)
      if (!defect) issues.push({ path: `marks/${index}/code`, message: `${code} is not a defect of the library.` })
      else if (defect.parentId === null) issues.push({ path: `marks/${index}/code`, message: `${code} is a category: pick one of its defects.` })
      // A retired defect stays on a mark that has it (only a new pick is refused).
      else if (!defect.active && !keptDefects.has(code)) issues.push({ path: `marks/${index}/code`, message: `${code} is retired: it is no longer picked.` })
    }
    const zone = mark.zone?.trim()
    if (zone) {
      const grade = grades.get(zone)
      if (!grade) issues.push({ path: `marks/${index}/zone`, message: `${zone} is not a leather grade.` })
      else if (!grade.active && !keptZones.has(zone)) issues.push({ path: `marks/${index}/zone`, message: `Grade ${zone} is retired: it is no longer picked.` })
    }
  })
  return issues
}

const cleanMarks = (marks: readonly MarkDraft[]): Prisma.InputJsonValue =>
  marks.map((mark) => ({
    kind: mark.kind,
    x: mark.x,
    y: mark.y,
    ...(mark.code?.trim() ? { code: mark.code.trim() } : {}),
    ...(mark.zone?.trim() ? { zone: mark.zone.trim() } : {}),
    ...(mark.kind === 'ZONE' ? { outline: (mark.outline ?? []).map((point) => ({ x: point.x, y: point.y })) } : {}),
    ...(mark.note?.trim() ? { note: mark.note.trim() } : {}),
  }))

export interface HideBody extends HideDraft {
  readonly version: number
  /** The shade group against the master swatch (null clears it); left out: as it is. */
  readonly shadeGroupId?: string | null | undefined
  /** The grade (null clears it); left out: as it is. */
  readonly gradeId?: string | null | undefined
  /** The whole list of marks on the hide; left out: as they are. */
  readonly marks?: readonly MarkDraft[] | undefined
}

/** PUT /quality/incoming/:inspectionId/hides/:hideId */
export async function putHide(caller: CommandCaller, inspectionId: string, hideId: string, body: HideBody, idempotencyKey: string | undefined) {
  const found = await writable(caller, inspectionId)
  const { row: seen, context } = found
  const lot = lotOf(seen, found, 'hides')
  if (seen.uom !== 'HIDE') throw new ConflictError(`Incoming inspection ${seen.number} counts ${seen.uom}, not hides: it is not inspected hide by hide.`)
  const shape = [...hideDraftProblems(body), ...(body.marks ? markProblems(body.marks) : [])]
  if (shape.length > 0) throw invalid(shape, 'The hide is not valid.')
  const { result } = await command(caller, { name: 'quality.incoming.recordHide', idempotencyKey, input: { inspectionId, hideId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockIncoming(tx, seen.id, body.version)
    const hide = isUuid(hideId) ? await tx.hide.findUnique({ where: { id: hideId }, select: HIDE_SELECT }) : null
    if (!hide || hide.lotId !== lot.id) throw new NotFoundError(`Hide not found in lot ${lot.code}.`)
    const existing = await tx.incomingHideResult.findFirst({ where: { incomingInspectionId: row.id, hideId: hide.id }, select: RESULT_COLUMNS })
    const all = await tx.incomingHideResult.findMany({ where: { incomingInspectionId: row.id }, select: { seq: true } })
    if (!existing) {
      // QHS-025: the sample is of whole hides (only a full hide is measured against the tannery's area).
      const refusal = measureRefusal(hide)
      if (refusal) throw new ConflictError(`${refusal} The sample takes whole hides only.`)
      if (all.length >= row.sampleSize) throw new ConflictError(`The sample is ${row.sampleSize} ${row.sampleSize === 1 ? 'hide' : 'hides'}: all are recorded. Take one out first.`)
    }
    const problems: Issue[] = []
    // The shade group (QHS-028) and the grade, as records of the hide's article.
    let shade = { label: existing?.shadeGroup ?? null, id: existing?.shadeRecordId ?? null }
    if (body.shadeGroupId !== undefined) {
      if (body.shadeGroupId === null) shade = { label: null, id: null }
      else {
        const group = isUuid(body.shadeGroupId) ? await tx.shadeGroup.findUnique({ where: { id: body.shadeGroupId }, select: { id: true, itemId: true, itemColourId: true, lotId: true, label: true, active: true } }) : null
        const problem = group ? shadeChoiceProblem(group, { itemId: hide.itemId, lotId: hide.lotId, itemColourId: hide.lot.itemColourId, shadeGroupId: hide.shadeGroupId ?? existing?.shadeRecordId ?? null, code: hide.code }) : 'Not a shade group of the tenant.'
        if (problem) problems.push({ path: 'shadeGroupId', message: problem })
        else shade = { label: group!.label, id: group!.id }
      }
    }
    let grade = { code: existing?.grade ?? null, id: existing?.gradeRecordId ?? null }
    if (body.gradeId !== undefined) {
      if (body.gradeId === null) grade = { code: null, id: null }
      else {
        const grades = await gradesOf(tx)
        const rules = activeRules(((await rulesOf(tx, [hide.itemId])).get(hide.itemId) ?? []).map(ruleFactsOf))
        const chosen = isUuid(body.gradeId) ? grades.find((entry) => entry.id === body.gradeId) : undefined
        const problem = chosen ? gradeChoiceProblem(chosen, hide.gradeId ?? existing?.gradeRecordId ?? null, gradesForArticle(grades, rules), hide.lot.item.code) : 'Not a grade of the tenant.'
        if (problem) problems.push({ path: 'gradeId', message: problem })
        else grade = { code: chosen!.code, id: chosen!.id }
      }
    }
    const kept = existing ? marksOf(existing.marks) : []
    const marks = body.marks ?? kept
    if (body.marks) problems.push(...(await markIssues(tools, body.marks, kept)))
    if (problems.length > 0) throw invalid(problems, 'The hide is not valid.')

    // The area: measured now (a new measure when it differs from the last one taken here), else as it stands.
    const unit: AreaUom = body.measuredArea ? (body.areaUom as AreaUom) : existing ? areaUom(existing.areaUom) : areaUom(hide.areaUom)
    const measuredArea = body.measuredArea ? new Dec(body.measuredArea.trim()).toFixed(4) : existing ? existing.measuredArea.toFixed(4) : new Dec(hide.area.toString()).toFixed(4)
    const declaredArea = body.measuredArea ? (body.declaredArea?.trim() ? new Dec(body.declaredArea.trim()).toFixed(4) : null) : (existing?.declaredArea?.toFixed(4) ?? null)
    const changedArea = Boolean(body.measuredArea) && (!existing || existing.measuredArea.toFixed(4) !== measuredArea || (existing.declaredArea?.toFixed(4) ?? null) !== declaredArea || existing.areaUom !== unit)
    if (changedArea) {
      const signer = signerOf(context)
      const measure = await insertMeasureInCommand(tools, hide, {
        measuredArea,
        areaUom: unit,
        declaredArea,
        measuredAt: now,
        note: null,
        incomingInspectionId: row.id,
        by: context.audience === 'floor' ? { workerId: signer.workerId!, deviceId: context.deviceId } : { userId: signer.userId! },
      })
      const tolerance = await toleranceOfLot(tx, lot.id)
      const declared = declaredArea ?? areaIn(hide.area.toString(), areaUom(hide.areaUom), unit).toFixed(4)
      tools.emit({
        type: 'inventory.hide_measured',
        subject: hide.id,
        companyId: lot.companyId,
        siteId: lot.siteId,
        payload: { hideId: hide.id, lotId: lot.id, itemId: hide.itemId, measureId: measure.id, outcome: areaCheck(declared, measuredArea, tolerance.percent).outcome, moveId: null },
      })
    }
    const data = {
      declaredArea,
      measuredArea,
      areaUom: unit,
      shadeGroup: shade.label,
      shadeRecordType: shade.id ? 'ShadeGroup' : null,
      shadeRecordId: shade.id,
      grade: grade.code,
      gradeRecordType: grade.id ? 'LeatherGrade' : null,
      gradeRecordId: grade.id,
      marks: cleanMarks(marks),
      decision: body.decision === undefined ? ((existing?.decision as UnitDecision | null) ?? null) : body.decision,
      note: body.note === undefined ? (existing?.note ?? null) : body.note?.trim() || null,
    }
    if (existing) await tx.incomingHideResult.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    else
      await tx.incomingHideResult.create({
        data: { id: newId(), siteId: row.siteId, incomingInspectionId: row.id, lotId: lot.id, hideId: hide.id, seq: Math.max(0, ...all.map((entry) => entry.seq)) + 1, ...data, createdAt: now, updatedAt: now, createdById: context.actorId },
        select: { id: true },
      })
    await afterUnits(tools, context, row)
    tools.audit({
      recordType: 'IncomingInspection',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before: existing ? { hide: hide.code, measuredArea: existing.measuredArea.toFixed(4), areaUom: existing.areaUom, shadeGroup: existing.shadeGroup, grade: existing.grade, marks: existing.marks, decision: existing.decision } : { hide: hide.code, inSample: false },
      after: { hide: hide.code, measuredArea, declaredArea, areaUom: unit, measured: changedArea, shadeGroup: shade.label, grade: grade.code, marks: data.marks, decision: data.decision, by: postedBy(context) },
    })
    recorded(tools, row, 'HIDE', hide.id, all.length + (existing ? 0 : 1))
    return { id: row.id }
  })
  return viewOf(caller, result.id, { lot, receipt: null }, context)
}

/** DELETE /quality/incoming/:inspectionId/hides/:hideId?version= */
export async function removeHide(caller: CommandCaller, inspectionId: string, hideId: string, version: number, idempotencyKey: string | undefined) {
  const found = await writable(caller, inspectionId)
  const { row: seen, context } = found
  const lot = lotOf(seen, found, 'hides')
  const { result } = await command(caller, { name: 'quality.incoming.removeHide', idempotencyKey, input: { inspectionId, hideId, version } }, async (tools) => {
    const row = await lockIncoming(tools.tx, seen.id, version)
    const existing = isUuid(hideId) ? await tools.tx.incomingHideResult.findFirst({ where: { incomingInspectionId: row.id, hideId }, select: { ...RESULT_COLUMNS, hide: { select: { code: true } } } }) : null
    if (!existing) throw new NotFoundError('This hide is not in the sample.')
    await tools.tx.incomingHideResult.delete({ where: { id: existing.id }, select: { id: true } })
    await afterUnits(tools, context, row)
    tools.audit({ recordType: 'IncomingInspection', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { hide: existing.hide.code, inSample: true, decision: existing.decision, marks: existing.marks }, after: { hide: existing.hide.code, inSample: false } })
    recorded(tools, row, 'HIDE_REMOVED', hideId, await tools.tx.incomingHideResult.count({ where: { incomingInspectionId: row.id } }))
    return { id: row.id }
  })
  return viewOf(caller, result.id, { lot, receipt: null }, context)
}

export interface ResultsBody {
  readonly version: number
  readonly results: readonly ResultDraft[]
}

/** PUT /quality/incoming/:inspectionId/results — the plan checks' answers, the whole list. */
export async function putResults(caller: CommandCaller, inspectionId: string, body: ResultsBody, idempotencyKey: string | undefined) {
  const { row: seen, lot, receipt, context } = await writable(caller, inspectionId)
  const { result } = await command(caller, { name: 'quality.incoming.recordResults', idempotencyKey, input: { inspectionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockIncoming(tx, seen.id, body.version)
    const checks = new Map((await readChecks(tx, row.planVersionId)).map((check) => [check.id, checkFactsOf(check)]))
    const problems = resultProblems(body.results, checks, row.sampleSize)
    if (problems.length > 0) throw invalid(problems, 'The results are not valid.')
    const existing = await readAnswers(tx, row.id)
    const key = (planCheckId: string, unit: number) => `${planCheckId}|${unit}`
    const wanted = new Map(body.results.map((entry) => [key(entry.planCheckId, entry.sampleIndex ?? 1), entry]))
    for (const answer of existing) if (!wanted.has(key(answer.planCheckId, answer.sampleIndex))) await tx.inspectionCheckResult.delete({ where: { id: answer.id }, select: { id: true } })
    const signer = signerOf(context)
    const by = { recordedById: signer.userId, recordedByWorkerId: signer.workerId, deviceId: context.audience === 'floor' ? context.deviceId : null }
    for (const entry of body.results) {
      const unit = entry.sampleIndex ?? 1
      const data = { outcome: entry.outcome as CheckOutcome, value: entry.outcome === 'NOT_APPLICABLE' ? (entry.value?.trim() || null) : entry.value?.trim() || null, note: entry.note?.trim() || null }
      const answer = existing.find((row2) => key(row2.planCheckId, row2.sampleIndex) === key(entry.planCheckId, unit))
      if (answer) {
        if (answer.outcome !== data.outcome || answer.value !== data.value || answer.note !== data.note) await tx.inspectionCheckResult.update({ where: { id: answer.id }, data: { ...data, ...by, recordedAt: now, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      } else {
        await tx.inspectionCheckResult.create({ data: { id: newId(), siteId: row.siteId, incomingInspectionId: row.id, planCheckId: entry.planCheckId, sampleIndex: unit, ...data, ...by, recordedAt: now, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
      }
    }
    await tx.incomingInspection.update({ where: { id: row.id }, data: { ...takeOver(context, row), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({
      recordType: 'IncomingInspection',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before: { results: existing.map((answer) => ({ planCheckId: answer.planCheckId, sampleIndex: answer.sampleIndex, outcome: answer.outcome, value: answer.value })) },
      after: { results: body.results.map((entry) => ({ planCheckId: entry.planCheckId, sampleIndex: entry.sampleIndex ?? 1, outcome: entry.outcome, value: entry.value ?? null })), by: postedBy(context) },
    })
    recorded(tools, row, 'RESULTS', null, (await tx.incomingHideResult.count({ where: { incomingInspectionId: row.id } })) + (await tx.incomingRollResult.count({ where: { incomingInspectionId: row.id } })))
    return { id: row.id }
  })
  return viewOf(caller, result.id, { lot, receipt }, context)
}
