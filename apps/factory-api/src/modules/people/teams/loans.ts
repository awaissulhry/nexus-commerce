import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_VIEW } from '@nexus/factory-domain/people/employees/permissions'
import { PEOPLE_LOANS_MANAGE } from '@nexus/factory-domain/people/teams/permissions'
import { endLoanRefusal, loanProblems, loanStateOf, loansOverlap } from '@nexus/factory-domain/people/teams/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorIdOf, assertMay, assertMayWrite, assertVersion, officeOf, problemsError, refuse, scopeOf, todayOf } from '../employees/access'
import { userNames } from '../employees/employees'
import { nameOf } from '../employees/store'
import { loansOfDay } from './teams'

/**
 * Loans to another line (B-W2b-26; MES-210; design people.employees "Loan to another line", the record's "Loans to
 * other lines"), office only, people.view to read, people.loans.manage to write, checked with can() against the
 * person's company and site.
 *
 *   GET  /people/loans                   the loans that touch a day (default today) at the caller's sites
 *   POST /people/loans                   lend a person to another line of their site (and a team on it) for some hours or
 *                                        days, with the reason; who decided is kept; never two at once for one person
 *   POST /people/loans/:loanId/end       end a running loan early (only the end moves)
 *   POST /people/loans/:loanId/remove    remove a loan that has not begun
 *
 * The overlap check takes the database guard's own lock (factory.people.loan|tenant|employee) first, so two requests for
 * one person queue and the second gets the words, not the trigger's error.
 */

type Client = FactoryClient | CommandTx

const LOAN_SELECT = {
  id: true,
  siteId: true,
  employeeId: true,
  startsAt: true,
  endsAt: true,
  reason: true,
  createdById: true,
  version: true,
  fromLine: { select: { id: true, code: true, name: true } },
  toLine: { select: { id: true, code: true, name: true } },
  toTeam: { select: { id: true, code: true, name: true } },
  employee: { select: { firstName: true, lastName: true, companyId: true } },
} as const satisfies Prisma.LineLoanSelect
type LoanRow = Prisma.LineLoanGetPayload<{ select: typeof LOAN_SELECT }>

async function loanViews(client: Client, rows: readonly LoanRow[], now: Date) {
  const names = await userNames(client, rows.map((row) => row.createdById))
  const sites = new Map((await client.site.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.siteId))] } }, select: { id: true, code: true, name: true } })).map((site) => [site.id, site]))
  return rows.map((row) => ({
    id: row.id,
    site: sites.get(row.siteId) ?? { id: row.siteId, code: '', name: '' },
    employeeId: row.employeeId,
    name: nameOf(row.employee),
    fromLine: row.fromLine,
    toLine: row.toLine,
    toTeam: row.toTeam,
    startsAt: toUtcIso(row.startsAt),
    endsAt: toUtcIso(row.endsAt),
    state: loanStateOf(row, now),
    reason: row.reason,
    decidedBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
    version: row.version,
  }))
}

const readLoan = (client: Client, id: string): Promise<LoanRow | null> => client.lineLoan.findUnique({ where: { id }, select: LOAN_SELECT })
const placedOf = (row: LoanRow) => ({ companyId: row.employee.companyId, siteId: row.siteId })

/** GET /people/loans. */
export async function listLoans(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly date?: BusinessDate | undefined; readonly lineId?: string | undefined; readonly employeeId?: string | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const date = query.date ?? todayOf(now)
  return caller.withClient(async (client) => {
    const touching = await loansOfDay(client, date, {
      AND: [
        { employee: scopeOf(context, PEOPLE_VIEW) as Prisma.EmployeeWhereInput },
        query.siteId ? { siteId: query.siteId } : {},
        query.lineId ? { OR: [{ toLineId: query.lineId }, { fromLineId: query.lineId }] } : {},
        query.employeeId ? { employeeId: query.employeeId } : {},
      ],
    })
    const rows = touching.length === 0 ? [] : await client.lineLoan.findMany({ where: { id: { in: touching.map((row) => row.id) } }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], select: LOAN_SELECT })
    return { loans: await loanViews(client, rows, now), date }
  })
}

