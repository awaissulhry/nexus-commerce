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
import { UNITS } from '@nexus/factory-domain/product/units/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { gradesOf, ruleFactsOf, rulesOf, toleranceOfLot } from '../../inventory/hides/facts'
import { workerGateFor } from '../../people/privacy/worker-gate'
import { planOfProfile, planView, resultView } from '../aql/chain'
import { inspectorOf, mayOn, type Inspector } from '../final/access'
import { classOfDefect, hideDefectsOf, sampleFactsOf, type SampleFacts } from './facts'
import { incomingFor, isOwn, type IncomingRow, type LotRow, type Reader } from './store'

/**
 * What the screens read of an incoming inspection (B-W2b-98; design floor.incoming Sample, Hide by hide, Decision; quality
 * .inspections "Incoming"): the record with its sample in words, the AQL result now, every hide of the sample with its
 * area against the tannery, its shade group, grade and marks, the plan checks with their answers, the lot's area check
 * from the hides measured in it, what the bench picks from (shade tiles, grades, hide defects, the lot's hides not in the
 * sample yet), and after the decision what comes next (the lot waits for the quality role; hold or return the rejected
 * hides; the claim for a short lot is purchasing's). No money anywhere; a person only inside the one record, and a floor
 * worker's name only where the site's PERFORMANCE gate is open (B-W2b-F3), never to a tablet.
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
export async function incomingView(db: Reader, row: IncomingRow, lot: LotRow, context: Inspector) {
  const byHide = row.uom === 'HIDE'
  const facts: SampleFacts = await sampleFactsOf(db, row, byHide)
  const version = await db.inspectionPlanVersion.findUnique({ where: { id: row.planVersionId }, select: { id: true, number: true, samplingMethod: true, fixedSampleSize: true, plan: { select: { id: true, code: true, name: true } } } })
  const profile = row.aqlProfileId ? await db.aqlProfile.findUnique({ where: { id: row.aqlProfileId }, select: { id: true, code: true, name: true, inspectionLevel: true, aqlMajor: true, aqlMinor: true, active: true } }) : null
  const lotWhole = new Dec(row.lotSize.toString())
  const aqlPlan = profile && lotWhole.isInteger() && lotWhole.greaterThanOrEqualTo(1) ? planView(planOfProfile(profile, Number(lotWhole.toFixed(0)))) : null
  const done = facts.results.length
  const result = aqlResult({
    sampleSize: row.sampleSize,
    inspected: byHide ? Math.min(done, row.sampleSize) : null,
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
  const tolerance = await toleranceOfLot(db, lot.id)
  const base: AreaUom = areaUnit(lot.item.baseUom)
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

  // ---- what the bench picks from ------------------------------------------------------------------------------------------
  const open = row.status === 'OPEN'
  const groups = open ? await db.shadeGroup.findMany({ where: { itemId: lot.itemId }, select: { id: true, itemId: true, itemColourId: true, lotId: true, label: true, outOfShade: true, swatchRef: true, swatchFileId: true, sortOrder: true, active: true } }) : []
  const grades = open && byHide ? await gradesOf(db) : []
  const rules = open && byHide ? activeRules(((await rulesOf(db, [lot.itemId])).get(lot.itemId) ?? []).map(ruleFactsOf)) : new Map()
  const defects = open && byHide ? await hideDefectsOf(db) : []
  const inSample = new Set(hideIds)
  const candidates =
    open && byHide
      ? (await db.hide.findMany({ where: { lotId: lot.id }, select: { id: true, code: true, state: true, area: true, areaUom: true }, orderBy: { code: 'asc' }, take: 500 }))
          .filter((hide) => !inSample.has(hide.id))
          .map((hide) => ({ hideId: hide.id, code: hide.code, state: hide.state, whole: hide.state === 'FULL', area: fixed4(hide.area), areaUom: areaUnit(hide.areaUom) }))
      : []

  // ---- after the decision -------------------------------------------------------------------------------------------------
  let next = null
  if (row.status === 'DECIDED') {
    const quantities = { accepted: whole(row.acceptedQuantity!), rejected: whole(row.rejectedQuantity!), toSort: whole(row.toSortQuantity!) }
    const step = nextStepOf(quantities, row.lotSize.toString())
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
      // POST /quality/holds (quality.holds.place, the office): the sample's rejected and to-sort hides held until they go.
      holdPrefill: held.length > 0 ? { subjectType: 'Hide' as const, subjectIds: held.map((hide) => hide.hideId), reasonNote: `Incoming inspection ${row.number}: ${held.map((hide) => hide.code).join(', ')} not accepted.`.slice(0, 500) } : null,
      // POST /purchasing/claims (purchasing.claims.manage): the rejected hides go back to the tannery, sent by a person.
      returnPrefill: rejected.length > 0 ? { kind: 'RETURN' as const, foundAt: 'INSPECTION' as const, reasonNote: `Incoming inspection ${row.number} of lot ${lot.code}: ${rejected.length} ${rejected.length === 1 ? 'hide' : 'hides'} rejected (${rejected.map((hide) => hide.code).join(', ')}).`.slice(0, 1000), from: { lotId: lot.id, hideIds: rejected.map((hide) => hide.hideId) } } : null,
    }
  }

  const supplier = context.audience === 'office' && lot.supplierId ? await db.party.findUnique({ where: { id: lot.supplierId }, select: { id: true, legalName: true, tradeName: true } }) : null
  const mayRecord = open && mayOn(context, QUALITY_INCOMING_RECORD, row) && isOwn(context, row)
  return {
    inspection: {
      id: row.id,
      number: row.number,
      status: row.status,
      companyId: row.companyId,
      siteId: row.siteId,
      lotSize: fixed4(row.lotSize),
      uom: row.uom,
      byHide,
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
    lot: {
      id: lot.id,
      code: lot.code,
      qualityStatus: lot.qualityStatus,
      dyeBatch: lot.dyeBatch,
      supplierLotRef: lot.supplierLotRef,
      receivedAt: lot.receivedAt ? toUtcIso(lot.receivedAt) : null,
      item: { id: lot.item.id, code: lot.item.code, name: lot.item.name },
      colour: lot.itemColour,
      supplier: supplier ? { id: supplier.id, name: supplier.tradeName?.trim() || supplier.legalName } : null,
    },
    plan: version ? { planId: version.plan.id, code: version.plan.code, name: version.plan.name, versionId: version.id, number: version.number } : null,
    sampling: {
      method: version?.samplingMethod === 'FIXED' ? ('FIXED' as const) : profile ? ('AQL' as const) : ('WHOLE' as const),
      profile: profile ? { id: profile.id, code: profile.code, name: profile.name, inspectionLevel: profile.inspectionLevel as InspectionLevel } : null,
      words: sampleWords(row.sampleSize, row.lotSize.toString(), row.uom, byHide ? done : null),
      plan: aqlPlan,
    },
    progress: { ...facts.tally, done, sampleSize: row.sampleSize, remaining: Math.max(0, row.sampleSize - done), decided: done - facts.tally.undecided },
    result: resultView(result),
    hides: hideRows,
    areaCheck: byHide
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
      shadeGroups: shadeGroupsFor(groups, { itemId: lot.itemId, lotId: lot.id, itemColourId: lot.itemColourId })
        .sort((a, b) => a.sortOrder - b.sortOrder || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
        .map((group) => ({ id: group.id, label: group.label, outOfShade: group.outOfShade, swatchRef: group.swatchRef, swatchFileId: group.swatchFileId, lotId: group.lotId })),
      grades: gradesForArticle(grades, rules).map((grade) => ({ id: grade.id, code: grade.code, labelIt: grade.labelIt, labelEn: grade.labelEn, usableShare: grade.usableShare })),
      hideDefects: defects.map((defect) => ({ id: defect.id, code: defect.code, labelIt: defect.labelIt, labelEn: defect.labelEn, defectClass: classOfDefect(defect) })),
    },
    candidates,
    next,
    inspector: await inspectorView(db, row, context),
    yours: isOwn(context, row) && (row.inspectorWorkerId !== null || row.inspectorUserId !== null),
    may: { record: mayRecord, decide: mayRecord, cancel: mayRecord },
  }
}

/** GET /quality/incoming/:inspectionId */
export async function getIncoming(caller: CommandCaller, inspectionId: string) {
  const { row, lot, context } = await incomingFor(caller, inspectionId, QUALITY_INCOMING_VIEW)
  return caller.withClient((db) => incomingView(db, row, lot, context))
}

