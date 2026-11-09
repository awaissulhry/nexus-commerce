import type { Prisma } from '@nexus/factory-db'
import { actorOf } from '../../../core/context'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { areaIn, isAreaUom, type AreaUom } from '@nexus/factory-domain/inventory/hides/area'
import { areaCheck, lotCheck, type MeasuredHide } from '@nexus/factory-domain/inventory/hides/measure'
import { activeRules, gradesForArticle } from '@nexus/factory-domain/inventory/hides/usable'
import { shadeGroupsFor } from '@nexus/factory-domain/inventory/hides/grading'
import type { InspectionLevel } from '@nexus/factory-domain/quality/aql/iso2859'
import { aqlResult } from '@nexus/factory-domain/quality/aql/result'
import { aqlWords } from '@nexus/factory-domain/quality/aql/sampling'
import { QUALITY_INCOMING_RECORD, QUALITY_INCOMING_VIEW } from '@nexus/factory-domain/quality/incoming/permissions'
import { nextStepOf, nextWords, sampleWords, worstClass, type UnitDecision } from '@nexus/factory-domain/quality/incoming/rules'
import {
  certificateCheck,
  COMPONENT_WORDS,
  componentVerdict,
  FOUR_POINT_LIMIT,
  heldWords,
  isRollLot,
  POINT_CLASSES,
  pointsOf,
  receiptLotOf,
  receiptNextWords,
  receiptSplit,
  rollSampleWords,
  rollSummary,
  rollVerdict,
  type ComponentKind,
} from '@nexus/factory-domain/quality/incoming/units'
import { UNITS } from '@nexus/factory-domain/product/units/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { gradesOf, ruleFactsOf, rulesOf, toleranceOfLot } from '../../inventory/hides/facts'
import { workerGateFor } from '../../people/privacy/worker-gate'
import { planOfProfile, planView, resultView } from '../aql/chain'
import { inspectorOf, mayOn, type Inspector } from '../final/access'
import { certificateExtras, type CertificateExtras } from './certificates'
import { classOfDefect, hideDefectsOf, readComponents, readRolls, sampleFactsOf, type SampleFacts } from './facts'
import { incomingFor, isOwn, readIncoming, receiptAs, type IncomingRow, type Reader, type Subject } from './store'

/**
 * What the screens read of an incoming inspection (B-W2b-98; design floor.incoming Sample, Hide by hide, Decision; quality
 * .inspections "Incoming"): the record with its sample in words, the AQL result now, every hide of the sample with its
 * area against the tannery, its shade group, grade and marks, the plan checks with their answers, the lot's area check
 * from the hides measured in it, what the bench picks from (shade tiles, grades, hide defects, the lot's hides not in the
 * sample yet), and after the decision what comes next (the lot waits for the quality role; hold or return the rejected
 * hides; the claim for a short lot is purchasing's). No money anywhere; a person only inside the one record, and a floor
 * worker's name only where the site's PERFORMANCE gate is open (B-W2b-F3), never to a tablet.
 *
 * B-W2b-111: the fabric rolls by the 4-point system (points per 100 square yards per roll against the limit, the lot's
 * points over the rolls looked at), the component checks (what was read, the certificate and whether it holds, what the
 * row suggests), the defect counter of a lot not inspected hide by hide, and an inspection of goods back from a workshop:
 * the receipt with its lines (bundles: good, defective, scrapped there; reported at the operation, held, or rejected),
 * what the decision did (the bundles rejected, the rest gone on, the fee). A tablet reads the receipt and the register's
 * certificates as the tenant's system caller (store.ts receiptAs, certificates.ts); the workshop's name is the office's.
 */

const fixed4 = (value: Prisma.Decimal | string) => new Dec(value.toString()).toFixed(4)
const whole = (value: Prisma.Decimal) => new Dec(value.toString()).toFixed()
const areaUnit = (uom: string): AreaUom => (isAreaUom(uom) ? uom : 'M2')

/** The lot's hides measured in this inspection (a HideMeasure naming it). */
async function measuredHides(db: Reader, inspectionId: string): Promise<Set<string>> {
  return new Set((await db.hideMeasure.findMany({ where: { incomingInspectionId: inspectionId }, select: { hideId: true } })).map((row) => row.hideId))
}