const MANAGE_WORDS = 'Loans of this site are made by a role that lends people (people.loans.manage).'

export interface CreateLoanBody {
  readonly employeeId: string
  readonly toLineId: string
  readonly toTeamId?: string | null | undefined
  readonly startsAt: string
  readonly endsAt: string
  readonly reason: string
}

/** POST /people/loans. */
export async function createLoan(caller: CommandCaller, body: CreateLoanBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const startsAt = parseInstant(body.startsAt)!
  const endsAt = parseInstant(body.endsAt)!
  const employee = isUuid(body.employeeId) ? await caller.withClient((client) => client.employee.findUnique({ where: { id: body.employeeId }, select: { id: true, companyId: true, siteId: true } })) : null
  if (!employee) throw new NotFoundError('Employee not found.')
  assertMay(context, PEOPLE_VIEW, employee, 'Employee')
  assertMayWrite(context, PEOPLE_LOANS_MANAGE, employee, MANAGE_WORDS)
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'people.lendToLine', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const tenantId = (tools.context as { readonly tenantId: string }).tenantId
    // The guard's own lock first: two loans of one person are decided one after the other.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.people.loan', ${tenantId}::uuid, ${body.employeeId}::uuid), 0))`
    const person = (await tx.employee.findUnique({ where: { id: body.employeeId }, select: { id: true, companyId: true, siteId: true, status: true, homeLineId: true } }))!
    if (person.status !== 'ACTIVE') refuse('LEFT', 'This person has left: they are lent to no line.', 'employeeId')
    const problems = loanProblems({ startsAt, endsAt, reason: body.reason, fromLineId: person.homeLineId, toLineId: body.toLineId })
    if (problems.length > 0) throw problemsError(problems, 'The loan is not valid.')
    const line = await tx.line.findUnique({ where: { id: body.toLineId }, select: { siteId: true, status: true, code: true } })
    if (!line || line.siteId !== person.siteId) refuse('LINE_NOT_OF_SITE', "A loan is to another line of the person's own site.", 'toLineId')
    if (line!.status !== 'ACTIVE') refuse('LINE_NOT_OF_SITE', `Line ${line!.code} is archived.`, 'toLineId')
    if (body.toTeamId) {
      const team = await tx.team.findUnique({ where: { id: body.toTeamId }, select: { siteId: true, lineId: true, status: true, code: true } })
      if (!team || team.siteId !== person.siteId) refuse('TEAM_OTHER_SITE', 'The team is a team of the same site.', 'toTeamId')
      if (team!.status !== 'ACTIVE') refuse('TEAM_ARCHIVED', `Team ${team!.code} is archived.`, 'toTeamId')
      if (team!.lineId !== null && team!.lineId !== body.toLineId) refuse('TEAM_OTHER_LINE', `Team ${team!.code} works on another line: pick a team of line ${line!.code}.`, 'toTeamId')
    }
    const others = await tx.lineLoan.findMany({ where: { employeeId: person.id, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } }, select: { startsAt: true, endsAt: true } })
    const clash = others.find((other) => loansOverlap(other, { startsAt, endsAt }))
    if (clash) refuse('LOAN_OVERLAP', `The person is already lent from ${toUtcIso(clash.startsAt)} to ${toUtcIso(clash.endsAt)}: one loan at a time.`, 'startsAt')
    await tx.lineLoan.create({
      data: { id, siteId: person.siteId, employeeId: person.id, fromLineId: person.homeLineId, toLineId: body.toLineId, toTeamId: body.toTeamId ?? null, startsAt, endsAt, reason: body.reason.trim(), createdAt: now, updatedAt: now, createdById: actorIdOf(tools.context) },
      select: { id: true },
    })
    tools.audit({ action: 'people.lendToLine', recordType: 'Employee', recordId: person.id, companyId: person.companyId, siteId: person.siteId, after: { loanId: id, fromLineId: person.homeLineId, toLineId: body.toLineId, toTeamId: body.toTeamId ?? null, startsAt: toUtcIso(startsAt), endsAt: toUtcIso(endsAt), reason: body.reason.trim() } })
    tools.emit({ type: 'line_loan.changed', subject: id, companyId: person.companyId, siteId: person.siteId, payload: { loanId: id, employeeId: person.id, toLineId: body.toLineId, toTeamId: body.toTeamId ?? null, change: 'MADE' } })
    const [view] = await loanViews(tx, [(await readLoan(tx, id))!], now)
    return { loan: view! }
  })
  return { ...result, replayed }
}

