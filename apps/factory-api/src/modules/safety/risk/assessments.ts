import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { holds, can, type Permission } from '@nexus/factory-domain/core/permissions'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/safety/calendar/rules'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { SAFETY_RISK_MANAGE, SAFETY_RISK_SIGN } from '@nexus/factory-domain/safety/risk/permissions'
import {
  burnDown,
  completion,
  DVR_LAW,
  farRefusal,
  measureDueState,
  OPEN_MEASURE_STATUSES,
  PLAN_LAW,
  REVIEW_LAW,
  RISK_LIMITS,
  signersFor,
  VERSIONS_LAW,
  type DvrSignerRole,
  type MeasureStatus,
  type RiskRefusal,
} from '@nexus/factory-domain/safety/risk/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { actorIdOf, assertMayAt, assertMayWriteAt, assertVersion, dateOf, dayOf, dayOrNull, mayAt, officeOf, refuse, siteScope, todayOf } from '../organisation/access'
import { ASSESSMENT_SELECT, assessmentViews, organisationOf, readAssessment, romeDay, VERSION_SELECT, versionViews, type AssessmentRow } from './store'

/**
 * The risk assessments of the sites (B-W2b-122; QHS-230; design plant.risk tiles, Assessments, the record), office only:
 *
 *   GET   /safety/risk/assessments             one row per site or production unit: the version in force with its certain
 *                                              date, the one waiting for signatures with who signed, the next review, the
 *                                              open measures and the site's role sheets (safety.view)
 *   GET   /safety/risk/counts                  the tiles: measures overdue and due in 30 days, reviews due, roles without a
 *                                              PPE kit or training, signatures missing on the versions waiting
 *   GET   /safety/risk/assessments/:id         the record: every version (never deleted) with its seal and signers, who would
 *                                              sign a version frozen today, the plan's counts and its burn-down
 *   POST  /safety/risk/assessments             add one (safety.risk.manage): a site of the company, a name unique on the site,
 *                                              the next review as a person sets it
 *   PATCH /safety/risk/assessments/:id         its name, next review, note
 *
 * No review interval is built in (art. 29 c.3 names the triggers, the consultant the day): the next review is typed. The
 * calendar reads it already (modules/safety/calendar/sources/risk-assessment.ts, DVR_REVIEW).
 */

const MANAGE_WORDS = 'The risk assessments of this site are kept by a role that keeps them (safety.risk.manage).'

const refuseWith = (refusal: RiskRefusal | null): void => {
  if (refusal) refuse(refusal.code, refusal.message, refusal.field)
}

/** The caller holds the permission at the screen's company (or anywhere, when the screen names none). */
const holdsHere = (context: OfficeContext, permission: Permission): boolean => (context.companyId ? can(actorOf(context), permission, { companyId: context.companyId }) : holds(actorOf(context), permission))

const asked = (query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }) => ({ ...(query.companyId ? { companyId: query.companyId } : {}), ...(query.siteId ? { siteId: query.siteId } : {}) })

/** GET /safety/risk/assessments. */
export async function listAssessments(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined; readonly status?: 'ACTIVE' | 'ARCHIVED' | 'all' | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const status = query.status ?? 'ACTIVE'
    const rows = (await client.riskAssessment.findMany({
      where: { AND: [siteScope(context, SAFETY_VIEW), asked(query), ...(status === 'all' ? [] : [{ status }])] },
      orderBy: [{ site: { code: 'asc' } }, { name: 'asc' }, { id: 'asc' }],
      take: RISK_LIMITS.list,
      select: ASSESSMENT_SELECT,
    })) as AssessmentRow[]
    return { assessments: await assessmentViews(client, context, rows, today), canManage: holdsHere(context, SAFETY_RISK_MANAGE), law: DVR_LAW, today }
  })
}

