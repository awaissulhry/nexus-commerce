import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { QUALITY_LOTS_TEST, QUALITY_LOTS_VIEW } from '@nexus/factory-domain/quality/lab/permissions'
import { limitFits, resultProblems, RULE_CODE_OF_TEST, unitOfRule, type RecordedTest, type ResultDraft } from '@nexus/factory-domain/compliance/test-plans/rules'
import { limitWords, type LimitBound, type SubstanceTest, type SubstanceUnit } from '@nexus/factory-domain/compliance/substances/rules'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { completeUpload, requestUpload, retainFilesInCommand } from '../../../platform/files/files'
import { addYears } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { lotFor, mayOn } from '../../quality/lab/store'
import { reevaluateInCommand } from '../material-profiles/reevaluate'
import { substancesClock, substancesGuarded, substancesSettings } from '../substances/common'
import { marketsFor, type Reader } from '../substances/store'
import { activePlans, dayOf, dueOfLots, LOT_FACTS_SELECT } from './store'

/**
 * Due tests on lots and the substance tests' results (B-W2b-256; PRD-309 "due tests appear on the lot as W1's chromium VI
 * test does"). Reading a lot's due tests needs W1's quality.lots.view over the lot's company and site (as its lot page);
 * recording a result of a substance test (azo amines, nickel release, PAHs, DMFu, NPE, PFAS) needs quality.lots.test, as
 * W1's chromium VI result does (that one stays W1's route, POST /quality/lots/:lotId/results).
 *
 *   report   POST /compliance/test-plans/lots/:lotId/report: the lab's report announced as a CERTIFICATE file of the lot
 *            (module-owned record type Lot: W1's rule) → the presigned PUT
 *   record   POST /compliance/test-plans/lots/:lotId/results: checked first (every problem at once), the report confirmed,
 *            then ONE command: the LabResult judged against its substance rule's limit (the rule named, else the one the lot's
 *            plan rules name, else the only switched-on rule of that test with a limit), in the rule's unit, the report kept
 *            ten years, the material evaluated again (the evaluator owns its profile's state), the event. W1's lot page,
 *            release check and verdict words stay chromium VI's: a substance result does not release or hold the lot.
 */

const REPORT_RETENTION_YEARS = 10
const RETENTION_WHY = "A substance test's lab report is kept ten years with the material's evidence (technical file)."
const DUE_LOTS_LIMIT = 300

type Caller = CommandCaller & Pick<FastifyRequest, 'withClient'>

const resultsOfLot = async (db: Reader, lotId: string) =>
  (
    await db.labResult.findMany({
      where: { lotId },
      select: { id: true, test: true, verdict: true, valueMgKg: true, belowDetectionLimit: true, detectionLimitMgKg: true, unit: true, limitMgKg: true, method: true, lab: true, reportNumber: true, testedOn: true, evidence: true, fileId: true, supersededBy: { select: { id: true } } },
      orderBy: [{ testedOn: 'desc' }, { createdAt: 'desc' }],
    })
  ).map((row) => ({
    resultId: row.id,
    test: row.test as SubstanceTest,
    verdict: row.verdict as 'PASS' | 'FAIL',
    value: row.valueMgKg ? row.valueMgKg.toFixed() : null,
    belowDetectionLimit: row.belowDetectionLimit,
    detectionLimit: row.detectionLimitMgKg ? row.detectionLimitMgKg.toFixed() : null,
    unit: row.unit,
    limit: row.limitMgKg.toFixed(),
    method: row.method,
    lab: row.lab,
    reportNumber: row.reportNumber,
    testedOn: dayOf(row.testedOn),
    evidence: row.evidence,
    fileId: row.fileId,
    current: row.supersededBy.length === 0,
  }))

/** GET /compliance/test-plans/lots/:lotId — the lot's due tests (with what covers each) and its substance results. */
export async function lotDue(request: Caller, lotId: string) {
  const lot = await lotFor(request, lotId, QUALITY_LOTS_VIEW)
  const now = substancesClock().now()
  return request.withClient(async (db) => {
    const row = await db.lot.findUniqueOrThrow({ where: { id: lot.id }, select: LOT_FACTS_SELECT })
    const due = (await dueOfLots(db, [row], businessDate(now))).get(row.id) ?? []
    const supplier = row.supplierId ? await db.party.findUnique({ where: { id: row.supplierId }, select: { id: true, code: true, legalName: true } }) : null
    const context = request.factoryContext!
    return {
      lot: {
        id: row.id,
        code: row.code,
        companyId: row.companyId,
        siteId: row.siteId,
        item: { id: lot.item.id, code: lot.item.code, name: lot.item.name, kind: lot.item.kind },
        supplier: supplier ? { id: supplier.id, code: supplier.code, name: supplier.legalName } : null,
        arrivedOn: dayOf(row.receivedAt ?? row.createdAt),
        qualityStatus: row.qualityStatus,
      },
      markets: await marketsFor(db, [row.companyId]),
      due,
      results: await resultsOfLot(db, row.id),
      mayRecord: context.audience === 'office' && mayOn(context, QUALITY_LOTS_TEST, row),
      asOf: toUtcIso(now),
    }
  })
}