async function writableLoan(caller: CommandCaller, loanId: string): Promise<LoanRow> {
  const context = officeOf(caller)
  const loan = isUuid(loanId) ? await caller.withClient((client) => readLoan(client, loanId)) : null
  if (!loan) throw new NotFoundError('Loan not found.')
  assertMay(context, PEOPLE_VIEW, placedOf(loan), 'Loan')
  assertMayWrite(context, PEOPLE_LOANS_MANAGE, placedOf(loan), MANAGE_WORDS)
  return loan
}

/** POST /people/loans/:loanId/end: a running loan ends early (now, or the time given). */
export async function endLoan(caller: CommandCaller, loanId: string, body: { readonly version: number; readonly endsAt?: string | undefined }, idempotencyKey?: string) {
  await writableLoan(caller, loanId)
  const { result } = await command(caller, { name: 'people.endLoan', idempotencyKey, input: { loanId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "LineLoan" WHERE "id" = ${loanId}::uuid FOR UPDATE`
    const loan = (await readLoan(tx, loanId))!
    assertVersion('loan', loan.version, body.version)
    const at = body.endsAt ? parseInstant(body.endsAt)! : now
    const refusal = endLoanRefusal(loan, at, now)
    if (refusal) refuse(loanStateOf(loan, now) === 'PLANNED' ? 'LOAN_NOT_BEGUN' : 'LOAN_ENDED', refusal, 'endsAt')
    await tx.lineLoan.update({ where: { id: loan.id }, data: { endsAt: at, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'people.endLoan', recordType: 'Employee', recordId: loan.employeeId, companyId: loan.employee.companyId, siteId: loan.siteId, before: { loanId: loan.id, endsAt: toUtcIso(loan.endsAt) }, after: { loanId: loan.id, endsAt: toUtcIso(at) } })
    tools.emit({ type: 'line_loan.changed', subject: loan.id, companyId: loan.employee.companyId, siteId: loan.siteId, payload: { loanId: loan.id, employeeId: loan.employeeId, toLineId: loan.toLine.id, toTeamId: loan.toTeam?.id ?? null, change: 'ENDED' } })
    const [view] = await loanViews(tx, [(await readLoan(tx, loan.id))!], now)
    return { loan: view! }
  })
  return result
}

/** POST /people/loans/:loanId/remove: only a loan that has not begun (a mistake). */
export async function removeLoan(caller: CommandCaller, loanId: string, body: { readonly version: number }, idempotencyKey?: string) {
  await writableLoan(caller, loanId)
  const { result } = await command(caller, { name: 'people.removeLoan', idempotencyKey, input: { loanId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "LineLoan" WHERE "id" = ${loanId}::uuid FOR UPDATE`
    const loan = (await readLoan(tx, loanId))!
    assertVersion('loan', loan.version, body.version)
    if (loanStateOf(loan, now) !== 'PLANNED') refuse('LOAN_BEGUN', 'The loan has begun: end it early instead (its hours stay on record).')
    await tx.lineLoan.delete({ where: { id: loan.id }, select: { id: true } })
    tools.audit({ action: 'people.removeLoan', recordType: 'Employee', recordId: loan.employeeId, companyId: loan.employee.companyId, siteId: loan.siteId, before: { loanId: loan.id, toLineId: loan.toLine.id, startsAt: toUtcIso(loan.startsAt), endsAt: toUtcIso(loan.endsAt) }, after: { removed: true } })
    tools.emit({ type: 'line_loan.changed', subject: loan.id, companyId: loan.employee.companyId, siteId: loan.siteId, payload: { loanId: loan.id, employeeId: loan.employeeId, toLineId: loan.toLine.id, toTeamId: loan.toTeam?.id ?? null, change: 'REMOVED' } })
    return { removed: loan.id }
  })
  return result
}
