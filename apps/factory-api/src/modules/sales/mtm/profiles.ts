import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import type { Measures } from '@nexus/factory-domain/product/mtm-rules/rules'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import type { NewProfileBody, NewRevisionBody, ProfilesQuery } from '@nexus/factory-domain/sales/mtm/contracts'
import { SALES_MTM_RECORD, SALES_MTM_REVIEW } from '@nexus/factory-domain/sales/mtm/permissions'
import { isOld, measuredValuesOf, outsidePoints, reviewRefusal, type ReviewStatus } from '@nexus/factory-domain/sales/mtm/rules'
import { WORKSHEET_KIND } from '@nexus/factory-domain/sales/mtm/worksheet'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { linkRuleChecks } from '../measure-link/checks'
import {
  assertMayProfile,
  chainOf,
  latestOf,
  measuredPointsOf,
  measurementsOf,
  namesOf,
  nextFittingOf,
  officeOf,
  OPEN_ORDER_STATES,
  pointViewsOf,
  PROFILE_RECORD,
  PROFILE_SELECT,
  profileNotFound,
  profileOf,
  revisionViewOf,
  templateOfGarment,
  unitsOf,
  type ProfileRow,
  type Reader,
} from './store'

/**
 * Rider profiles (B-W2b-358; B-W1-18 deferred on 10-28 comes back here; SAL-285, SAL-291; design sales.mtm "Rider profiles",
 * the record's Measurements tab, mtm.new "New measurements"):
 *
 *   GET  /sales/mtm/profiles                       the newest revision of each rider's garment type the caller reads (q, customer,
 *                                                  garment type, review state, older than 12 months), pages; the tiles: waiting for
 *                                                  the factory review, more asked of the rider, older than 12 months, fittings this
 *                                                  week ("outside the certified range" is per style: null, the record's check says it)
 *   GET  /sales/mtm/profiles/:profileId            the record of any revision: every revision (values, who measured and where, the
 *                                                  review), the template's points, the newest revision's review (may the caller
 *                                                  decide, why not, the template's rules on it, points outside their range), the
 *                                                  made-to-measure units made to the rider's garment type, the worksheets, the next
 *                                                  fitting
 *   POST /sales/mtm/profiles                       revision 1 of a rider's garment type (sales.mtm.record)
 *   POST /sales/mtm/profiles/:profileId/revisions  the next revision of the rider's garment type (sales.mtm.record)
 *
 * A revision the office records: the values against the template's points (factory-domain sales/mtm measuredValuesOf: required
 * points, numbers, a value outside its plausible range asked again until the person confirms it), the template's made-to-measure
 * rules while they are on (B-W2b-248's check through measure-link/checks: a broken BLOCK rule refuses it at its point, a WARN is
 * answered and kept in the audit row), who of ours measured (an active office user, SAL-291) and where, the privacy notice given
 * (revision 1 names it; a later one keeps the newest's unless another is named). ONE command: the row (WAITING for the factory
 * review: the database inserts nothing else), its audit (counts and codes, never a value), measurement_profile.recorded. Every
 * database rule is said in words first (MeasurementProfile_portal_guard, _review_check, the unique revision).
 */

const LIST_CAP = 5000
const FIVE_MINUTES = 5 * 60 * 1000

