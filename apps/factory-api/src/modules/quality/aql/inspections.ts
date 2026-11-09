import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { aqlResult, type ChecksNow } from '@nexus/factory-domain/quality/aql/result'
import { reasonProblem } from '@nexus/factory-domain/quality/aql/profiles'
import { acceptanceOf, aqlStored, aqlWords, levelOf, levelText, type SamplingPlanResult } from '@nexus/factory-domain/quality/aql/sampling'
import { QUALITY_INSPECTIONS_RECORD, QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { CHECKLIST_ITEMS, defectCounts, planProblems } from '@nexus/factory-domain/quality/final/rules'
import { inspectedNow } from '@nexus/factory-domain/quality/final/plan'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { scanProgressOf } from '../../production/scans/progress'
import { readCells, type LabelHeader } from '../../production/serials/store'
import { finalWorkOrder, inspectorOf, mayOn, signerOf, type Inspector } from '../final/access'
import { assigneeOf, isAssigned, isAssignee } from '../final/assign'
import { readDefects, readInspection, type InspectionRow } from '../final/store'
import { aqlPlanFor, chainView, customersOf, planOfProfile, planView, readChain, resultView, type ChainRead } from './chain'
import { PROFILE_COLUMNS, type Reader } from './store'

/**
 * An inspection's Sample & AQL, and its plan taken from a profile (B-W2b-93; QHS-013, QHS-020, QHS-021; design
 * quality.inspections "Sample & AQL" tab: "How the sample was chosen" and "AQL profile"; W1 stored the acceptance numbers
 * by hand). The final inspection (W1's Inspection, bound to its work order) is the record; incoming and in-process checks
 * take their plan through chain.ts `aqlPlanFor` in their own steps (B-W2b-98, -99).
 *
 *   GET  /quality/aql/inspections/:inspectionId          the derivation in words and as a table (per class AQL, Ac, Re,
 *                                                        found, state), the result now (QHS-013), the profile it came
 *                                                        from and the one the chain gives now, whether the stored numbers
 *                                                        are the profile's, whether counting started (the profile is
 *                                                        frozen). Office and the site's bench, quality.inspections.view.
 *   POST /quality/aql/inspections/:inspectionId/profile  { version, profileId?, lotSize?, reason? }: the plan from the
 *                                                        chain's profile (or one named, with a written reason: the audit
 *                                                        row keeps it), written onto the OPEN inspection in ONE command:
 *                                                        aqlProfileId, codeLetter, sampleSize, inspectionLevel ("II",
 *                                                        "S-3"), aqlMajor, aqlMinor, acceptMajor, acceptMinor (and the
 *                                                        lot, within W1's limits). Its inspector (or assignee) only, as
 *                                                        W1's PATCH; refused once counting starts, on a fixed-sample plan
 *                                                        version, or when no profile applies and none is named.
 *
 * The database stays the last word: the …_inspection_plans_w2b_guards "Inspection_plan_guard" freezes the profile and
 * code letter once counting starts and takes only a profile in use; W1's "Inspection_guard" checks the numbers and writes
 * `computedResult` at the decision (the trigger decides; the decision against it is an override with a reason).
 */

type Facts = { readonly planVersionId: string | null; readonly aqlProfileId: string | null; readonly codeLetter: string | null }

async function factsOf(db: Reader, inspectionId: string): Promise<Facts> {
  return (await db.inspection.findUnique({ where: { id: inspectionId }, select: { planVersionId: true, aqlProfileId: true, codeLetter: true } }))!
}

/**
 * A defect, a result or a measurement is recorded, or (B-W2b-213) a unit is counted: the profile and the code letter are
 * frozen (the database refuses a change once Inspection.inspectedCount is above 0; a count kept in the AQL_SAMPLE entry
 * before the column freezes it here too).
 */
async function countingStarted(db: Reader, inspectionId: string): Promise<{ started: boolean; words: string | null }> {
  const defects = await db.inspectionDefect.count({ where: { inspectionId } })
  const results = await db.inspectionCheckResult.count({ where: { inspectionId } })
  const measurements = await db.inspectionMeasurement.count({ where: { inspectionId } })
  const counted = await db.inspection.findUnique({ where: { id: inspectionId }, select: { inspectedCount: true, checklist: true } })
  const units = counted ? inspectedNow(counted) : 0
  if (defects + results + measurements + units === 0) return { started: false, words: null }
  const parts = [units ? `${units} ${units === 1 ? 'unit' : 'units'} counted` : null, defects ? `${defects} defect ${defects === 1 ? 'line' : 'lines'}` : null, results ? `${results} check ${results === 1 ? 'result' : 'results'}` : null, measurements ? `${measurements} ${measurements === 1 ? 'measurement' : 'measurements'}` : null].filter(Boolean)
  return { started: true, words: `The profile is frozen once counting starts: ${parts.join(', ')} recorded.` }
}

/** The checks now: W1's checklist items not ok, or the plan's failed checks, critical ones, and mandatory ones unanswered. */
async function checksOf(db: Reader, row: InspectionRow, planVersionId: string | null): Promise<ChecksNow> {
  const words = new Map<string, string>(CHECKLIST_ITEMS.map((item) => [item.code, item.words]))
  const checklist = Array.isArray(row.checklist) ? (row.checklist as { code?: unknown; ok?: unknown }[]) : []
  const failed = checklist.filter((item) => item?.ok === false && typeof item.code === 'string').map((item) => words.get(item.code as string) ?? (item.code as string))
  if (!planVersionId) return { failed, failedCritical: [], mandatoryMissing: [] }
  const checks = await db.inspectionPlanCheck.findMany({ where: { planVersionId }, select: { id: true, labelEn: true, type: true, checkClass: true, mandatory: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })
  const results = await db.inspectionCheckResult.findMany({ where: { inspectionId: row.id }, select: { planCheckId: true, outcome: true } })
  const measurements = await db.inspectionMeasurement.findMany({ where: { inspectionId: row.id, planCheckId: { not: null } }, select: { planCheckId: true, pass: true } })
  // As the database's factory_inspection_results_problem: a result or a measurement answers a check; a FAIL result or a
  // measurement out of tolerance fails it.
  const failedIds = new Set<string>([...results.filter((result) => result.outcome === 'FAIL').map((result) => result.planCheckId), ...measurements.filter((m) => m.pass === false).map((m) => m.planCheckId!)])
  const answered = new Set<string>([...results.map((result) => result.planCheckId), ...measurements.map((m) => m.planCheckId!)])
  const planFailed = checks.filter((check) => failedIds.has(check.id))
  return {
    failed: [...failed, ...planFailed.map((check) => check.labelEn)],
    failedCritical: planFailed.filter((check) => check.checkClass === 'CRITICAL').map((check) => check.labelEn),
    mandatoryMissing: checks.filter((check) => check.mandatory && check.type !== 'INSTRUCTION' && !answered.has(check.id)).map((check) => check.labelEn),
  }
}

/** The numbers the record keeps differ from the engine's for its profile, in words. */
function differencesOf(row: InspectionRow, codeLetter: string | null, plan: SamplingPlanResult): string[] {
  const out: string[] = []
  const accept = acceptanceOf(plan)
  const level = levelOf(row.inspectionLevel)
  if (level !== plan.level) out.push(`Level ${row.inspectionLevel}, the profile's is ${levelText(plan.level)}.`)
  if (aqlWords(row.aqlMajor.toString()) !== plan.classes[1]!.aql) out.push(`Major AQL ${aqlWords(row.aqlMajor.toString())}, the profile's is ${plan.classes[1]!.aql}.`)
  if (aqlWords(row.aqlMinor.toString()) !== plan.classes[2]!.aql) out.push(`Minor AQL ${aqlWords(row.aqlMinor.toString())}, the profile's is ${plan.classes[2]!.aql}.`)
  if (codeLetter !== plan.codeLetter) out.push(`Code letter ${codeLetter ?? 'none'}, ISO 2859-1 gives ${plan.codeLetter ?? 'none'}.`)
  if (row.sampleSize !== plan.sampleSize) out.push(`Sample ${row.sampleSize}, ISO 2859-1 gives ${plan.sampleSize}.`)
  if (row.acceptMajor !== accept.acceptMajor) out.push(`Major accepts ${row.acceptMajor}, ISO 2859-1 gives ${accept.acceptMajor}.`)
  if (row.acceptMinor !== accept.acceptMinor) out.push(`Minor accepts ${row.acceptMinor}, ISO 2859-1 gives ${accept.acceptMinor}.`)
  return out
}

/** Its inspector (or, once assigned, its assignee) records it: W1's rule for the sampling plan (final/inspections.ts). */
function isOwn(context: Inspector, row: InspectionRow): boolean {
  const signer = signerOf(context)
  const assignee = assigneeOf(row)
  if (isAssigned(assignee)) return isAssignee(assignee, signer)
  return (signer.workerId !== null && signer.workerId === row.inspectorWorkerId) || (signer.userId !== null && signer.userId === row.inspectorUserId)
}

async function inspectionFor(caller: CommandCaller, inspectionId: string, permission: typeof QUALITY_INSPECTIONS_VIEW | typeof QUALITY_INSPECTIONS_RECORD): Promise<{ row: InspectionRow; header: LabelHeader; context: Inspector }> {
  const context = inspectorOf(caller)
  const row = isUuid(inspectionId) ? await caller.withClient((client) => readInspection(client, inspectionId)) : null
  if (!row || !(mayOn(context, QUALITY_INSPECTIONS_VIEW, row) || mayOn(context, permission, row))) throw new NotFoundError('Inspection not found.')
  const header = await finalWorkOrder(caller, row.workOrderId, permission)
  return { row, header, context }
}

async function viewOf(db: Reader, row: InspectionRow, header: LabelHeader, context: Inspector) {
  const facts = await factsOf(db, row.id)
  const chain: ChainRead = await readChain(db, { companyId: row.companyId, planVersionId: facts.planVersionId, styleId: header.styleId, customerIds: await customersOf(db, header.id) })
  const applied = facts.aqlProfileId ? await db.aqlProfile.findUnique({ where: { id: facts.aqlProfileId }, select: PROFILE_COLUMNS }) : null
  const plan = applied ? planOfProfile(applied, row.lotSize) : null
  const differences = plan ? differencesOf(row, facts.codeLetter, plan) : []
  const counting = await countingStarted(db, row.id)
  const counts = defectCounts(await readDefects(db, [row.id]))
  const checks = await checksOf(db, row, facts.planVersionId)
  const result = aqlResult({
    sampleSize: row.sampleSize,
    // B-W2b-213: the units counted on a plan (Inspection.inspectedCount, else the AQL_SAMPLE entry), so "38 of 50" and a
    // verdict before the decision; W1's plan-less inspection keeps no count: its verdict stays open until it is decided.
    inspected: row.status === 'OPEN' ? (row.planVersionId ? inspectedNow(row) : null) : row.sampleSize,
    classes: [
      { defectClass: 'CRITICAL', aql: '0', accept: 0, found: counts.critical },
      { defectClass: 'MAJOR', aql: aqlWords(row.aqlMajor.toString()), accept: row.acceptMajor, found: counts.major },
      { defectClass: 'MINOR', aql: aqlWords(row.aqlMinor.toString()), accept: row.acceptMinor, found: counts.minor },
    ],
    checks,
  })
  const words = plan
    ? plan.words
    : `Lot ${row.lotSize} · level ${row.inspectionLevel} → inspect ${row.sampleSize} (typed by hand${facts.codeLetter ? `, code letter ${facts.codeLetter}` : ''}).`
  return {
    inspection: {
      id: row.id,
      number: row.number,
      workOrderId: row.workOrderId,
      status: row.status,
      lotSize: row.lotSize,
      sampleSize: row.sampleSize,
      inspectionLevel: row.inspectionLevel,
      codeLetter: facts.codeLetter,
      aqlMajor: aqlWords(row.aqlMajor.toString()),
      aqlMinor: aqlWords(row.aqlMinor.toString()),
      acceptMajor: row.acceptMajor,
      acceptMinor: row.acceptMinor,
      planVersionId: facts.planVersionId,
      version: row.version,
    },
    profile: applied ? { id: applied.id, code: applied.code, name: applied.name, active: applied.active } : null,
    chain: chainView(chain),
    plan: plan ? planView(plan) : null,
    matchesProfile: plan ? differences.length === 0 : null,
    differences,
    frozen: counting.started,
    frozenWords: counting.words,
    fixedSample: chain.fixedSample,
    counts,
    result: resultView(result),
    computedResult: row.computedResult,
    overrideReason: row.overrideReason,
    mayApply: row.status === 'OPEN' && !counting.started && !chain.fixedSample && mayOn(context, QUALITY_INSPECTIONS_RECORD, row) && isOwn(context, row),
    words,
  }
}

/** GET /quality/aql/inspections/:inspectionId */
export async function inspectionAql(caller: CommandCaller, inspectionId: string) {
  const { row, header, context } = await inspectionFor(caller, inspectionId, QUALITY_INSPECTIONS_VIEW)
  return caller.withClient((client) => viewOf(client, row, header, context))
}

/** The finished garments of the work order (good at the final operation; null: no scanned operation), as W1 counts them. */
async function finishedOf(db: Reader, header: LabelHeader): Promise<number | null> {
  const values = [...(await scanProgressOf(db, header)).values()].map((cell) => cell.finished)
  if (values.length === 0 || values.some((value) => value === null)) return values.length === 0 ? 0 : null
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

export interface ApplyBody {
  readonly version: number
  readonly profileId?: string | null | undefined
  readonly lotSize?: number | undefined
  readonly reason?: string | null | undefined
}

const invalid = (message: string, problems: readonly Issue[]) => new ValidationError(problems.length === 1 ? problems[0]!.message : message, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))

/** POST /quality/aql/inspections/:inspectionId/profile */
export async function applyProfile(caller: CommandCaller, inspectionId: string, body: ApplyBody, idempotencyKey?: string) {
  const { row: seen, header, context } = await inspectionFor(caller, inspectionId, QUALITY_INSPECTIONS_RECORD)
  if (!isOwn(context, seen)) throw new ForbiddenError(isAssigned(assigneeOf(seen)) ? 'This inspection is assigned to another inspector: they record its sampling plan.' : 'This inspection is recorded by the inspector who opened it.')
  const { result } = await command(caller, { name: 'quality.aql.applyProfile', idempotencyKey, input: { inspectionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "Inspection" WHERE "id" = ${seen.id}::uuid FOR UPDATE`
    const row = (await readInspection(tx, seen.id))!
    if (row.version !== body.version) throw new StaleVersionError('Inspection', row.id, row.version, body.version)
    if (row.status !== 'OPEN') throw new InvalidStateError(`This inspection is ${row.status}; a signed or cancelled inspection never changes (a correction is an amendment).`)
    const counting = await countingStarted(tx, row.id)
    if (counting.started) throw new ConflictError(counting.words!)
    const facts = await factsOf(tx, row.id)
    const lotSize = body.lotSize ?? row.lotSize
    const lotChanged = lotSize !== row.lotSize
    const answer = await aqlPlanFor(tx, { companyId: row.companyId, planVersionId: facts.planVersionId, styleId: header.styleId, customerIds: await customersOf(tx, header.id), lotSize, profileId: body.profileId ?? null, at: 'body/profileId' })
    if (answer.chain.fixedSample) throw new InvalidStateError('The plan version samples a fixed number of units: no AQL profile applies to this inspection.')
    if (!answer.profile || !answer.plan) throw new InvalidStateError('No AQL profile applies (the company has no default and no assignment answers): name a profile, with the reason.')
    const problems: Issue[] = []
    const reasonIssue = answer.named ? reasonProblem(body.reason) : null
    if (reasonIssue) problems.push({ ...reasonIssue, message: `${answer.profile.code} is not the profile the chain gives (${answer.chain.answer.words}): say why. ${reasonIssue.message}` })
    if (!answer.named && body.reason?.trim()) problems.push({ path: 'reason', message: 'This is the profile the chain gives: no reason is needed.' })
    const plan = answer.plan
    const accept = acceptanceOf(plan)
    // W1's limits on a new lot (at most the finished garments of the work order); an unchanged lot was checked at the opening.
    const pieces = lotChanged ? (await readCells(tx, header.id)).reduce((sum, cell) => sum + cell.quantity, 0) : 0
    if (lotChanged) problems.push(
      ...planProblems(
        { lotSize, sampleSize: plan.sampleSize, inspectionLevel: levelText(plan.level), aqlMajor: plan.classes[1]!.aql, aqlMinor: plan.classes[2]!.aql, acceptMajor: accept.acceptMajor, acceptMinor: accept.acceptMinor },
        { pieces, finished: await finishedOf(tx, header) },
      ).filter((problem) => problem.path === 'lotSize'),
    )
    if (problems.length > 0) throw invalid('The sampling plan cannot be taken from the profile.', problems)
    const before = { lotSize: row.lotSize, sampleSize: row.sampleSize, inspectionLevel: row.inspectionLevel, aqlMajor: row.aqlMajor.toString(), aqlMinor: row.aqlMinor.toString(), acceptMajor: row.acceptMajor, acceptMinor: row.acceptMinor, aqlProfileId: facts.aqlProfileId, codeLetter: facts.codeLetter }
    const after = {
      lotSize,
      sampleSize: plan.sampleSize,
      inspectionLevel: levelText(plan.level),
      aqlMajor: aqlStored(plan.classes[1]!.aql),
      aqlMinor: aqlStored(plan.classes[2]!.aql),
      acceptMajor: accept.acceptMajor,
      acceptMinor: accept.acceptMinor,
      aqlProfileId: answer.profile.id,
      codeLetter: plan.codeLetter,
    }
    await tx.inspection.update({ where: { id: row.id }, data: { ...after, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const source = answer.named ? 'NAMED' : answer.chain.answer.source
    tools.audit({
      recordType: 'Inspection',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before,
      after: { ...after, profileCode: answer.profile.code, source, chain: answer.chain.answer.words, plan: plan.words },
      // The reason for a profile other than the chain's lives on the audit row (no column of the inspection keeps it:
      // B-W2b-76's gap "Change profile with a reason").
      ...(answer.named ? { reason: body.reason!.trim() } : {}),
    })
    tools.emit({
      type: 'quality.inspection_sampling_set',
      subject: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      payload: { inspectionId: row.id, workOrderId: row.workOrderId, profileId: answer.profile.id, source, codeLetter: plan.codeLetter, lotSize, sampleSize: plan.sampleSize, acceptMajor: accept.acceptMajor, acceptMinor: accept.acceptMinor },
    })
    return { id: row.id }
  })
  return caller.withClient(async (client) => viewOf(client, (await readInspection(client, result.id))!, header, context))
}
