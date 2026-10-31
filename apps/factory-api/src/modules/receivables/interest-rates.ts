import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { grantsFor } from '@nexus/factory-domain/core/permissions'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { InterestRateBody, InterestRatePatchBody } from '@nexus/factory-domain/receivables/contracts'
import { halfYearEndOf, halfYearStartOf, halfYearWords, missingHalfYears, rateProblems, statutoryRateOf, statutoryRateWords } from '@nexus/factory-domain/receivables/interest'
import { RECEIVABLES_SETTINGS_MANAGE, RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import type { CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { mayEveryCompany, officeContextOf, pctText, peopleOf, receivablesCommand, today, type Reader } from './store'

/**
 * The half-year reference rates of statutory late-payment interest (B-W2b-21; FIN-110; B-W2a-55's gap "STATUTORY interest
 * has no amount"; D.Lgs. 231/2002 art. 5; factory-db receivables.prisma InterestReferenceRate, tenant-wide). Finance types
 * the rate the Ministry published for each half-year (the ECB's main refinancing rate on 1 January or 1 July) and the
 * points the law adds, with where it was published; factory-domain receivables/interest computes the statutory amount of
 * a reminder from them and NEVER assumes a rate (a half-year without its row: no amount, said in words). The figures
 * and the wording stay the accountant's (GATE-ACCOUNTANT).
 *
 *   GET   /receivables/interest-rates               receivables.view: the rows, newest first; today's half-year (its
 *                                                   statutory rate or why there is none) and the half-years without one
 *   POST  /receivables/interest-rates               receivables.settings.manage over every company (tenant-wide, like the
 *                                                   tenant settings row): a half-year's rate; 409 in words when it exists
 *   PATCH /receivables/interest-rates/:rateId       the same: corrects the rate, the points, the source or the note at the
 *                                                   version read (the half-year never changes: another one is a new row)
 * Every write is ONE command (the row FOR UPDATE at its version), audited, with interest_rate.recorded | changed. A
 * corrected rate does not re-price a reminder already prepared (its interest is fixed when it is prepared; cancel it and
 * the ladder prepares it again).
 */

const RATE_COLUMNS = { id: true, halfYearStart: true, referenceRatePct: true, addedPointsPct: true, source: true, note: true, version: true, createdAt: true, createdById: true, updatedAt: true } as const satisfies Prisma.InterestReferenceRateSelect
type RateRow = Prisma.InterestReferenceRateGetPayload<{ select: typeof RATE_COLUMNS }>

const dayOf = (value: Date): BusinessDate => businessDate(value, 'UTC')
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

const plainOf = (row: RateRow) => ({ halfYearStart: dayOf(row.halfYearStart), referenceRatePct: pctText(row.referenceRatePct), addedPointsPct: pctText(row.addedPointsPct), source: row.source })

function rateView(row: RateRow, people: ReadonlyMap<string, string | null>) {
  const plain = plainOf(row)
  return {
    id: row.id,
    halfYearStart: plain.halfYearStart,
    halfYearEnd: halfYearEndOf(plain.halfYearStart),
    referenceRatePct: plain.referenceRatePct,
    addedPointsPct: plain.addedPointsPct,
    statutoryRatePct: statutoryRateOf(plain),
    source: row.source,
    note: row.note,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    createdBy: row.createdById ? { id: row.createdById, name: people.get(row.createdById) ?? null } : null,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** Today's half-year: its statutory rate (null: not recorded), the half-years without a rate up to it, in words. */
export async function statutoryToday(db: Reader, day: BusinessDate = today()) {
  const rows = await db.interestReferenceRate.findMany({ select: RATE_COLUMNS, orderBy: { halfYearStart: 'asc' } })
  const plain = rows.map(plainOf)
  const start = halfYearStartOf(day)
  const current = plain.find((rate) => rate.halfYearStart === start) ?? null
  const from = plain[0] && plain[0].halfYearStart < start ? plain[0].halfYearStart : start
  return { rows, halfYearStart: start, ratePct: current ? statutoryRateOf(current) : null, missing: missingHalfYears(plain, from, day), words: statutoryRateWords(plain, day) }
}

/** May write the tenant-wide rates: receivables.settings.manage over every company. */
function assertMayManage(caller: CommandCaller): void {
  const context = officeContextOf(caller)
  if (!mayEveryCompany(context, RECEIVABLES_SETTINGS_MANAGE)) throw new ForbiddenError('The reference rates hold for every company: they are recorded only by a role over every company.')
}

/** GET /receivables/interest-rates (receivables.view). */
export async function listInterestRates(caller: CommandCaller) {
  const context = officeContextOf(caller)
  if (grantsFor(actorOf(context), RECEIVABLES_VIEW).length === 0) throw new ForbiddenError()
  return caller.withClient(async (db) => {
    const state = await statutoryToday(db)
    const people = await peopleOf(db, state.rows.map((row) => row.createdById))
    return {
      rates: [...state.rows].reverse().map((row) => rateView(row, people)),
      today: { halfYearStart: state.halfYearStart, ratePct: state.ratePct, words: state.words },
      missing: state.missing,
      words: 'The reference rate of each half-year is the one the Ministry published (the ECB rate on 1 January or 1 July); the points are those D.Lgs. 231/2002 art. 5 adds (8 for commercial transactions). Type them with where they were published: the factory never assumes a rate.',
      mayManage: mayEveryCompany(context, RECEIVABLES_SETTINGS_MANAGE),
    }
  })
}

async function oneRate(db: Reader, id: string) {
  const row = await db.interestReferenceRate.findUniqueOrThrow({ where: { id }, select: RATE_COLUMNS })
  return { rate: rateView(row, await peopleOf(db, [row.createdById])) }
}

const audited = (row: Pick<RateRow, 'referenceRatePct' | 'addedPointsPct' | 'source' | 'note'>) => ({ referenceRatePct: pctText(row.referenceRatePct), addedPointsPct: pctText(row.addedPointsPct), source: row.source, note: row.note })

/** POST /receivables/interest-rates (receivables.settings.manage over every company). */
export async function recordInterestRate(caller: CommandCaller, body: InterestRateBody, idempotencyKey?: string) {
  assertMayManage(caller)
  const problems = rateProblems(body)
  if (problems.length > 0) throw new ValidationError('The reference rate is not valid.', problems)
  const exists = (row: Pick<RateRow, 'referenceRatePct' | 'addedPointsPct' | 'version'>) =>
    new DomainError('conflict', `The reference rate of ${halfYearWords(body.halfYearStart)} is recorded already (${pctText(row.referenceRatePct)} % plus ${pctText(row.addedPointsPct)} points, version ${row.version}): correct it instead of adding another.`, [{ path: 'body/halfYearStart', message: 'Recorded already: correct it.' }])
  try {
    const { result } = await receivablesCommand(caller, { name: 'receivables.interestRate', idempotencyKey, input: body }, async (tools) => {
      const { tx, now } = tools
      const same = await tx.interestReferenceRate.findFirst({ where: { halfYearStart: new Date(`${body.halfYearStart}T00:00:00.000Z`) }, select: RATE_COLUMNS })
      if (same) throw exists(same)
      const id = newId()
      const created = await tx.interestReferenceRate.create({
        data: { id, halfYearStart: new Date(`${body.halfYearStart}T00:00:00.000Z`), referenceRatePct: body.referenceRatePct, addedPointsPct: body.addedPointsPct, source: body.source, note: body.note ?? null, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
        select: RATE_COLUMNS,
      })
      tools.audit({ action: 'receivables.interestRate', recordType: 'InterestReferenceRate', recordId: id, companyId: null, after: { halfYearStart: body.halfYearStart, ...audited(created) } })
      tools.emit({ type: 'interest_rate.recorded', subject: id, companyId: null, payload: { rateId: id, halfYearStart: body.halfYearStart } })
      return oneRate(tx, id)
    })
    return result
  } catch (error) {
    // The same half-year recorded meanwhile by someone else (the unique key).
    if (isUniqueViolation(error)) {
      const row = await caller.withClient((db) => db.interestReferenceRate.findFirst({ where: { halfYearStart: new Date(`${body.halfYearStart}T00:00:00.000Z`) }, select: RATE_COLUMNS }))
      if (row) throw exists(row)
    }
    throw error
  }
}

/** PATCH /receivables/interest-rates/:rateId (receivables.settings.manage over every company): a correction at the version read. */
export async function correctInterestRate(caller: CommandCaller, rateId: string, body: InterestRatePatchBody, idempotencyKey?: string) {
  assertMayManage(caller)
  const problems = rateProblems(body)
  if (problems.length > 0) throw new ValidationError('The reference rate is not valid.', problems)
  if (!isUuid(rateId)) throw new NotFoundError('Reference rate not found.')
  const { result } = await receivablesCommand(caller, { name: 'receivables.interestRateCorrect', idempotencyKey, input: { rateId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT id FROM "InterestReferenceRate" WHERE id = ${rateId}::uuid FOR UPDATE`
    const row = await tx.interestReferenceRate.findUnique({ where: { id: rateId }, select: RATE_COLUMNS })
    if (!row) throw new NotFoundError('Reference rate not found.')
    if (row.version !== body.version) throw new DomainError('conflict', `This reference rate changed since it was read (version ${body.version}); it is now at version ${row.version}. Reload it and correct it again.`, [{ path: 'body/version', message: `The current version is ${row.version}.` }])
    const data = {
      ...(body.referenceRatePct !== undefined ? { referenceRatePct: body.referenceRatePct } : {}),
      ...(body.addedPointsPct !== undefined ? { addedPointsPct: body.addedPointsPct } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    }
    const after = await tx.interestReferenceRate.update({ where: { id: rateId }, data: { ...data, version: row.version + 1, updatedAt: now }, select: RATE_COLUMNS })
    const halfYearStart = dayOf(row.halfYearStart)
    tools.audit({ action: 'receivables.interestRateCorrect', recordType: 'InterestReferenceRate', recordId: rateId, companyId: null, before: audited(row), after: audited(after) })
    tools.emit({ type: 'interest_rate.changed', subject: rateId, companyId: null, payload: { rateId, halfYearStart } })
    return oneRate(tx, rateId)
  })
  return result
}