const invalid = (issues: Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The measurements cannot be saved like this.', issues)
const keyOf = (row: Pick<ProfileRow, 'partyId' | 'riderName' | 'garmentType'>): string => JSON.stringify([row.partyId, row.riderName, row.garmentType])
const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'

// ---- the list -------------------------------------------------------------------------------------------------------------

/** GET /sales/mtm/profiles */
export async function listProfiles(caller: CommandCaller, query: ProfilesQuery) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if (query.partyId !== undefined && !can(actor, SALES_MEASUREMENTS_VIEW, { partyId: query.partyId })) throw new NotFoundError('Customer not found.')
  const now = serverClock.now()
  const today = businessDate(now)
  const where: Prisma.MeasurementProfileWhereInput = {
    AND: [
      scopeWhere(actor, SALES_MEASUREMENTS_VIEW, { party: 'partyId' }) as Prisma.MeasurementProfileWhereInput,
      query.partyId ? { partyId: query.partyId } : {},
      query.garmentType ? { garmentType: query.garmentType } : {},
      query.q ? { OR: [{ riderName: { contains: query.q, mode: 'insensitive' } }, { party: { legalName: { contains: query.q, mode: 'insensitive' } } }, { party: { code: { contains: query.q, mode: 'insensitive' } } }] } : {},
    ],
  }
  return caller.withClient(async (db) => {
    const all = await db.measurementProfile.findMany({ where, select: PROFILE_SELECT, orderBy: [{ partyId: 'asc' }, { riderName: 'asc' }, { garmentType: 'asc' }, { revision: 'desc' }], take: LIST_CAP })
    const chains = new Map<string, ProfileRow[]>()
    for (const row of all) chains.set(keyOf(row), [...(chains.get(keyOf(row)) ?? []), row])
    const latest = [...chains.values()].map((rows) => rows[0]!)
    const tiles = {
      waitingReview: latest.filter((row) => row.reviewStatus === 'WAITING').length,
      needMore: latest.filter((row) => row.reviewStatus === 'NEED_MORE').length,
      older: latest.filter((row) => isOld(businessDate(row.takenAt), today)).length,
      fittingsThisWeek: 0,
      outsideRange: null,
    }
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay()
    const monday = addDays(today, -((weekday + 6) % 7))
    tiles.fittingsThisWeek = await db.appointment.count({
      where: { AND: [scopeWhere(actor, SALES_MEASUREMENTS_VIEW, { party: 'partyId' }) as Prisma.AppointmentWhereInput, { kind: 'FITTING', status: { in: ['BOOKED', 'DONE'] }, startsAt: { gte: businessDayStart(monday), lt: businessDayStart(addDays(monday, 7)) } }] },
    })
    const shown = latest
      .filter((row) => (query.review ? row.reviewStatus === query.review : true))
      .filter((row) => (query.old === undefined ? true : isOld(businessDate(row.takenAt), today) === (query.old === 'true')))
      .sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime() || (a.id < b.id ? -1 : 1))
    const page = shown.slice(query.offset, query.offset + query.limit)
    const parties = new Map((page.length === 0 ? [] : await db.party.findMany({ where: { id: { in: [...new Set(page.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
    const chainIds = new Map(page.map((row) => [row.id, (chains.get(keyOf(row)) ?? []).map((revision) => revision.id)]))
    const allIds = [...chainIds.values()].flat()
    const open = allIds.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { kind: 'MADE_TO_MEASURE', measurementProfileId: { in: allIds }, closedShortAt: null, order: { status: { in: [...OPEN_ORDER_STATES] } } }, select: { measurementProfileId: true } })
    const fittings = allIds.length === 0 ? [] : await db.appointment.findMany({ where: { measurementProfileId: { in: allIds }, kind: 'FITTING', status: 'BOOKED', startsAt: { gte: now } }, select: { measurementProfileId: true, startsAt: true }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] })
    return {
      rows: page.map((row) => {
        const ids = new Set(chainIds.get(row.id) ?? [])
        const party = parties.get(row.partyId)
        const fitting = fittings.find((entry) => entry.measurementProfileId !== null && ids.has(entry.measurementProfileId))
        return {
          id: row.id,
          partyId: row.partyId,
          customer: { code: party?.code ?? '', name: party?.legalName ?? '' },
          contactId: row.contactId,
          riderName: row.riderName,
          garmentType: row.garmentType,
          revision: row.revision,
          takenAt: toUtcIso(row.takenAt),
          takenBy: row.takenBy,
          measuredPlace: row.measuredPlace,
          baseSize: row.baseSize,
          review: { status: row.reviewStatus as ReviewStatus, at: row.reviewedAt ? toUtcIso(row.reviewedAt) : null },
          byLink: row.submittedViaLinkId !== null,
          privacyNoticeAt: toUtcIso(row.privacyNoticeAt),
          old: isOld(businessDate(row.takenAt), today),
          openUnits: open.filter((line) => line.measurementProfileId !== null && ids.has(line.measurementProfileId)).length,
          nextFittingAt: fitting ? toUtcIso(fitting.startsAt) : null,
        }
      }),
      matching: shown.length,
      tiles,
      asOf: toUtcIso(now),
    }
  })
}

// ---- the record -----------------------------------------------------------------------------------------------------------

/** Where a "need more" goes: the rider's contact, else the address the revision's link went to, else the customer's orders contact. */
export async function mailTargetOf(db: Reader, row: Pick<ProfileRow, 'partyId' | 'contactId' | 'submittedViaLinkId'>): Promise<{ email: string; language: string | null } | null> {
  if (row.contactId) {
    const contact = await db.partyContact.findFirst({ where: { id: row.contactId, partyId: row.partyId, status: 'ACTIVE', email: { not: null } }, select: { email: true, language: true } })
    if (contact?.email) return { email: contact.email.trim().toLowerCase(), language: contact.language }
  }
  if (row.submittedViaLinkId) {
    const link = await db.oneOffLink.findUnique({ where: { id: row.submittedViaLinkId }, select: { email: true } })
    if (link?.email) return { email: link.email.trim().toLowerCase(), language: null }
  }
  const orders = await db.partyContact.findFirst({ where: { partyId: row.partyId, status: 'ACTIVE', roles: { has: 'ORDERS' }, email: { not: null } }, select: { email: true, language: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return orders?.email ? { email: orders.email.trim().toLowerCase(), language: orders.language } : null
}

/** The newest revision's review as the caller may make it (see the record's head). */
function reviewMay(context: OfficeContext, latest: ProfileRow, latestRevision: number, now: Date) {
  const holds = can(actorOf(context), SALES_MTM_REVIEW, { partyId: latest.partyId })
  const facts = { status: latest.reviewStatus as ReviewStatus, revision: latest.revision, latestRevision, measuredByUserId: latest.measuredByUserId, takenAt: latest.takenAt, submittedAt: latest.submittedAt, reviewedAt: latest.reviewedAt }
  const confirm = reviewRefusal(facts, 'CONFIRM', context.actorId, now)
  const askMore = reviewRefusal(facts, 'NEED_MORE', context.actorId, now)
  return { may: { confirm: holds && confirm === null, askMore: holds && askMore === null }, why: holds ? (confirm ?? askMore) : 'Your roles do not review measurements (sales.mtm.review).' }
}

/** GET /sales/mtm/profiles/:profileId */
export async function getProfile(caller: CommandCaller, profileId: string) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const row = await caller.withClient((db) => profileOf(db, profileId))
  if (!row) throw profileNotFound()
  assertMayProfile(context, row.partyId)
  return caller.withClient(async (db) => {
    const chain = await chainOf(db, row)
    const latest = chain.at(-1)!
    const party = await db.party.findUnique({ where: { id: row.partyId }, select: { code: true, legalName: true } })
    const template = await templateOfGarment(db, row.garmentType)
    const ids = chain.map((revision) => revision.id)
    const worksheets = await db.generatedDocument.findMany({ where: { recordType: PROFILE_RECORD, recordId: { in: ids }, kind: WORKSHEET_KIND }, select: { id: true, recordId: true, version: true, companyId: true, language: true, number: true, fileId: true, createdAt: true, createdById: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    const names = await namesOf(db, [...chain.flatMap((revision) => [revision.measuredByUserId, revision.reviewedById]), ...worksheets.map((sheet) => sheet.createdById)])
    const latestValues = measurementsOf(latest.measurements)
    const checks = await linkRuleChecks(db, latest.garmentType, latestValues as Measures, 'en')
    const target = await mailTargetOf(db, latest)
    const units = await unitsOf(db, ids)
    const nextFitting = await nextFittingOf(db, ids, now)
    const actor = actorOf(context)
    return {
      id: row.id,
      partyId: row.partyId,
      customer: { code: party?.code ?? '', name: party?.legalName ?? '' },
      contactId: latest.contactId,
      riderName: row.riderName,
      garmentType: row.garmentType,
      latestId: latest.id,
      revisions: [...chain].reverse().map((revision) => revisionViewOf(revision, names, now)),
      template: template ? { id: template.id, code: template.code, name: template.name, rulesOn: template.rulesOn, points: pointViewsOf(template) } : null,
      review: { ...reviewMay(context, latest, latest.revision, now), checks: { on: checks.on, warnings: checks.warnings, blocks: checks.blocks.map((issue) => ({ path: issue.path.replace('body/values/', 'measurements/'), message: issue.message })) }, outside: template ? outsidePoints(latestValues, measuredPointsOf(template)) : [], mailTo: target !== null },
      units,
      worksheets: worksheets.map((sheet) => ({ id: sheet.id, profileId: sheet.recordId, revision: chain.find((revision) => revision.id === sheet.recordId)?.revision ?? 0, version: sheet.version, companyId: sheet.companyId, language: sheet.language, number: sheet.number, fileId: sheet.fileId, createdAt: toUtcIso(sheet.createdAt), createdBy: sheet.createdById ? (names.get(sheet.createdById) ?? null) : null })),
      nextFittingAt: nextFitting ? toUtcIso(nextFitting) : null,
      may: { record: can(actor, SALES_MTM_RECORD, { partyId: row.partyId }), worksheet: can(actor, SALES_MTM_RECORD, { partyId: row.partyId }) },
    }
  })
}

// ---- record a revision ----------------------------------------------------------------------------------------------------

interface RevisionPlan {
  readonly partyId: string
  readonly contactId: string | null
  readonly riderName: string
  readonly garmentType: string
  readonly supersedes: ProfileRow | null
  readonly body: NewRevisionBody & { readonly privacyNoticeRef: string; readonly privacyNoticeAt: string }
}

/** The values, the measurer and the times checked in words (see the file's head); the stored values and the rules' warnings. */
async function checkRevision(db: Reader, plan: RevisionPlan, now: Date) {
  const template = await templateOfGarment(db, plan.garmentType)
  if (!template) throw invalid([{ path: 'body/garmentType', message: `${plan.garmentType} has no measurement template: a measurement template names the points to measure (Products › Sizes & measurements).` }])
  if (template.status !== 'ACTIVE') throw new ConflictError(`Measurement template ${template.code} is archived: restore it before measuring for it.`)
  const values = measuredValuesOf(plan.body.measurements, measuredPointsOf(template), plan.body.confirmedOutside ?? [])
  const problems: Issue[] = [...values.problems]
  const takenAt = new Date(plan.body.takenAt)
  const noticeAt = new Date(plan.body.privacyNoticeAt)
  if (takenAt.getTime() > now.getTime() + FIVE_MINUTES) problems.push({ path: 'body/takenAt', message: 'When the rider was measured: not in the future.' })
  if (noticeAt.getTime() > takenAt.getTime()) problems.push({ path: 'body/privacyNoticeAt', message: 'The privacy notice is given before any value is taken (GDPR art. 13).' })
  let measurer: { id: string; displayName: string } | null = null
  if (plan.body.measuredByUserId) {
    const user = isUuid(plan.body.measuredByUserId) ? await db.user.findUnique({ where: { id: plan.body.measuredByUserId }, select: { id: true, displayName: true, audience: true, status: true } }) : null
    if (!user || user.audience !== 'OFFICE' || user.status !== 'ACTIVE') problems.push({ path: 'body/measuredByUserId', message: 'An active office person of ours (a dealer’s fitter is named in takenBy).' })
    else measurer = { id: user.id, displayName: user.displayName }
  }
  const takenBy = plan.body.takenBy ?? measurer?.displayName ?? null
  if (!takenBy) problems.push({ path: 'body/takenBy', message: 'Say who measured (the fitter, the dealer, the rider), or name the office person who did.' })
  if (plan.contactId) {
    const contact = await db.partyContact.findFirst({ where: { id: plan.contactId, partyId: plan.partyId, status: 'ACTIVE' }, select: { id: true } })
    if (!contact) problems.push({ path: 'body/contactId', message: 'Not an active contact of this customer.' })
  }
  // B-W2b-248: the template's made-to-measure rules, only while they are on (a broken BLOCK rule refuses the revision at its point).
  const checks = await linkRuleChecks(db, plan.garmentType, values.measurements as Measures, 'en')
  problems.push(...checks.blocks.map((issue) => ({ path: issue.path.replace('body/values/', 'body/measurements/'), message: issue.message })))
  if (problems.length > 0) throw invalid(problems)
  return { values, takenAt, noticeAt, takenBy: takenBy!, measurer, checks }
}

async function writeRevision(caller: CommandCaller, plan: RevisionPlan, name: 'mtm.recordProfile' | 'mtm.recordRevision', idempotencyKey?: string) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const checked = await caller.withClient((db) => checkRevision(db, plan, now))
  const { result } = await command(caller, { name, idempotencyKey, input: plan.body }, async (tools) => {
    const latest = await latestOf(tools.tx, plan)
    if (plan.supersedes === null && latest) throw new ConflictError(`${plan.riderName} has ${plan.garmentType} measures already (revision ${latest.revision}): record a new revision of them.`)
    if (plan.supersedes !== null && latest?.id !== plan.supersedes.id) throw new ConflictError(`A newer revision of ${plan.riderName}'s ${plan.garmentType} measures was recorded meanwhile (revision ${latest?.revision ?? '?'}): read it, then record yours.`)
    const id = newId()
    const revision = (latest?.revision ?? 0) + 1
    try {
      await tools.tx.measurementProfile.create({
        data: {
          id,
          partyId: plan.partyId,
          contactId: plan.contactId,
          riderName: plan.riderName,
          garmentType: plan.garmentType,
          revision,
          supersedesId: latest?.id ?? null,
          measurements: checked.values.measurements,
          baseSize: plan.body.baseSize ?? null,
          fitNotes: plan.body.fitNotes ?? null,
          internalNote: plan.body.internalNote ?? null,
          takenAt: checked.takenAt,
          takenBy: checked.takenBy,
          privacyNoticeRef: plan.body.privacyNoticeRef,
          privacyNoticeAt: checked.noticeAt,
          measuredByUserId: checked.measurer?.id ?? null,
          measuredPlace: plan.body.measuredPlace ?? null,
          createdAt: tools.now,
          createdById: context.actorId,
        },
        select: { id: true },
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(`Revision ${revision} of ${plan.riderName}'s ${plan.garmentType} measures was recorded meanwhile: read it, then record yours.`)
      throw error
    }
    tools.audit({
      recordType: PROFILE_RECORD,
      recordId: id,
      after: {
        revision,
        supersedesId: latest?.id ?? null,
        garmentType: plan.garmentType,
        points: Object.keys(checked.values.measurements).length,
        outsideConfirmed: checked.values.outside,
        measuredByUserId: checked.measurer?.id ?? null,
        measuredPlace: plan.body.measuredPlace ?? null,
        privacyNoticeRef: plan.body.privacyNoticeRef,
        ...(checked.checks.on ? { mtmWarnings: checked.checks.warnings.map((warning) => warning.code) } : {}),
      },
    })
    tools.emit({ type: 'measurement_profile.recorded', subject: id, payload: { profileId: id, partyId: plan.partyId, garmentType: plan.garmentType, revision, supersedesId: latest?.id ?? null } })
    return { id }
  })
  return caller.withClient(async (db) => {
    const row = (await profileOf(db, result.id))!
    const names = await namesOf(db, [row.measuredByUserId])
    return { profile: revisionViewOf(row, names, now), checks: { on: checked.checks.on, warnings: checked.checks.warnings, blocks: [] } }
  })
}

/** POST /sales/mtm/profiles */
export async function recordProfile(caller: CommandCaller, body: NewProfileBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertMayProfile(context, body.partyId, SALES_MTM_RECORD)
  const party = await caller.withClient((db) => db.party.findUnique({ where: { id: body.partyId }, select: { id: true } }))
  if (!party) throw new NotFoundError('Customer not found.')
  const { partyId, contactId, riderName, garmentType, ...rest } = body
  return writeRevision(caller, { partyId, contactId: contactId ?? null, riderName, garmentType, supersedes: null, body: rest }, 'mtm.recordProfile', idempotencyKey)
}

/** POST /sales/mtm/profiles/:profileId/revisions */
export async function recordRevision(caller: CommandCaller, profileId: string, body: NewRevisionBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => profileOf(db, profileId))
  if (!row) throw profileNotFound()
  assertMayProfile(context, row.partyId, SALES_MTM_RECORD)
  const latest = (await caller.withClient((db) => latestOf(db, row)))!
  if ((body.privacyNoticeRef === undefined) !== (body.privacyNoticeAt === undefined)) throw invalid([{ path: 'body/privacyNoticeRef', message: 'Name the notice and when it was given together, or neither (the newest revision’s stays).' }])
  const notice = { privacyNoticeRef: body.privacyNoticeRef ?? latest.privacyNoticeRef, privacyNoticeAt: body.privacyNoticeAt ?? toUtcIso(latest.privacyNoticeAt) }
  return writeRevision(caller, { partyId: latest.partyId, contactId: latest.contactId, riderName: latest.riderName, garmentType: latest.garmentType, supersedes: latest, body: { ...body, ...notice } }, 'mtm.recordRevision', idempotencyKey)
}