/** GET /safety/risk/counts: what the assessment still owes (the tiles). No money. */
export async function riskCounts(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const soon = addDays(today, 30)
  return caller.withClient(async (client) => {
    const reach = siteScope(context, SAFETY_VIEW)
    const open = await client.riskMeasure.findMany({ where: { AND: [reach, asked(query), { status: { in: [...OPEN_MEASURE_STATUSES] } }] }, select: { dueOn: true } })
    const assessments = await client.riskAssessment.findMany({
      where: { AND: [reach, asked(query), { status: 'ACTIVE' }] },
      select: { id: true, nextReviewOn: true, versions: { where: { status: 'SIGNED' }, select: { id: true }, take: 1 } },
    })
    const sheets = await client.roleSheet.findMany({ where: { AND: [reach, asked(query), { status: 'ACTIVE' }] }, select: { kitLines: { select: { id: true }, take: 1 }, requirements: { select: { id: true }, take: 1 } } })
    const waiting = await client.riskAssessmentVersion.findMany({ where: { AND: [reach, asked(query), { status: 'AWAITING_SIGNATURES' }] }, select: { signersRequired: true, signatures: { select: { role: true, signedOn: true } } } })
    const due = open.map((measure) => dayOrNull(measure.dueOn)).filter((day): day is BusinessDate => day !== null)
    return {
      measuresOverdue: due.filter((day) => day < today).length,
      measuresDueSoon: due.filter((day) => day >= today && day <= soon).length,
      reviewsDue: assessments.filter((row) => row.nextReviewOn !== null && dayOf(row.nextReviewOn) <= soon).length,
      rolesWithoutKitOrTraining: sheets.filter((sheet) => sheet.kitLines.length === 0 || sheet.requirements.length === 0).length,
      signaturesMissing: waiting.reduce((total, version) => total + completion(version.signersRequired as DvrSignerRole[], version.signatures.map((signature) => ({ role: signature.role as DvrSignerRole, signedOn: dayOf(signature.signedOn) }))).missing.length, 0),
      assessments: assessments.length,
      withoutVersion: assessments.filter((row) => row.versions.length === 0).length,
      today,
    }
  })
}

/** GET /safety/risk/assessments/:assessmentId. */
export async function assessmentRecord(caller: CommandCaller, assessmentId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const row = isUuid(assessmentId) ? await readAssessment(client, assessmentId) : null
    if (!row) throw new NotFoundError('Risk assessment not found.')
    assertMayAt(context, SAFETY_VIEW, row, 'Risk assessment')
    const versions = await client.riskAssessmentVersion.findMany({ where: { assessmentId }, orderBy: [{ versionNo: 'desc' }], select: VERSION_SELECT })
    const organisation = await organisationOf(client, row.companyId)
    const measures = await client.riskMeasure.findMany({ where: { assessmentId }, select: { status: true, dueOn: true, createdAt: true, doneAt: true, cancelledAt: true } })
    const states = measures.map((measure) => measureDueState({ status: measure.status as MeasureStatus, dueOn: dayOrNull(measure.dueOn) }, today))
    const closedOn = (measure: (typeof measures)[number]): BusinessDate | null =>
      measure.status === 'CANCELLED' && measure.cancelledAt ? romeDay(measure.cancelledAt) : (measure.status === 'DONE' || measure.status === 'VERIFIED') && measure.doneAt ? romeDay(measure.doneAt) : null
    const place = { companyId: row.companyId, siteId: row.siteId }
    return {
      assessment: (await assessmentViews(client, context, [row], today))[0]!,
      versions: await versionViews(client, context, versions, today),
      next: (({ signers, sameAs, missingEmployer }) => ({ signers: [...signers], sameAs: [...sameAs], missingEmployer }))(signersFor(organisation.appointments, row.siteId, today)),
      plan: {
        open: measures.filter((measure) => OPEN_MEASURE_STATUSES.includes(measure.status as MeasureStatus)).length,
        overdue: states.filter((state) => state === 'OVERDUE').length,
        dueSoon: states.filter((state) => state === 'DUE_SOON').length,
        done: measures.filter((measure) => measure.status === 'DONE').length,
        verified: measures.filter((measure) => measure.status === 'VERIFIED').length,
        cancelled: measures.filter((measure) => measure.status === 'CANCELLED').length,
        burn: burnDown(measures.map((measure) => ({ addedOn: romeDay(measure.createdAt), closedOn: closedOn(measure) })), addDays(today, -364), today),
      },
      may: { manage: mayAt(context, SAFETY_RISK_MANAGE, place), sign: mayAt(context, SAFETY_RISK_SIGN, place), upload: mayAt(context, FILES_UPLOAD, { companyId: row.companyId, siteId: null }) },
      law: { dvr: DVR_LAW, versions: VERSIONS_LAW, plan: PLAN_LAW, review: REVIEW_LAW },
      today,
    }
  })
}

async function viewOf(tools: Pick<CommandTools, 'tx' | 'context' | 'now'>, id: string) {
  const row = (await readAssessment(tools.tx, id))!
  return (await assessmentViews(tools.tx, tools.context as OfficeContext, [row], todayOf(tools.now)))[0]!
}

/** A name not taken by another assessment of the site (case aside). */
async function checkName(tools: Pick<CommandTools, 'tx'>, siteId: string, name: string, except: string | null): Promise<void> {
  const taken = await tools.tx.riskAssessment.findFirst({ where: { siteId, name: { equals: name, mode: 'insensitive' }, ...(except ? { id: { not: except } } : {}) }, select: { id: true } })
  if (taken) refuse('NAME_TAKEN', 'This site has an assessment of that name already: one per site or production unit.', 'name')
}