export interface ListQuery {
  readonly status?: 'OPEN' | 'DECIDED' | 'CANCELLED' | undefined
  readonly lotId?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/**
 * GET /quality/incoming: the incoming inspections the caller sees (office: its grants' companies and sites; a tablet: its
 * site), newest first, `cursor` the last row's id. No person in a list (Owner answer W1): who inspects is a kind only.
 */
export async function listIncoming(caller: CommandCaller, query: ListQuery) {
  const context = inspectorOf(caller)
  const scope = scopeWhere(actorOf(context), QUALITY_INCOMING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.IncomingInspectionWhereInput
  return caller.withClient(async (db) => {
    const rows = await db.incomingInspection.findMany({
      where: { AND: [scope, { lotId: query.lotId ? query.lotId : { not: null } }, ...(query.status ? [{ status: query.status }] : []), ...(query.cursor ? [{ id: { lt: query.cursor } }] : [])] },
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
        createdAt: true,
        lot: { select: { id: true, code: true, qualityStatus: true, item: { select: { id: true, code: true, name: true } } } },
        _count: { select: { hideResults: true } },
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    return {
      items: page.map((row) => ({
        id: row.id,
        number: row.number,
        status: row.status,
        companyId: row.companyId,
        siteId: row.siteId,
        lot: row.lot ? { id: row.lot.id, code: row.lot.code, qualityStatus: row.lot.qualityStatus } : null,
        item: row.lot ? row.lot.item : null,
        lotSize: fixed4(row.lotSize),
        uom: row.uom,
        sampleSize: row.sampleSize,
        done: row._count.hideResults,
        computedResult: row.computedResult,
        decision: row.status === 'DECIDED' ? { accepted: fixed4(row.acceptedQuantity!), rejected: fixed4(row.rejectedQuantity!), toSort: fixed4(row.toSortQuantity!) } : null,
        inspectorKind: row.inspectorWorkerId ? ('FLOOR' as const) : row.inspectorUserId ? ('OFFICE' as const) : null,
        dueAt: row.dueAt ? toUtcIso(row.dueAt) : null,
        createdAt: toUtcIso(row.createdAt),
      })),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    }
  })
}