async function inspectorView(db: Reader, row: IncomingRow, context: Inspector) {
  const kind = row.inspectorWorkerId ? ('FLOOR' as const) : row.inspectorUserId ? ('OFFICE' as const) : null
  // The floor reads no person's record (and no legal gate): the tablet says only who signed in is its inspector.
  if (context.audience !== 'office' || kind === null) return { kind, name: null, hidden: false }
  if (kind === 'OFFICE') return { kind, name: (await db.user.findUnique({ where: { id: row.inspectorUserId! }, select: { displayName: true } }))?.displayName ?? null, hidden: false }
  const gate = await workerGateFor(db, row.siteId)
  if (!gate.open) return { kind, name: null, hidden: true }
  return { kind, name: (await db.worker.findUnique({ where: { id: row.inspectorWorkerId! }, select: { displayName: true } }))?.displayName ?? null, hidden: false }
}

/** The record as every screen shows it. */
export async function incomingView(db: Reader, row: IncomingRow, subject: Subject, context: Inspector, extras: CertificateExtras) {
  const { lot, receipt } = subject
  const byHide = row.uom === 'HIDE' && lot !== null
  const byRoll = lot !== null && isRollLot(row.uom)
  const facts: SampleFacts = await sampleFactsOf(db, row, byHide)
  const version = await db.inspectionPlanVersion.findUnique({ where: { id: row.planVersionId }, select: { id: true, number: true, samplingMethod: true, fixedSampleSize: true, plan: { select: { id: true, code: true, name: true } } } })
  const profile = row.aqlProfileId ? await db.aqlProfile.findUnique({ where: { id: row.aqlProfileId }, select: { id: true, code: true, name: true, inspectionLevel: true, aqlMajor: true, aqlMinor: true, active: true } }) : null
  const lotWhole = new Dec(row.lotSize.toString())
  const aqlPlan = profile && lotWhole.isInteger() && lotWhole.greaterThanOrEqualTo(1) ? planView(planOfProfile(profile, Number(lotWhole.toFixed(0)))) : null
  const rollRows = await readRolls(db, row.id)
  const componentRows = await readComponents(db, row.id)
  // B-W2b-213: a lot counted on the AqlCounter (neither hide by hide nor roll by roll) has IncomingInspection.inspectedCount.
  const counted = !byHide && !byRoll && row.inspectedCount !== null
  const done = byRoll ? rollRows.length : counted ? row.inspectedCount! : facts.results.length
  const result = aqlResult({
    sampleSize: row.sampleSize,
    inspected: byHide || byRoll || counted ? Math.min(done, row.sampleSize) : null,
    classes: [
      { defectClass: 'CRITICAL', aql: '0', accept: 0, found: facts.found.critical },
      { defectClass: 'MAJOR', aql: row.aqlMajor === null ? '-' : aqlWords(row.aqlMajor.toString()), accept: row.acceptMajor ?? row.sampleSize, found: facts.found.major },
      { defectClass: 'MINOR', aql: row.aqlMinor === null ? '-' : aqlWords(row.aqlMinor.toString()), accept: row.acceptMinor ?? row.sampleSize, found: facts.found.minor },
    ],
    // As the database computes the incoming result: only a failed CRITICAL check fails the lot by itself.
    checks: { failed: facts.now.failedCritical, failedCritical: facts.now.failedCritical, mandatoryMissing: facts.now.mandatoryMissing },
  })

  // ---- the hides of the sample --------------------------------------------------------------------------------------------
  const hideIds = facts.results.map((entry) => entry.hideId)
  const hides = new Map((hideIds.length ? await db.hide.findMany({ where: { id: { in: hideIds } }, select: { id: true, code: true, state: true, area: true, areaUom: true } }) : []).map((hide) => [hide.id, hide]))
  const measured = await measuredHides(db, row.id)
  const tolerance = lot ? await toleranceOfLot(db, lot.id) : { percent: '2', from: 'DEFAULT' as const }
  const base: AreaUom = areaUnit(lot?.item.baseUom ?? 'M2')
  const forLot: MeasuredHide[] = []
  const shadeIds = facts.results.flatMap((entry) => (entry.shadeRecordId ? [entry.shadeRecordId] : []))
  const shades = new Map((shadeIds.length ? await db.shadeGroup.findMany({ where: { id: { in: shadeIds } }, select: { id: true, label: true, outOfShade: true } }) : []).map((group) => [group.id, group]))
  const hideRows = facts.results.map((entry) => {
    const hide = hides.get(entry.hideId)!
    const unit = areaUnit(entry.areaUom)
    const wasMeasured = measured.has(entry.hideId)
    const declared = entry.declaredArea !== null ? new Dec(entry.declaredArea.toString()) : areaIn(hide.area.toString(), areaUnit(hide.areaUom), unit)
    const check = wasMeasured ? areaCheck(declared, entry.measuredArea.toString(), tolerance.percent) : null
    if (wasMeasured) forLot.push({ hideId: hide.id, code: hide.code, declared: areaIn(declared, unit, base), measured: areaIn(entry.measuredArea.toString(), unit, base) })
    const marks = facts.marks.get(entry.id) ?? []
    return {
      id: entry.id,
      hideId: hide.id,
      code: hide.code,
      seq: entry.seq,
      state: hide.state,
      receivedArea: { area: fixed4(hide.area), uom: areaUnit(hide.areaUom) },
      measured: wasMeasured,
      declaredArea: entry.declaredArea === null ? null : fixed4(entry.declaredArea),
      measuredArea: fixed4(entry.measuredArea),
      areaUom: unit,
      areaCheck: check ? { declared: check.declared.toFixed(4), difference: check.difference.toFixed(4), differencePercent: check.differencePercent, outcome: check.outcome } : null,
      shadeGroup: entry.shadeRecordId ? { id: entry.shadeRecordId, label: entry.shadeGroup ?? shades.get(entry.shadeRecordId)?.label ?? '', outOfShade: shades.get(entry.shadeRecordId)?.outOfShade ?? false } : null,
      grade: entry.gradeRecordId ? { id: entry.gradeRecordId, code: entry.grade ?? '' } : null,
      marks: marks.map((mark) => {
        const defect = mark.kind === 'DEFECT' && mark.code ? facts.defects.get(mark.code) : undefined
        return {
          kind: mark.kind,
          x: mark.x,
          y: mark.y,
          code: mark.code ?? null,
          zone: mark.zone ?? null,
          outline: [...(mark.outline ?? [])],
          note: mark.note ?? null,
          defectClass: mark.kind === 'DEFECT' ? classOfDefect(defect) : null,
          labelIt: defect?.labelIt ?? null,
          labelEn: defect?.labelEn ?? null,
        }
      }),
      worstClass: worstClass(facts.classes.get(entry.id) ?? []),
      decision: (entry.decision as UnitDecision | null) ?? null,
      note: entry.note,
      version: entry.version,
    }
  })
  const lotArea = lotCheck(forLot, UNITS[base].symbol, tolerance.percent)
  const areaWords = (): { it: string; en: string } => {
    if (!lotArea.check) return { it: 'Nessuna pelle misurata in questa ispezione.', en: 'No hide measured in this inspection yet.' }
    if (lotArea.opensClaim) return { it: "Area sotto quella della conceria oltre la tolleranza: l'ufficio acquisti può aprire un reclamo al fornitore.", en: "Area short of the tannery's beyond the tolerance: purchasing may open a claim to the supplier." }
    return lotArea.check.outcome === 'OVER' ? { it: 'Area sopra quella della conceria oltre la tolleranza: nessun reclamo.', en: "Area above the tannery's beyond the tolerance: no claim." } : { it: 'Area entro la tolleranza: nessun reclamo.', en: 'Area within the tolerance: no claim.' }
  }

  // ---- B-W2b-111: rolls by the 4-point system ------------------------------------------------------------------------------
  const tagged = rollRows.flatMap((roll) => (roll.recordId ? [roll.recordId] : []))
  const tags = new Map((tagged.length ? await db.fabricRoll.findMany({ where: { id: { in: tagged } }, select: { id: true, code: true, state: true, supplierRollRef: true } }) : []).map((roll) => [roll.id, roll]))
  const rolls = rollRows.map((roll) => {
    const counts = { onePoint: roll.onePoint, twoPoint: roll.twoPoint, threePoint: roll.threePoint, fourPoint: roll.fourPoint }
    const per100 = roll.pointsPer100SqYd.toFixed(2)
    const tag = roll.recordId ? tags.get(roll.recordId) : undefined
    return {
      id: roll.id,
      rollRef: roll.rollRef,
      roll: tag ? { id: tag.id, code: tag.code, state: tag.state, supplierRollRef: tag.supplierRollRef } : null,
      ...counts,
      points: pointsOf(counts),
      widthCm: roll.widthCm.toFixed(2),
      lengthM: roll.lengthM.toFixed(2),
      pointsPer100SqYd: per100,
      verdict: rollVerdict(per100),
      decision: (roll.decision as UnitDecision | null) ?? null,
      note: roll.note,
      version: roll.version,
    }
  })
  const rollTotals = rollSummary(rolls.map((roll) => ({ onePoint: roll.onePoint, twoPoint: roll.twoPoint, threePoint: roll.threePoint, fourPoint: roll.fourPoint, widthCm: roll.widthCm, lengthM: roll.lengthM, decision: roll.decision })))

  // ---- B-W2b-111: components against spec and certificate ------------------------------------------------------------------
  const components = componentRows.map((component) => {
    const certificate = component.certificateId ? (extras.facts.get(component.certificateId) ?? null) : null
    const check = certificateCheck(component.kind as ComponentKind, certificate, extras.today)
    const verdict = componentVerdict({ kind: component.kind as ComponentKind, marking: component.marking, protectorType: component.protectorType, checkedQuantity: component.checkedQuantity, defectiveQuantity: component.defectiveQuantity }, check.state)
    return {
      id: component.id,
      seq: component.seq,
      kind: component.kind as ComponentKind,
      kindWords: COMPONENT_WORDS[component.kind as ComponentKind],
      marking: component.marking,
      protectorType: component.protectorType,
      size: component.size,
      certificate: certificate ? { id: certificate.id, number: certificate.number, standard: certificate.standard, validTo: certificate.validTo } : null,
      certificateCheck: check,
      checkedQuantity: component.checkedQuantity,
      defectiveQuantity: component.defectiveQuantity,
      suggested: verdict.suggested,
      reasons: [...verdict.reasons],
      decision: (component.decision as UnitDecision | null) ?? null,
      note: component.note,
      version: component.version,
    }
  })

  // ---- what the bench picks from ------------------------------------------------------------------------------------------
  const open = row.status === 'OPEN'
  const groups = open && lot ? await db.shadeGroup.findMany({ where: { itemId: lot.itemId }, select: { id: true, itemId: true, itemColourId: true, lotId: true, label: true, outOfShade: true, swatchRef: true, swatchFileId: true, sortOrder: true, active: true } }) : []
  const grades = open && byHide ? await gradesOf(db) : []
  const rules = open && byHide && lot ? activeRules(((await rulesOf(db, [lot.itemId])).get(lot.itemId) ?? []).map(ruleFactsOf)) : new Map()
  const defects = open && byHide ? await hideDefectsOf(db) : []
  const inSample = new Set(hideIds)
  const candidates =
    open && byHide && lot
      ? (await db.hide.findMany({ where: { lotId: lot.id }, select: { id: true, code: true, state: true, area: true, areaUom: true }, orderBy: { code: 'asc' }, take: 500 }))
          .filter((hide) => !inSample.has(hide.id))
          .map((hide) => ({ hideId: hide.id, code: hide.code, state: hide.state, whole: hide.state === 'FULL', area: fixed4(hide.area), areaUom: areaUnit(hide.areaUom) }))
      : []
  const inRolls = new Set(tagged)
  const rollCandidates =
    open && byRoll && lot
      ? (await db.fabricRoll.findMany({ where: { lotId: lot.id, state: { notIn: ['SCRAPPED', 'RETURNED'] } }, select: { id: true, code: true, supplierRollRef: true, state: true, length: true, uom: true, widthCm: true }, orderBy: { code: 'asc' }, take: 500 }))
          .filter((roll) => !inRolls.has(roll.id))
          .map((roll) => ({ rollId: roll.id, code: roll.code, supplierRollRef: roll.supplierRollRef, state: roll.state, length: fixed4(roll.length), uom: roll.uom, widthCm: roll.widthCm === null ? null : roll.widthCm.toFixed(2) }))
      : []

  // ---- a workshop's receipt (B-W2b-111) -----------------------------------------------------------------------------------
  const rejectedLines = new Set(receipt?.rejected.lineIds ?? [])
  const receiptView = receipt
    ? {
        id: receipt.id,
        seq: receipt.seq,
        receivedAt: toUtcIso(receipt.receivedAt),
        workshopDdtNumber: receipt.workshopDdtNumber,
        order: { id: receipt.order.id, number: receipt.order.number, status: receipt.order.status },
        workOrder: receipt.workOrder,
        // The workshop is a party: the office's to read (a tablet reads no party).
        workshop: context.audience === 'office' ? receipt.workshop : null,
        lots: receiptLotOf(receipt.lines),
        lines: receipt.lines.map((line) => ({
          id: line.id,
          seq: line.seq,
          operation: { seq: line.operationSeq, code: line.operationCode, name: line.operationName },
          bundle: line.bundleId ? { id: line.bundleId, code: line.bundleCode ?? '' } : null,
          good: line.good,
          defective: line.defective,
          scrapped: line.scrapped,
          reason: line.reasonCode ?? line.reasonNote,
          state: line.scanId ? ('REPORTED' as const) : rejectedLines.has(line.id) ? ('REJECTED' as const) : row.status === 'OPEN' ? ('HELD' as const) : ('NOT_REPORTED' as const),
          scanId: line.scanId,
        })),
        held: row.status === 'OPEN' ? heldWords(receipt.lines.reduce((sum, line) => sum + line.good + line.defective, 0), row.number) : null,
      }
    : null

  // ---- after the decision -------------------------------------------------------------------------------------------------
  let next = null
  if (row.status === 'DECIDED') {
    const quantities = { accepted: whole(row.acceptedQuantity!), rejected: whole(row.rejectedQuantity!), toSort: whole(row.toSortQuantity!) }
    const step = nextStepOf(quantities, row.lotSize.toString())
    if (lot) {
      const of = (decision: UnitDecision) => hideRows.filter((hide) => hide.decision === decision).map((hide) => ({ hideId: hide.hideId, code: hide.code }))
      const rejected = of('REJECTED')
      const toSort = of('TO_SORT')
      const held = [...rejected, ...toSort]
      next = {
        step,
        words: nextWords(step, lot.code, quantities, row.uom),
        lotStatus: lot.qualityStatus,
        // W1's lot release and rejection (B-W1-34), Owner answer W3: the quality role types the lot's code, never its receiver.
        lotRoute: step === 'REJECT' ? `/quality/lots/${lot.id}/reject` : `/quality/lots/${lot.id}/release`,
        rejectedHides: rejected,
        toSortHides: toSort,
        rejectedRolls: rolls.filter((roll) => roll.decision === 'REJECTED').map((roll) => ({ id: roll.id, rollRef: roll.rollRef })),
        rejectedLines: [],
        // POST /quality/holds (quality.holds.place, the office): the sample's rejected and to-sort hides held until they go.
        holdPrefill: held.length > 0 ? { subjectType: 'Hide' as const, subjectIds: held.map((hide) => hide.hideId), reasonNote: `Incoming inspection ${row.number}: ${held.map((hide) => hide.code).join(', ')} not accepted.`.slice(0, 500) } : null,
        // POST /purchasing/claims (purchasing.claims.manage): the rejected hides go back to the tannery, sent by a person.
        returnPrefill: rejected.length > 0 ? { kind: 'RETURN' as const, foundAt: 'INSPECTION' as const, reasonNote: `Incoming inspection ${row.number} of lot ${lot.code}: ${rejected.length} ${rejected.length === 1 ? 'hide' : 'hides'} rejected (${rejected.map((hide) => hide.code).join(', ')}).`.slice(0, 1000), from: { lotId: lot.id, hideIds: rejected.map((hide) => hide.hideId) } } : null,
      }
    } else if (receipt) {
      const lines = receipt.lines.filter((line) => rejectedLines.has(line.id))
      const names = lines.map((line) => (line.bundleCode ? line.bundleCode : `line ${line.seq}`))
      next = {
        step,
        words: receiptNextWords(receiptSplit(receipt.lines, rejectedLines), names),
        lotStatus: null,
        lotRoute: null,
        rejectedHides: [],
        toSortHides: [],
        rejectedRolls: [],
        rejectedLines: lines.map((line) => ({ id: line.id, seq: line.seq, bundleCode: line.bundleCode, operationCode: line.operationCode, pieces: line.good + line.defective })),
        holdPrefill: null,
        returnPrefill: null,
      }
    }
  }

  const supplier = context.audience === 'office' && lot?.supplierId ? await db.party.findUnique({ where: { id: lot.supplierId }, select: { id: true, legalName: true, tradeName: true } }) : null
  const mayRecord = open && mayOn(context, QUALITY_INCOMING_RECORD, row) && isOwn(context, row)
  return {
    inspection: {
      id: row.id,
      number: row.number,
      status: row.status,
      companyId: row.companyId,
      siteId: row.siteId,
      subject: lot ? ('LOT' as const) : ('WORKSHOP' as const),
      lotSize: fixed4(row.lotSize),
      uom: row.uom,
      byHide,
      byRoll,
      sampleSize: row.sampleSize,
      codeLetter: row.codeLetter,
      inspectionLevel: row.inspectionLevel,
      aqlMajor: row.aqlMajor === null ? null : aqlWords(row.aqlMajor.toString()),
      aqlMinor: row.aqlMinor === null ? null : aqlWords(row.aqlMinor.toString()),
      acceptMajor: row.acceptMajor,
      acceptMinor: row.acceptMinor,
      found: facts.found,
      computedResult: row.computedResult,
      overrideReason: row.overrideReason,
      decision: row.status === 'DECIDED' ? { accepted: fixed4(row.acceptedQuantity!), rejected: fixed4(row.rejectedQuantity!), toSort: fixed4(row.toSortQuantity!) } : null,
      decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
      signatureSha256: row.signatureSha256,
      cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
      cancelReason: row.cancelReason,
      dueAt: row.dueAt ? toUtcIso(row.dueAt) : null,
      note: row.note,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
    },
    lot: lot
      ? {
          id: lot.id,
          code: lot.code,
          qualityStatus: lot.qualityStatus,
          dyeBatch: lot.dyeBatch,
          supplierLotRef: lot.supplierLotRef,
          receivedAt: lot.receivedAt ? toUtcIso(lot.receivedAt) : null,
          item: { id: lot.item.id, code: lot.item.code, name: lot.item.name },
          colour: lot.itemColour,
          supplier: supplier ? { id: supplier.id, name: supplier.tradeName?.trim() || supplier.legalName } : null,
        }
      : null,
    receipt: receiptView,
    plan: version ? { planId: version.plan.id, code: version.plan.code, name: version.plan.name, versionId: version.id, number: version.number } : null,
    sampling: {
      method: version?.samplingMethod === 'FIXED' ? ('FIXED' as const) : profile ? ('AQL' as const) : ('WHOLE' as const),
      profile: profile ? { id: profile.id, code: profile.code, name: profile.name, inspectionLevel: profile.inspectionLevel as InspectionLevel } : null,
      words: byRoll ? rollSampleWords(row.sampleSize, row.lotSize.toString(), row.uom as 'M', done) : sampleWords(row.sampleSize, row.lotSize.toString(), row.uom, byHide || counted ? done : null),
      plan: aqlPlan,
    },
    progress: byRoll
      ? { done, sampleSize: row.sampleSize, remaining: Math.max(0, row.sampleSize - done), decided: done - rollTotals.undecided, accepted: rollTotals.accepted, rejected: rollTotals.rejected, toSort: rollTotals.toSort, undecided: rollTotals.undecided }
      : { ...facts.tally, done, sampleSize: row.sampleSize, remaining: Math.max(0, row.sampleSize - done), decided: done - facts.tally.undecided },
    result: resultView(result),
    hides: hideRows,
    rolls,
    rollSummary: rollTotals,
    components,
    areaCheck:
      byHide && lot
        ? {
            uom: base,
            tolerancePercent: tolerance.percent,
            toleranceFrom: tolerance.from,
            hides: lotArea.hides,
            declared: lotArea.check ? lotArea.check.declared.toFixed(4) : null,
            measuredArea: lotArea.check ? lotArea.check.measured.toFixed(4) : null,
            difference: lotArea.check ? lotArea.check.difference.toFixed(4) : null,
            differencePercent: lotArea.check?.differencePercent ?? null,
            outcome: lotArea.check?.outcome ?? null,
            opensClaim: lotArea.opensClaim,
            words: areaWords(),
            // B-W2b-94's lot area check gives the claim's body (POST /purchasing/claims), sent by a person of purchasing.
            route: `/inventory/lots/${lot.id}/area-check`,
          }
        : null,
    checks: facts.checkRows.map((check) => ({
      id: check.id,
      code: check.code,
      labelIt: check.labelIt,
      labelEn: check.labelEn,
      type: check.type,
      checkClass: check.checkClass,
      mandatory: check.mandatory,
      photoRequired: check.photoRequired,
      nominal: check.nominal === null ? null : check.nominal.toFixed(3),
      tolerance: check.tolerance === null ? null : check.tolerance.toFixed(3),
      uom: check.uom,
      choices: [...check.choices],
      answers: facts.answers.filter((answer) => answer.planCheckId === check.id).map((answer) => ({ id: answer.id, sampleIndex: answer.sampleIndex, outcome: answer.outcome, value: answer.value, note: answer.note })),
    })),
    checksNow: { failed: [...facts.now.failed], failedCritical: [...facts.now.failedCritical], mandatoryMissing: [...facts.now.mandatoryMissing] },
    choices: {
      shadeGroups: lot
        ? shadeGroupsFor(groups, { itemId: lot.itemId, lotId: lot.id, itemColourId: lot.itemColourId })
            .sort((a, b) => a.sortOrder - b.sortOrder || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
            .map((group) => ({ id: group.id, label: group.label, outOfShade: group.outOfShade, swatchRef: group.swatchRef, swatchFileId: group.swatchFileId, lotId: group.lotId }))
        : [],
      grades: gradesForArticle(grades, rules).map((grade) => ({ id: grade.id, code: grade.code, labelIt: grade.labelIt, labelEn: grade.labelEn, usableShare: grade.usableShare })),
      hideDefects: defects.map((defect) => ({ id: defect.id, code: defect.code, labelIt: defect.labelIt, labelEn: defect.labelEn, defectClass: classOfDefect(defect) })),
      // B-W2b-111: the 4-point counters and the limit, the component kinds, the certificates a component is checked against.
      pointClasses: POINT_CLASSES.map((entry) => ({ ...entry })),
      fourPointLimit: FOUR_POINT_LIMIT,
      componentKinds: (Object.keys(COMPONENT_WORDS) as ComponentKind[]).map((kind) => ({ kind, ...COMPONENT_WORDS[kind] })),
      certificates: open ? extras.choices.map((entry) => ({ id: entry.id, number: entry.number, standard: entry.standard, validTo: entry.validTo })) : [],
      coveringCertificate: extras.covering ? { id: extras.covering.id, number: extras.covering.number, standard: extras.covering.standard, validTo: extras.covering.validTo } : null,
    },
    candidates,
    rollCandidates,
    next,
    inspector: await inspectorView(db, row, context),
    yours: isOwn(context, row) && (row.inspectorWorkerId !== null || row.inspectorUserId !== null),
    may: { record: mayRecord, decide: mayRecord, cancel: mayRecord },
  }
}

/** The record as the commands answer it: read again, with the subject's receipt and the register's certificates as they stand. */
export async function viewOf(caller: CommandCaller, inspectionId: string, subject: Subject, context: Inspector) {
  const row = (await caller.withClient((db) => readIncoming(db, inspectionId)))!
  const fresh: Subject = subject.receipt ? { lot: null, receipt: (await receiptAs(caller, context, subject.receipt.id)) ?? subject.receipt } : subject
  const named = (await caller.withClient((db) => readComponents(db, inspectionId))).flatMap((component) => (component.certificateId ? [component.certificateId] : []))
  const extras = await certificateExtras(caller, context, { companyId: row.companyId, itemId: subject.lot?.itemId ?? null, named })
  return caller.withClient((db) => incomingView(db, row, fresh, context, extras))
}

/** GET /quality/incoming/:inspectionId */
export async function getIncoming(caller: CommandCaller, inspectionId: string) {
  const { row, lot, receipt, context } = await incomingFor(caller, inspectionId, QUALITY_INCOMING_VIEW)
  return viewOf(caller, row.id, { lot, receipt }, context)
}

export interface ListQuery {
  readonly status?: 'OPEN' | 'DECIDED' | 'CANCELLED' | undefined
  readonly lotId?: string | undefined
  readonly subcontractReceiptId?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/**
 * GET /quality/incoming: the incoming inspections the caller sees (office: its grants' companies and sites; a tablet: its
 * site), newest first, `cursor` the last row's id. No person in a list (Owner answer W1): who inspects is a kind only.
 * B-W2b-111: goods back from a workshop are listed too (`receipt`; no lot, no item).
 */
export async function listIncoming(caller: CommandCaller, query: ListQuery) {
  const context = inspectorOf(caller)
  const scope = scopeWhere(actorOf(context), QUALITY_INCOMING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.IncomingInspectionWhereInput
  return caller.withClient(async (db) => {
    const rows = await db.incomingInspection.findMany({
      where: {
        AND: [scope, ...(query.lotId ? [{ lotId: query.lotId }] : []), ...(query.subcontractReceiptId ? [{ subcontractReceiptId: query.subcontractReceiptId }] : []), ...(query.status ? [{ status: query.status }] : []), ...(query.cursor ? [{ id: { lt: query.cursor } }] : [])],
      },
      select: {
        id: true,
        number: true,
        status: true,
        companyId: true,
        siteId: true,
        lotSize: true,
        uom: true,
        sampleSize: true,
        computedResult: true,
        acceptedQuantity: true,
        rejectedQuantity: true,
        toSortQuantity: true,
        inspectorWorkerId: true,
        inspectorUserId: true,
        dueAt: true,
        inspectedCount: true,
        openedByTriggerId: true,
        createdAt: true,
        subcontractReceiptId: true,
        workOrderId: true,
        lot: { select: { id: true, code: true, qualityStatus: true, supplierId: true, item: { select: { id: true, code: true, name: true } } } },
        _count: { select: { hideResults: true, rollResults: true } },
        // B-W2b-127 (design qi-grid "Plan + version", "Amended"): the plan version it runs on, a countersigned correction.
        planVersion: { select: { number: true, plan: { select: { code: true } } } },
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    // B-W2b-127 (design qi-grid "Supplier (incoming)"): the lot's supplier, for the office only (a tablet reads no party).
    const supplierIds = context.audience === 'office' ? [...new Set(page.map((row) => row.lot?.supplierId).filter((id): id is string => typeof id === 'string'))] : []
    const suppliers = new Map((supplierIds.length ? await db.party.findMany({ where: { id: { in: supplierIds } }, select: { id: true, legalName: true, tradeName: true } }) : []).map((party) => [party.id, { id: party.id, name: party.tradeName?.trim() || party.legalName }]))
    // Corrections are the office's (a tablet reads none): a countersigned one marks the row "amended".
    const amendedIds = new Set(context.audience === 'office' && page.length ? (await db.inspectionAmendment.findMany({ where: { incomingInspectionId: { in: page.map((row) => row.id) }, kind: 'SIGNED' }, select: { incomingInspectionId: true }, distinct: ['incomingInspectionId'] })).map((row) => row.incomingInspectionId) : [])
    return {
      items: page.map((row) => ({
        id: row.id,
        number: row.number,
        status: row.status,
        companyId: row.companyId,
        siteId: row.siteId,
        lot: row.lot ? { id: row.lot.id, code: row.lot.code, qualityStatus: row.lot.qualityStatus } : null,
        item: row.lot ? row.lot.item : null,
        receipt: row.subcontractReceiptId ? { id: row.subcontractReceiptId, workOrderId: row.workOrderId! } : null,
        lotSize: fixed4(row.lotSize),
        uom: row.uom,
        sampleSize: row.sampleSize,
        // B-W2b-213: a counted lot's units inspected (IncomingInspection.inspectedCount).
        done: row._count.hideResults + row._count.rollResults || (row.inspectedCount ?? 0),
        computedResult: row.computedResult,
        decision: row.status === 'DECIDED' ? { accepted: fixed4(row.acceptedQuantity!), rejected: fixed4(row.rejectedQuantity!), toSort: fixed4(row.toSortQuantity!) } : null,
        inspectorKind: row.inspectorWorkerId ? ('FLOOR' as const) : row.inspectorUserId ? ('OFFICE' as const) : null,
        dueAt: row.dueAt ? toUtcIso(row.dueAt) : null,
        openedByRule: row.openedByTriggerId !== null,
        createdAt: toUtcIso(row.createdAt),
        supplier: row.lot?.supplierId ? (suppliers.get(row.lot.supplierId) ?? null) : null,
        plan: { code: row.planVersion.plan.code, number: row.planVersion.number },
        amended: amendedIds.has(row.id),
      })),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    }
  })
}