export interface AssessmentBody {
  readonly companyId: string
  readonly siteId: string
  readonly name: string
  readonly nextReviewOn?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
}

/** POST /safety/risk/assessments. */
export async function addAssessment(caller: CommandCaller, body: AssessmentBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertMayWriteAt(context, SAFETY_RISK_MANAGE, { companyId: body.companyId, siteId: body.siteId }, MANAGE_WORDS)
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'safety.addAssessment', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const site = await tx.site.findUnique({ where: { id: body.siteId }, select: { companyId: true } })
    if (!site || site.companyId !== body.companyId) refuse('SITE_OTHER_COMPANY', 'The site is one of the company’s sites.', 'siteId')
    refuseWith(farRefusal(body.nextReviewOn, todayOf(now), 'nextReviewOn'))
    const name = body.name.trim()
    await checkName(tools, body.siteId, name, null)
    await tx.riskAssessment.create({
      data: { id, companyId: body.companyId, siteId: body.siteId, name, nextReviewOn: body.nextReviewOn ? dateOf(body.nextReviewOn) : null, note: body.note?.trim() || null, createdAt: now, updatedAt: now, createdById: actorIdOf(tools.context) },
      select: { id: true },
    })
    tools.audit({ action: 'safety.addAssessment', recordType: 'RiskAssessment', recordId: id, companyId: body.companyId, siteId: body.siteId, after: { name, nextReviewOn: body.nextReviewOn ?? null } })
    tools.emit({ type: 'risk_assessment.changed', subject: id, companyId: body.companyId, siteId: body.siteId, payload: { assessmentId: id, change: 'ADDED', nextReviewOn: body.nextReviewOn ?? null } })
    return { assessment: await viewOf(tools, id) }
  })
  return { ...result, replayed }
}

/** The assessment the caller may change (404 when it may not read it, 403 when it may not change it). */
export async function writableAssessment(caller: CommandCaller, assessmentId: string, permission: Permission = SAFETY_RISK_MANAGE): Promise<AssessmentRow> {
  const context = officeOf(caller)
  const row = isUuid(assessmentId) ? await caller.withClient((client) => readAssessment(client, assessmentId)) : null
  if (!row) throw new NotFoundError('Risk assessment not found.')
  assertMayAt(context, SAFETY_VIEW, row, 'Risk assessment')
  assertMayWriteAt(context, permission, row, MANAGE_WORDS)
  return row
}

/** PATCH /safety/risk/assessments/:assessmentId: its name, next review, note. */
export async function editAssessment(caller: CommandCaller, assessmentId: string, body: { readonly version: number; readonly name?: string | undefined; readonly nextReviewOn?: BusinessDate | null | undefined; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  await writableAssessment(caller, assessmentId)
  const { result } = await command(caller, { name: 'safety.editAssessment', idempotencyKey, input: { assessmentId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "RiskAssessment" WHERE "id" = ${assessmentId}::uuid FOR UPDATE`
    const row = (await readAssessment(tx, assessmentId))!
    assertVersion('risk assessment', row.version, body.version)
    if (body.nextReviewOn !== undefined) refuseWith(farRefusal(body.nextReviewOn, todayOf(now), 'nextReviewOn'))
    const name = body.name?.trim()
    if (name !== undefined && name !== row.name) await checkName(tools, row.siteId, name, row.id)
    await tx.riskAssessment.update({
      where: { id: assessmentId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(body.nextReviewOn !== undefined ? { nextReviewOn: body.nextReviewOn ? dateOf(body.nextReviewOn) : null } : {}),
        ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}),
        version: { increment: 1 },
        updatedAt: now,
      },
      select: { id: true },
    })
    const before = { name: row.name, nextReviewOn: dayOrNull(row.nextReviewOn), note: row.note }
    const after = { ...before, ...(name !== undefined ? { name } : {}), ...(body.nextReviewOn !== undefined ? { nextReviewOn: body.nextReviewOn } : {}), ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}) }
    tools.audit({ action: 'safety.editAssessment', recordType: 'RiskAssessment', recordId: assessmentId, companyId: row.companyId, siteId: row.siteId, before, after })
    tools.emit({ type: 'risk_assessment.changed', subject: assessmentId, companyId: row.companyId, siteId: row.siteId, payload: { assessmentId, change: 'EDITED', nextReviewOn: after.nextReviewOn ?? null } })
    return { assessment: await viewOf(tools, assessmentId) }
  })
  return result
}
