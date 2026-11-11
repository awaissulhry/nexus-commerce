import { toUtcIso } from '@nexus/factory-domain/core/time'
import { aqlResult, type ChecksNow } from '@nexus/factory-domain/quality/aql/result'
import { aqlWords } from '@nexus/factory-domain/quality/aql/sampling'
import { QUALITY_INSPECTIONS_RECORD, QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import {
  applicablePlans,
  checksState,
  decimalWords,
  deviationWords,
  inspectedNow,
  photoSet,
  planDecisionProblems,
  sampleRejected,
  type PlanCheck,
} from '@nexus/factory-domain/quality/final/plan'
import { defectCounts } from '@nexus/factory-domain/quality/final/rules'
import { CHECK_TYPE_WORDS, CLASS_WORDS } from '@nexus/factory-domain/quality/plans/rules'
import type { CommandCaller } from '../../../core/command'
import { aqlPlanFor, chainView, planView } from '../aql/chain'
import { finalWorkOrder, inspectorOf, mayOn } from './access'
import { inspectionFor, isOwn } from './inspections'
import { becauseWords, bindingOf, factsReader, finalPlans, identityFacts, measurementRow, measurementsOf, mtmFacts, photosOf, resultRow, resultsOf, stopRule, workOrderFacts } from './plan'
import { readDefects, readInspection, type Reader } from './store'
// B-W2b-224 (SZ1:01): the approved graded spec of the work order's revision on the chart.
import { sizeSpecFor } from './size-spec'
import { readCells } from '../../production/serials/store'
import { gradedPointOf } from '@nexus/factory-domain/quality/final/plan'
// B-W2b-283 (FU1:05): a value's band.
import { bandOfRow } from '@nexus/factory-domain/quality/final/plan'

/**
 * The bench sheet of a final inspection on its plan (B-W2b-97; design floor.final "serial", "aql", "measure", "photos" and
 * quality.inspections "Checks & results", "Serial and batch check", "Sample & AQL", "Measurements", "Required photo set"),
 * and the plans that apply to a work order (design qi-new "FIN-JACKET v3 applies because: …"). Office and the site's
 * bench, quality.inspections.view. No price, cost or margin; no person (a worker's or rider's name never), only who
 * recorded a line as FLOOR or OFFICE.
 *
 *   GET /quality/inspections/:inspectionId/sheet           the checks with their results and photos, the measurement chart
 *                                                          (made-to-measure against the rider's profile), the serial or batch
 *                                                          check, the photo set, the live counter with the stop rule, the
 *                                                          result now, and what holds the signature of a PASS or a FAIL
 *   GET /quality/final/work-orders/:workOrderId/plans      the company's FINAL plans: which apply and why, the one suggested,
 *                                                          and (with ?lotSize) the AQL plan of its sample
 */

const languageOf = async (db: Reader, caller: CommandCaller, asked: string | undefined): Promise<string> => {
  if (asked) return asked
  const context = caller.factoryContext
  if (context?.audience === 'floor') return (await db.worker.findUnique({ where: { id: context.actorId }, select: { locale: true } }))?.locale ?? 'it'
  if (context?.audience === 'office') return (await db.user.findUnique({ where: { id: context.actorId }, select: { locale: true } }))?.locale ?? 'it'
  return 'it'
}

const labelIn = (check: PlanCheck, words: Readonly<Record<string, string>>, language: string): { label: string; missing: boolean } =>
  language === 'it' ? { label: check.labelIt, missing: false } : language === 'en' ? { label: check.labelEn, missing: false } : words[language] ? { label: words[language]!, missing: false } : { label: check.labelEn, missing: true }

const lang = (language: string): 'it' | 'en' => (language === 'it' ? 'it' : 'en')

/** The bench sheet (GET …/sheet, and the answer of every write on a plan). */
export async function sheetOf(caller: CommandCaller, inspectionId: string, query: { readonly language?: string | undefined } = {}) {
  const context = inspectorOf(caller)
  const { inspection: seen, header } = await inspectionFor(caller, inspectionId)
  const facts = factsReader(caller)
  const mtm = await facts.withClient((client) => mtmFacts(client, header))
  const graded = mtm ? null : await facts.withClient((client) => sizeSpecFor(client, header))
  return caller.withClient(async (db) => {
    const row = (await readInspection(db, seen.id))!
    const binding = await bindingOf(db, row)
    const language = await languageOf(db, caller, query.language)
    const results = await resultsOf(db, row.id)
    const photos = await facts.withClient((client) => photosOf(client, results.map((result) => result.id)))
    const available = (id: string) => (photos.get(id) ?? []).filter((file) => file.status === 'AVAILABLE').length
    const resultRows = results.map((result) => resultRow(result, available(result.id)))
    const measurements = (await measurementsOf(db, row.id)).map(measurementRow)
    const defects = await readDefects(db, [row.id])
    const counts = defectCounts(defects)
    const checks = checksState(binding.checks, resultRows, measurements)
    const identity = await identityFacts(db, header, row)
    const photoState = photoSet(binding.checks, resultRows)
    const inspected = inspectedNow(row)
    const stop = await stopRule(db, context.tenantId, row.companyId, binding.version.stopAtReject)
    const failed: ChecksNow = { ...checks, failed: [...checks.failed, ...(identity.summary.ok === false ? ['Serial or batch check'] : [])] }
    const result = aqlResult({
      sampleSize: row.sampleSize,
      inspected,
      classes: [
        { defectClass: 'CRITICAL', aql: '0', accept: 0, found: counts.critical },
        { defectClass: 'MAJOR', aql: aqlWords(row.aqlMajor.toString()), accept: row.acceptMajor, found: counts.major },
        { defectClass: 'MINOR', aql: aqlWords(row.aqlMinor.toString()), accept: row.acceptMinor, found: counts.minor },
      ],
      checks: failed,
    })
    const rejected = sampleRejected({ counts, acceptMajor: row.acceptMajor, acceptMinor: row.acceptMinor, failedCritical: checks.failedCritical.length })
    const ask = { checks, identity: identity.summary, photos: photoState, inspected, sampleSize: row.sampleSize, stop, rejected }
    const passHeld = [...(result.resultNow === 'FAIL' && !result.byCountsOnly ? [`A PASS over this FAIL is never signed: ${result.reasons.join(' ')}`] : []), ...planDecisionProblems({ ...ask, decision: 'PASS' }).map((problem) => problem.message)]
    const failHeld = planDecisionProblems({ ...ask, decision: 'FAIL' }).map((problem) => problem.message)

    // The measurement chart: the plan's measurement checks (their values by check), the rider's points of a made-to-measure
    // unit, and every other point measured (by point and size).
    type Point = { pointCode: string; checkCode: string | null; checkId: string | null; label: string; size: string | null; source: 'PLAN' | 'SIZE_CHART' | 'PROFILE' | 'SPEC' | 'TYPED'; nominal: string | null; tolerance: string | null; uom: string | null }
    const points: Point[] = []
    const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase()
    // B-W2b-224: the graded spec's cells of the work order's sizes, per point code.
    const woSizes = graded?.spec ? [...new Set((await readCells(db, header.id)).map((cell) => cell.size))] : []
    const specOf = (code: string) => (graded?.spec ? woSizes.flatMap((size) => gradedPointOf(graded.spec, code, size) ?? []) : [])
    for (const check of binding.checks.filter((entry) => entry.type === 'MEASUREMENT')) {
      const mtmPoint = check.nominal === null ? mtm?.points.find((point) => same(point.code, check.code)) : undefined
      const fromSpec = check.nominal === null && !mtmPoint && specOf(check.code).length > 0
      points.push({
        pointCode: check.code,
        checkCode: check.code,
        checkId: check.id,
        label: labelIn(check, binding.words.get(check.id) ?? {}, language).label,
        size: mtm ? mtm.size : null,
        source: check.nominal !== null ? 'PLAN' : mtmPoint ? 'PROFILE' : fromSpec ? 'SPEC' : 'SIZE_CHART',
        nominal: check.nominal ?? mtmPoint?.nominal ?? null,
        tolerance: check.tolerance,
        uom: check.uom ?? mtmPoint?.uom ?? null,
      })
    }
    for (const point of mtm?.points ?? []) {
      if (points.some((entry) => entry.source === 'PROFILE' && same(entry.pointCode, point.code))) continue
      points.push({ pointCode: point.code, checkCode: null, checkId: null, label: point.name, size: mtm!.size, source: 'PROFILE', nominal: point.nominal, tolerance: null, uom: point.uom })
    }
    // B-W2b-224: the spec's other points (no check of the plan names them), measured by point and size against the spec.
    for (const cell of graded?.spec?.points ?? []) {
      if (!woSizes.includes(cell.size) || points.some((entry) => same(entry.pointCode, cell.code))) continue
      points.push({ pointCode: cell.code, checkCode: null, checkId: null, label: cell.name, size: null, source: 'SPEC', nominal: null, tolerance: null, uom: cell.uom })
    }
    const valuesOf = (point: Point) =>
      measurements.filter((value) => (point.checkId ? value.planCheckId === point.checkId : value.planCheckId === null && same(value.pointCode, point.pointCode) && (point.size === null || value.size === point.size)))
    const placed = new Set(points.flatMap((point) => valuesOf(point).map((value) => value.id)))
    for (const value of measurements) {
      if (placed.has(value.id)) continue
      const point: Point = { pointCode: value.pointCode, checkCode: null, checkId: null, label: value.pointCode, size: value.size, source: 'TYPED', nominal: null, tolerance: null, uom: value.uom }
      points.push(point)
      for (const entry of valuesOf(point)) placed.add(entry.id)
    }
    // B-W2b-283 (FU1:05): a value keeps its band (a spec cell whose sides differ); its words say the band's own sides.
    const valueView = (value: (typeof measurements)[number]) => {
      const band = bandOfRow(value)
      return { id: value.id, size: value.size, sampleIndex: value.sampleIndex, measured: value.measured, nominal: value.nominal, tolerance: value.tolerance, toleranceMinus: band?.minus ?? null, tolerancePlus: band?.plus ?? null, pass: value.pass, words: deviationWords(value.measured, value.nominal, value.tolerance, value.uom, band) }
    }
    const chartPoints = points.map((point) => {
      const values = valuesOf(point)
      const { nominal, tolerance, uom } = point
      const bySize = point.source === 'SPEC' ? specOf(point.pointCode).map((cell) => ({ size: cell.size, nominal: cell.nominal, tolerance: cell.tolerance, toleranceMinus: cell.band?.minus ?? null, tolerancePlus: cell.band?.plus ?? null /* B-W2b-283 */, words: cell.words })) : []
      if (point.source === 'SPEC') {
        const head = lang(language) === 'it' ? `Dalla specifica di misura approvata, revisione ${graded!.spec!.revision}` : `From the approved measurement spec, revision ${graded!.spec!.revision}`
        return { pointCode: point.pointCode, checkCode: point.checkCode, label: point.label, size: point.size, source: point.source, nominal, tolerance, uom, bySize, spec: `${head}: ${bySize.map((cell) => `${cell.size} ${cell.words}`).join(' · ')}`, values: values.map(valueView) }
      }
      return {
        bySize,
        pointCode: point.pointCode,
        checkCode: point.checkCode,
        label: point.label,
        size: point.size,
        source: point.source,
        nominal,
        tolerance,
        uom,
        spec:
          nominal !== null && tolerance !== null && uom !== null
            ? `${decimalWords(nominal)} ± ${decimalWords(tolerance)} ${uom.toLowerCase()}`
            : nominal !== null && uom !== null
              ? lang(language) === 'it' ? `${decimalWords(nominal)} ${uom.toLowerCase()} dal profilo del pilota (tolleranza da scrivere)` : `${decimalWords(nominal)} ${uom.toLowerCase()} from the rider's profile (tolerance to type)`
              : lang(language) === 'it' ? 'Dalla tabella taglie (valore e tolleranza da scrivere)' : 'From the size chart (nominal and tolerance to type)',
        values: values.map(valueView),
      }
    })
    const out = measurements.filter((value) => !value.pass).length

    return {
      inspection: {
        id: row.id,
        number: row.number,
        workOrderId: row.workOrderId,
        status: row.status,
        version: row.version,
        lotSize: row.lotSize,
        sampleSize: row.sampleSize,
        inspectionLevel: row.inspectionLevel,
        codeLetter: row.codeLetter,
        aqlProfileId: row.aqlProfileId,
        aqlMajor: aqlWords(row.aqlMajor.toString()),
        aqlMinor: aqlWords(row.aqlMinor.toString()),
        acceptMajor: row.acceptMajor,
        acceptMinor: row.acceptMinor,
        decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
      },
      plan: { planId: binding.plan.id, code: binding.plan.code, name: binding.plan.name, versionId: binding.version.id, number: binding.version.number, samplingMethod: binding.version.samplingMethod as 'AQL_PROFILE' | 'FIXED' },
      language,
      checks: binding.checks.map((check) => {
        const words = labelIn(check, binding.words.get(check.id) ?? {}, language)
        return {
          id: check.id,
          code: check.code,
          label: words.label,
          missingWords: words.missing,
          labelIt: check.labelIt,
          labelEn: check.labelEn,
          type: check.type,
          typeWords: CHECK_TYPE_WORDS[check.type][lang(language)],
          checkClass: check.checkClass,
          classWords: check.checkClass ? CLASS_WORDS[check.checkClass][lang(language)] : null,
          mandatory: check.mandatory,
          photoRequired: check.photoRequired,
          takesResult: check.type !== 'INSTRUCTION',
          onChart: check.type === 'MEASUREMENT',
          choices: [...check.choices],
          results: results
            .filter((result) => result.planCheckId === check.id)
            .map((result) => ({
              id: result.id,
              sampleIndex: result.sampleIndex,
              outcome: result.outcome as 'PASS' | 'FAIL' | 'NOT_APPLICABLE',
              value: result.value,
              note: result.note,
              photos: (photos.get(result.id) ?? []).map((file) => ({ id: file.id, status: file.status })),
              recordedBy: result.recordedByWorkerId || result.deviceId ? ('FLOOR' as const) : ('OFFICE' as const),
              recordedAt: toUtcIso(result.recordedAt),
            })),
        }
      }),
      checksNow: { answered: checks.answered, outOf: checks.outOf, failed: [...checks.failed], failedCritical: [...checks.failedCritical], mandatoryMissing: [...checks.mandatoryMissing], words: checks.words },
      chart: {
        points: chartPoints,
        values: measurements.length,
        outOfTolerance: out,
        words: chartPoints.length === 0 ? 'This plan takes no measurements.' : `${out} of ${measurements.length} values out of tolerance`,
        madeToMeasure: mtm ? { garmentType: mtm.profile.garmentType, revision: mtm.profile.revision, size: mtm.size, points: mtm.points.map((point) => ({ ...point })), pointsWithout: [...mtm.pointsWithout] } : null,
        // B-W2b-224: the graded spec the size check reads (null: made to measure).
        gradedSpec: graded ? { revision: graded.spec?.revision ?? null, approved: graded.spec !== null, words: graded.words } : null,
      },
      identity: { ...identity.summary, missing: [...identity.summary.missing], unknown: [...identity.summary.unknown], scans: identity.scans.length, batchNumber: identity.mode === 'BATCH' ? header.batchNumber : null },
      photos: { slots: photoState.slots.map((slot) => ({ ...slot })), waiting: [...photoState.waiting], mandatoryMissing: [...photoState.mandatoryMissing], words: photoState.words },
      counter: {
        sampleSize: row.sampleSize,
        inspected,
        remaining: Math.max(0, row.sampleSize - inspected),
        classes: result.classes.map((entry) => ({ ...entry })),
        verdict: rejected ? ('reject' as const) : inspected >= row.sampleSize ? ('accept' as const) : ('open' as const),
        stop: { ...stop },
        words: `${inspected} of ${row.sampleSize} inspected`,
      },
      result: { resultNow: result.resultNow, reasons: [...result.reasons], byCountsOnly: result.byCountsOnly, overrideWords: result.overrideWords, words: result.words },
      sign: { pass: { held: passHeld.length > 0, reasons: passHeld }, fail: { held: failHeld.length > 0, reasons: failHeld } },
      may: { record: row.status === 'OPEN' && mayOn(context, QUALITY_INSPECTIONS_RECORD, row) && isOwn(context, row) },
    }
  })
}

/** GET /quality/final/work-orders/:workOrderId/plans */
export async function workOrderPlans(caller: CommandCaller, workOrderId: string, query: { readonly lotSize?: number | undefined; readonly planId?: string | undefined; readonly profileId?: string | undefined }) {
  const header = await finalWorkOrder(caller, workOrderId, QUALITY_INSPECTIONS_VIEW)
  return factsReader(caller).withClient(async (db) => {
    const { facts, customerIds } = await workOrderFacts(db, header)
    const fit = applicablePlans(await finalPlans(db, header.companyId), facts)
    const plans = await Promise.all(
      fit.plans.map(async (plan) => ({
        id: plan.id,
        code: plan.code,
        name: plan.name,
        approved: plan.approved,
        matches: plan.matches,
        usable: plan.usable,
        suggested: plan.id === fit.suggestedId,
        because: plan.matches ? await becauseWords(db, plan.because) : null,
      })),
    )
    const suggested = plans.find((plan) => plan.suggested) ?? null
    const chosen = query.planId ? (fit.plans.find((plan) => plan.id === query.planId) ?? null) : fit.plans.find((plan) => plan.id === fit.suggestedId) ?? null
    let sampling = null
    if (query.lotSize !== undefined && chosen?.approved) {
      const version = await db.inspectionPlanVersion.findUnique({ where: { id: chosen.approved.id }, select: { samplingMethod: true, fixedSampleSize: true } })
      if (version?.samplingMethod === 'FIXED') {
        sampling = { method: 'FIXED' as const, sampleSize: Math.min(version.fixedSampleSize ?? 1, query.lotSize), words: `Fixed sample of the plan: inspect ${Math.min(version.fixedSampleSize ?? 1, query.lotSize)} of ${query.lotSize}.`, chain: null, plan: null, named: false }
      } else {
        const answer = await aqlPlanFor(db, { companyId: header.companyId, planVersionId: chosen.approved.id, styleId: header.styleId, customerIds, lotSize: query.lotSize, profileId: query.profileId ?? null, at: 'query/profileId' })
        sampling = { method: 'AQL_PROFILE' as const, sampleSize: answer.plan?.sampleSize ?? null, words: answer.plan?.words ?? 'No AQL profile applies: name one with the reason, or type the sampling plan.', chain: chainView(answer.chain), plan: answer.plan ? planView(answer.plan) : null, named: answer.named }
      }
    }
    return {
      workOrderId: header.id,
      number: header.number,
      plans,
      suggestedId: fit.suggestedId,
      words: suggested ? `${suggested.code} v${suggested.approved?.number} applies because: ${suggested.because}.` : 'No final plan applies to this work order: open it without a plan (the fixed checklist) or name a plan with the reason.',
      sampling,
    }
  })
}