/** GET /compliance/test-plans/due — the lots (newest first) with a test still due or failed by the plan rules. */
export async function dueLots(request: FastifyRequest, query: { readonly test?: SubstanceTest | undefined; readonly siteId?: string | undefined }) {
  const context = request.factoryContext!
  const actor = actorOf(context)
  const now = substancesClock().now()
  return request.withClient(async (db) => {
    const plans = await activePlans(db)
    const itemIds = [...new Set(plans.flatMap((plan) => (plan.itemId ? [plan.itemId] : [])))]
    const kinds = [...new Set(plans.flatMap((plan) => (plan.itemKind ? [plan.itemKind] : [])))]
    if (plans.length === 0) return { lots: [], more: false, counts: { lots: 0, due: 0, failed: 0 }, asOf: toUtcIso(now) }
    const where: Prisma.LotWhereInput = {
      AND: [
        scopeWhere(actor, QUALITY_LOTS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.LotWhereInput,
        { qualityStatus: { not: 'REJECTED' } },
        { OR: [...(itemIds.length > 0 ? [{ itemId: { in: itemIds } }] : []), ...(kinds.length > 0 ? [{ item: { kind: { in: kinds as never[] } } }] : [])] },
        ...(query.siteId ? [{ siteId: query.siteId }] : []),
      ],
    }
    const rows = await db.lot.findMany({ where, select: LOT_FACTS_SELECT, orderBy: [{ createdAt: 'desc' }], take: DUE_LOTS_LIMIT + 1 })
    const shown = rows.slice(0, DUE_LOTS_LIMIT)
    const due = await dueOfLots(db, shown, businessDate(now), plans)
    const items = new Map((await db.item.findMany({ where: { id: { in: [...new Set(shown.map((row) => row.itemId))] } }, select: { id: true, code: true, name: true, kind: true } })).map((item) => [item.id, item]))
    const lots = shown
      .map((row) => ({ row, open: (due.get(row.id) ?? []).filter((test) => test.status !== 'MET' && (!query.test || test.test === query.test)) }))
      .filter((entry) => entry.open.length > 0)
      .map(({ row, open }) => ({
        lot: { id: row.id, code: row.code, companyId: row.companyId, siteId: row.siteId, arrivedOn: dayOf(row.receivedAt ?? row.createdAt), qualityStatus: row.qualityStatus },
        item: items.get(row.itemId) ?? { id: row.itemId, code: '?', name: '?', kind: row.item.kind },
        tests: open.map((test) => ({ planId: test.planId, test: test.test, frequency: test.frequency, status: test.status, words: test.words })),
      }))
    return {
      lots,
      more: rows.length > DUE_LOTS_LIMIT,
      counts: { lots: lots.length, due: lots.reduce((sum, entry) => sum + entry.tests.filter((test) => test.status === 'DUE').length, 0), failed: lots.reduce((sum, entry) => sum + entry.tests.filter((test) => test.status === 'FAILED').length, 0) },
      asOf: toUtcIso(now),
    }
  })
}

/** POST /compliance/test-plans/lots/:lotId/report — the lab's report of a substance test, announced on the lot. */
export async function announceReport(caller: Caller, lotId: string, body: { readonly originalName: string; readonly contentType: string; readonly sizeBytes: number; readonly sha256: string }, key: string | null | undefined) {
  const lot = await lotFor(caller, lotId, QUALITY_LOTS_TEST)
  if (lot.qualityStatus === 'REJECTED') throw new InvalidStateError(`Lot ${lot.code} is rejected: it takes no result.`)
  return requestUpload(processFiles(), caller, { companyId: lot.companyId, recordType: 'Lot', recordId: lot.id, kind: 'CERTIFICATE', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 }, key ?? undefined, { viaModule: true })
}

export interface ResultBody extends ResultDraft {
  /** The substance rule the result is judged against (default: the lot's plan rule's, else the only one of its test). */
  readonly ruleId?: string | null | undefined
  readonly fileId: string
}

/** The substance rule a result is judged against, with its limit (400 in words when none or several fit). */
async function ruleFor(db: Reader, lot: { readonly id: string; readonly companyId: string }, test: SubstanceTest, ruleId: string | null | undefined) {
  const code = RULE_CODE_OF_TEST[test]
  const select = { id: true, key: true, code: true, companyId: true, limitValue: true, limitUnit: true, limitBound: true, switchedOn: true, status: true } as const
  let candidates
  if (ruleId) {
    const rule = isUuid(ruleId) ? await db.substanceRule.findUnique({ where: { id: ruleId }, select }) : null
    if (!rule || (rule.companyId !== null && rule.companyId !== lot.companyId)) throw new ValidationError('The rule is not valid.', [{ path: 'body/ruleId', message: 'A substance rule of the lot\'s company or a tenant-wide one.' }])
    if (rule.code !== code && rule.code !== 'CMR' && rule.code !== 'OTHER') throw new ValidationError('The rule is not valid.', [{ path: 'body/ruleId', message: `Rule ${rule.key} is a ${rule.code} rule: a ${test} result is judged against a ${code} rule.` }])
    candidates = [rule]
  } else {
    const row = await db.lot.findUniqueOrThrow({ where: { id: lot.id }, select: LOT_FACTS_SELECT })
    const due = (await dueOfLots(db, [row], businessDate(substancesClock().now()))).get(row.id) ?? []
    const named = [...new Set(due.filter((entry) => entry.test === test && entry.substanceRuleId).map((entry) => entry.substanceRuleId!))]
    candidates =
      named.length > 0
        ? await db.substanceRule.findMany({ where: { id: { in: named } }, select })
        : await db.substanceRule.findMany({ where: { code, status: 'ACTIVE', switchedOn: true, limitValue: { not: null }, OR: [{ companyId: null }, { companyId: lot.companyId }] }, select })
    if (candidates.length === 0) throw new ValidationError('No rule to judge the result against.', [{ path: 'body/ruleId', message: `No switched-on ${code} rule with a limit: name the rule (ruleId), or add its limit in the substance list.` }])
    if (candidates.length > 1) throw new ValidationError('Name the rule the result is judged against.', [{ path: 'body/ruleId', message: `Several ${code} rules apply: ${candidates.map((rule) => rule.key).join(', ')}.` }])
  }
  const rule = candidates[0]!
  const limit = rule.limitValue?.toFixed() ?? null
  if (limit === null || rule.limitUnit === null || rule.limitBound === null) throw new ValidationError('The rule has no limit.', [{ path: 'body/ruleId', message: `Rule ${rule.key} is a ban with no limit value: a lab value cannot be judged against it (record the supplier's declaration instead).` }])
  if (!limitFits(limit)) throw new ValidationError('The rule\'s limit cannot be recorded.', [{ path: 'body/ruleId', message: `Rule ${rule.key}'s limit ${limit} has more than 3 decimals or 5 digits: a lab result holds 8 digits with 3 decimals.` }])
  if ((test === 'NICKEL') !== (rule.limitUnit === 'UG_CM2_WEEK')) throw new ValidationError('The rule is not valid.', [{ path: 'body/ruleId', message: `A nickel release result is in µg/cm²/week (EN 1811), and only nickel's: rule ${rule.key} is in ${rule.limitUnit}.` }])
  return { id: rule.id, key: rule.key, limit, unit: rule.limitUnit as SubstanceUnit, bound: rule.limitBound as LimitBound }
}

/** POST /compliance/test-plans/lots/:lotId/results — a substance test's result with its report. */
export async function recordSubstanceResult(caller: Caller, lotId: string, body: ResultBody, key: string | null | undefined) {
  const lot = await lotFor(caller, lotId, QUALITY_LOTS_TEST)
  const context = request(caller)
  const now = substancesClock().now()
  const test = body.test as SubstanceTest
  if (lot.qualityStatus === 'REJECTED') throw new InvalidStateError(`Lot ${lot.code} is rejected: it takes no result.`)
  if (test === 'CR_VI') throw new ValidationError('The result is not valid.', [{ path: 'body/test', message: 'A chromium VI result is recorded on the lot: POST /quality/lots/:lotId/results.' }])
  const rule = await caller.withClient((db) => ruleFor(db, lot, test, body.ruleId))
  const checked = resultProblems(body, { limitValue: rule.limit, limitBound: rule.bound }, businessDate(now))
  if (checked.problems.length > 0) throw new ValidationError('The result is not valid.', checked.problems)
  const file = isUuid(body.fileId) ? await caller.withClient((db) => db.storedFile.findUnique({ where: { id: body.fileId }, select: { id: true, recordType: true, recordId: true, kind: true, status: true } })) : null
  if (!file || file.recordType !== 'Lot' || file.recordId !== lot.id || file.kind !== 'CERTIFICATE' || file.status === 'DELETED') {
    throw new ValidationError('The result is not valid.', [{ path: 'body/fileId', message: "Not a report of this lot: announce the lab's report here first (POST …/report), send it, then record the result." }])
  }
  if (file.status !== 'AVAILABLE') {
    const confirmed = await completeUpload(processFiles(), caller, file.id, key ? `${key.slice(0, 120)}:report` : undefined, { viaModule: true })
    if (confirmed.status !== 'AVAILABLE') throw new ConflictError(`The report did not arrive as announced (${confirmed.quarantineReason ?? confirmed.status}): announce it again and send the file.`)
  }
  const verdict = checked.verdict!
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.testPlans.recordResult', idempotencyKey: key, input: { lotId, ...body } },
      async (tools) => {
        const id = newId()
        const blank = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim())
        await tools.tx.labResult.create({
          data: {
            id,
            companyId: lot.companyId,
            siteId: lot.siteId,
            itemId: lot.itemId,
            lotId: lot.id,
            test: test as RecordedTest,
            method: body.method!.trim(),
            valueMgKg: body.belowDetectionLimit ? null : body.valueMgKg!,
            belowDetectionLimit: body.belowDetectionLimit === true,
            detectionLimitMgKg: body.belowDetectionLimit ? body.detectionLimitMgKg! : null,
            unit: unitOfRule(rule.unit),
            limitMgKg: rule.limit,
            verdict,
            lab: body.lab!.trim(),
            reportNumber: blank(body.reportNumber),
            testedOn: new Date(`${body.testedOn}T00:00:00.000Z`),
            evidence: body.evidence as 'LOT_REPORT' | 'SUPPLIER_REPORT',
            article: body.evidence === 'SUPPLIER_REPORT' ? blank(body.article) : null,
            periodFrom: body.evidence === 'SUPPLIER_REPORT' ? new Date(`${body.periodFrom}T00:00:00.000Z`) : null,
            periodTo: body.evidence === 'SUPPLIER_REPORT' ? new Date(`${body.periodTo}T00:00:00.000Z`) : null,
            fileId: file.id,
            note: blank(body.note),
            createdAt: tools.now,
            createdById: context.actorId,
          },
          select: { id: true },
        })
        await retainFilesInCommand(tools, [file.id], addYears(tools.now, REPORT_RETENTION_YEARS), RETENTION_WHY)
        tools.audit({
          action: 'compliance.testPlans.recordResult',
          recordType: 'LabResult',
          recordId: id,
          companyId: lot.companyId,
          siteId: lot.siteId,
          after: { lotId: lot.id, itemId: lot.itemId, test, verdict, value: body.valueMgKg ?? null, belowDetectionLimit: body.belowDetectionLimit === true, unit: unitOfRule(rule.unit), limit: rule.limit, ruleId: rule.id, fileId: file.id },
        })
        tools.emit({ type: 'compliance_material_tests.result_recorded', subject: id, companyId: lot.companyId, siteId: lot.siteId, payload: { resultId: id, lotId: lot.id, itemId: lot.itemId, test, verdict, ruleId: rule.id } })
        // The evaluator says again what the material needs (a failing substance test blocks it: B-W2b-250's rule).
        const evaluated = await reevaluateInCommand(tools, [lot.itemId], context.actorId)
        const profile = await tools.tx.materialComplianceProfile.findUnique({ where: { id: lot.itemId }, select: { state: true, stateReason: true } })
        return {
          resultId: id,
          verdict,
          words: `${body.belowDetectionLimit ? `Below the detection limit of ${body.detectionLimitMgKg}` : `${body.valueMgKg}`} ${unitOfRule(rule.unit)} against ${limitWords(rule.limit, rule.unit, rule.bound)} (rule ${rule.key}): ${verdict === 'PASS' ? 'pass' : 'fail'}.`,
          rule: { id: rule.id, key: rule.key, limit: limitWords(rule.limit, rule.unit, rule.bound) },
          profile: evaluated > 0 && profile ? { state: profile.state as 'INCOMPLETE' | 'COMPLETE' | 'BLOCKED', stateReason: profile.stateReason } : null,
          at: toUtcIso(tools.now),
        }
      },
      substancesSettings(),
    ),
  )
  return result
}

function request(caller: CommandCaller): { readonly actorId: string } {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new NotFoundError('Lot not found.')
  return context
}

