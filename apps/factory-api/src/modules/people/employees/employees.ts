import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { isPinLocked } from '@nexus/factory-domain/auth/floor/pin'
import { EMPLOYEES_IMPORTER_KEY } from '@nexus/factory-domain/people/employees/importer'
import { PEOPLE_EMPLOYEES_MANAGE, PEOPLE_VIEW } from '@nexus/factory-domain/people/employees/permissions'
import { addDays, nextStepsOf, type EmployeeKind, type EmployeeRows, type EmployeeStatus, type EmployeeTile } from '@nexus/factory-domain/people/employees/rules'
import { PEOPLE_LEAVERS_MANAGE } from '@nexus/factory-domain/people/leavers/permissions'
import { loanStateOf } from '@nexus/factory-domain/people/teams/rules'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { countingAcks, workerNoticeGate, workerNoticeRule } from '../../../platform/privacy/read'
import { assertMay, dateOf, dayOf, dayOrNull, may, officeOf, scopeOf, todayOf } from './access'
import { caseViewOf, CASE_SELECT } from './cases'
import { EMPLOYEE_SELECT, employeeView, employeeViews, nameOf, readEmployee, type EmployeeRow } from './store'

/**
 * The employee reads (B-W2b-26; MES-208, MES-211; design people.employees SCR-084 list, SCR-085 record), office only,
 * people.view over each record's company and site.
 *
 *   GET /people/employees                         the HR register: a tile's or the toolbar's rows, a site, a company,
 *                                                 types, a team, a home line, words; last name order, pages
 *   GET /people/employees/counts                  the tiles and the notice banner's data problems
 *   GET /people/employees/unlinked-workers        floor workers with no employee record ("Link them")
 *   GET /people/employees/:employeeId             the record: profile, floor sign-in (read only), job & team, loans,
 *                                                 team history, the leaver steps, the next steps, what we do not keep
 *   GET /people/employees/import/:jobId/missing   who is in Nexus but not in an employees import's file
 *
 * Nothing here reads attendance, pay, health or a figure about one person's work (Statuto dei Lavoratori art. 4).
 */

type Client = FactoryClient | CommandTx

const SORT: Prisma.EmployeeOrderByWithRelationInput[] = [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }]

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly companyId?: string | undefined
  readonly tile?: Exclude<EmployeeTile, 'UNLINKED_WORKERS'> | undefined
  readonly rows?: EmployeeRows | undefined
  readonly kind?: readonly EmployeeKind[] | undefined
  readonly teamId?: string | undefined
  readonly lineId?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const OPEN_CASE: Prisma.EmployeeWhereInput = { leaverCases: { some: { status: 'OPEN' } } }

/** A tile's saved filter (design: a tile puts its chip in the filter row; one filter model). */
export function tileWhere(tile: Exclude<EmployeeTile, 'UNLINKED_WORKERS'>, today: BusinessDate): Prisma.EmployeeWhereInput {
  switch (tile) {
    case 'ACTIVE':
      return { status: 'ACTIVE', startDate: { lte: dateOf(today) } }
    case 'STARTING':
      return { status: 'ACTIVE', startDate: { gt: dateOf(today), lte: dateOf(addDays(today, 14)) } }
    case 'LEAVING':
      return { status: 'ACTIVE', ...OPEN_CASE }
    case 'AGENCY_ENDING':
      return { status: 'ACTIVE', kind: 'AGENCY', endDate: { gte: dateOf(today), lte: dateOf(addDays(today, 30)) } }
  }
}

function rowsWhere(rows: EmployeeRows | undefined): Prisma.EmployeeWhereInput {
  switch (rows) {
    case undefined:
      return { status: 'ACTIVE' }
    case 'AGENCY':
      return { status: 'ACTIVE', kind: 'AGENCY' }
    case 'LEAVING':
      return { status: 'ACTIVE', ...OPEN_CASE }
    case 'MISSING_DATA':
      return { status: 'ACTIVE', employeeCode: null }
    case 'LEFT':
      return { status: 'LEFT' }
    case 'ALL':
      return {}
  }
}

/** GET /people/employees: last name order; a cursor is the last row's id. */
export async function listEmployees(caller: CommandCaller, query: ListQuery, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const where: Prisma.EmployeeWhereInput = {
    AND: [
      scopeOf(context, PEOPLE_VIEW) as Prisma.EmployeeWhereInput,
      query.siteId ? { siteId: query.siteId } : {},
      query.companyId ? { companyId: query.companyId } : {},
      query.tile ? tileWhere(query.tile, today) : rowsWhere(query.rows),
      query.kind && query.kind.length > 0 ? { kind: { in: [...query.kind] } } : {},
      query.teamId ? { teamMemberships: { some: { teamId: query.teamId, until: null } } } : {},
      query.lineId ? { homeLineId: query.lineId } : {},
      query.q
        ? {
            OR: [
              { firstName: { contains: query.q, mode: 'insensitive' } },
              { lastName: { contains: query.q, mode: 'insensitive' } },
              { displayName: { contains: query.q, mode: 'insensitive' } },
              { employeeCode: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {},
    ],
  }
  return caller.withClient(async (client) => {
    let after: Prisma.EmployeeWhereInput = {}
    if (query.cursor) {
      const last = await client.employee.findUnique({ where: { id: query.cursor }, select: { lastName: true, firstName: true, id: true } })
      if (last) {
        after = {
          OR: [
            { lastName: { gt: last.lastName } },
            { lastName: last.lastName, firstName: { gt: last.firstName } },
            { lastName: last.lastName, firstName: last.firstName, id: { gt: last.id } },
          ],
        }
      }
    }
    const rows = await client.employee.findMany({ where: { AND: [where, after] }, orderBy: SORT, take: query.limit + 1, select: EMPLOYEE_SELECT })
    const page = rows.slice(0, query.limit)
    return { employees: await employeeViews(client, page, today), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null, today }
  })
}

/** The floor workers of the caller's sites that have no employee record (ACTIVE ones). */
function unlinkedWhere(context: ReturnType<typeof officeOf>, query: { readonly siteId?: string | undefined; readonly companyId?: string | undefined }): Prisma.WorkerWhereInput {
  return {
    AND: [scopeOf(context, PEOPLE_VIEW) as Prisma.WorkerWhereInput, query.siteId ? { siteId: query.siteId } : {}, query.companyId ? { companyId: query.companyId } : {}, { employeeId: null, status: 'ACTIVE' }],
  }
}

/** How many linked, active floor sign-ins of active records have not acknowledged the worker notice in force. */
async function noticeMissingCount(client: Client, where: Prisma.EmployeeWhereInput): Promise<number> {
  const workers = await client.worker.findMany({ where: { status: 'ACTIVE', employee: { is: { AND: [where, { status: 'ACTIVE' }] } } }, select: { id: true, siteId: true } })
  let missing = 0
  const bySite = new Map<string, string[]>()
  for (const worker of workers) bySite.set(worker.siteId, [...(bySite.get(worker.siteId) ?? []), worker.id])
  for (const [siteId, ids] of bySite) {
    const counting = countingAcks(await workerNoticeRule(client, siteId))
    if (counting === null) continue
    const acked = await client.workerNoticeAck.findMany({ where: { ...counting, siteId, workerId: { in: ids } }, select: { workerId: true }, distinct: ['workerId'] })
    missing += ids.length - acked.length
  }
  return missing
}

/** GET /people/employees/counts. */
export async function employeeCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly companyId?: string | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const base: Prisma.EmployeeWhereInput = { AND: [scopeOf(context, PEOPLE_VIEW) as Prisma.EmployeeWhereInput, query.siteId ? { siteId: query.siteId } : {}, query.companyId ? { companyId: query.companyId } : {}] }
  return caller.withClient(async (client) => {
    const count = (where: Prisma.EmployeeWhereInput) => client.employee.count({ where: { AND: [base, where] } })
    const tiles = {
      ACTIVE: await count(tileWhere('ACTIVE', today)),
      STARTING: await count(tileWhere('STARTING', today)),
      LEAVING: await count(tileWhere('LEAVING', today)),
      AGENCY_ENDING: await count(tileWhere('AGENCY_ENDING', today)),
      UNLINKED_WORKERS: await client.worker.count({ where: unlinkedWhere(context, query) }),
    }
    const noCode = await count({ status: 'ACTIVE', employeeCode: null, kind: { not: 'AGENCY' } })
    const noticeMissing = await noticeMissingCount(client, base)
    const problems = [
      { code: 'NOTICE_NOT_ACKNOWLEDGED' as const, count: noticeMissing },
      { code: 'NO_EMPLOYEE_CODE' as const, count: noCode },
      { code: 'UNLINKED_WORKERS' as const, count: tiles.UNLINKED_WORKERS },
    ].filter((problem) => problem.count > 0)
    return { tiles, problems }
  })
}

const UNLINKED_LIMIT = 500

/** GET /people/employees/unlinked-workers: floor workers with no employee record, by site and floor name. */
export async function unlinkedWorkers(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const rows = await client.worker.findMany({
      where: unlinkedWhere(context, query),
      orderBy: [{ siteId: 'asc' }, { displayName: 'asc' }, { id: 'asc' }],
      take: UNLINKED_LIMIT + 1,
      select: { id: true, siteId: true, displayName: true, employeeCode: true, locale: true, status: true, createdAt: true, site: { select: { code: true, name: true } } },
    })
    return {
      workers: rows.slice(0, UNLINKED_LIMIT).map((row) => ({
        id: row.id,
        site: { id: row.siteId, code: row.site.code, name: row.site.name },
        displayName: row.displayName,
        employeeCode: row.employeeCode,
        locale: row.locale,
        status: row.status as 'ACTIVE' | 'INACTIVE',
        createdAt: toUtcIso(row.createdAt),
      })),
      complete: rows.length <= UNLINKED_LIMIT,
    }
  })
}

/** Office users' names by id (one read). */
export async function userNames(client: Client, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((value): value is string => value !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await client.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

const NOT_KEPT = ['ADDRESS', 'TAX_CODE', 'IBAN', 'DATE_OF_BIRTH', 'PHOTO', 'HEALTH_DATA', 'BIOMETRICS'] as const

/** The record's floor sign-ins as the panel shows them (read only: one edit path, Admin › Users). */
async function floorSignInsOf(client: Client, employeeId: string, now: Date) {
  const workers = await client.worker.findMany({
    where: { employeeId },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      siteId: true,
      displayName: true,
      status: true,
      pinHash: true,
      pinMustChange: true,
      pinLockedUntil: true,
      failedPinAttempts: true,
      site: { select: { code: true, name: true } },
      badges: { where: { status: 'ACTIVE' }, orderBy: { issuedAt: 'desc' }, take: 1, select: { issuedAt: true, hint: true } },
      roles: { where: { endedAt: null }, orderBy: { createdAt: 'asc' }, select: { role: { select: { key: true, name: true } } } },
    },
  })
  const answer = []
  for (const worker of workers) {
    const gate = await workerNoticeGate(client, worker.siteId, worker.id)
    const badge = worker.badges[0]
    answer.push({
      workerId: worker.id,
      site: { id: worker.siteId, code: worker.site.code, name: worker.site.name },
      displayName: worker.displayName,
      status: worker.status as 'ACTIVE' | 'INACTIVE',
      badge: { state: badge ? ('ACTIVE' as const) : ('NONE' as const), since: badge ? toUtcIso(badge.issuedAt) : null, hint: badge?.hint ?? null },
      pin: worker.pinHash === null ? ('NONE' as const) : isPinLocked(worker, now) ? ('LOCKED' as const) : worker.pinMustChange ? ('MUST_CHANGE' as const) : ('SET' as const),
      lockedUntil: worker.pinLockedUntil && isPinLocked(worker, now) ? toUtcIso(worker.pinLockedUntil) : null,
      notice: { state: gate.noticeId === null ? ('NONE_IN_FORCE' as const) : gate.acknowledged ? ('ACKNOWLEDGED' as const) : ('MISSING' as const), label: gate.label },
      floorRoles: worker.roles.map((entry) => ({ key: entry.role.key, name: entry.role.name })),
    })
  }
  return answer
}

/** GET /people/employees/:employeeId. */
export async function employeeRecord(caller: CommandCaller, employeeId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const row = isUuid(employeeId) ? await readEmployee(client, employeeId) : null
    if (!row) throw new NotFoundError('Employee not found.')
    assertMay(context, PEOPLE_VIEW, row, 'Employee')
    const employee = await employeeView(client, row, today)
    const floorSignIns = await floorSignInsOf(client, row.id, now)
    const account = row.userId ? await client.user.findUnique({ where: { id: row.userId }, select: { id: true, status: true } }) : null
    const loans = await client.lineLoan.findMany({
      where: { employeeId: row.id },
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: { id: true, startsAt: true, endsAt: true, reason: true, createdById: true, version: true, fromLine: { select: { id: true, code: true, name: true } }, toLine: { select: { id: true, code: true, name: true } }, toTeam: { select: { id: true, code: true, name: true } } },
    })
    const history = await client.teamMember.findMany({ where: { employeeId: row.id }, orderBy: [{ since: 'desc' }, { id: 'desc' }], take: 50, select: { isLead: true, since: true, until: true, team: { select: { id: true, code: true, name: true } } } })
    const leaving = await client.leaverCase.findFirst({ where: { employeeId: row.id }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], select: CASE_SELECT })
    const lastAudit = await client.auditLog.findFirst({ where: { recordType: 'Employee', recordId: row.id }, orderBy: [{ at: 'desc' }], select: { at: true, actorId: true, audience: true } })
    const names = await userNames(client, [...loans.map((loan) => loan.createdById), lastAudit?.audience === 'OFFICE' ? lastAudit.actorId : null, leaving?.startedById ?? null, ...(leaving?.steps.map((step) => step.doneById) ?? [])])
    const noticeMissing = floorSignIns.filter((signIn) => signIn.status === 'ACTIVE' && signIn.notice.state === 'MISSING').length
    return {
      employee,
      floorSignIns,
      officeAccount: account ? { userId: account.id, status: account.status } : null,
      nextSteps: nextStepsOf(
        {
          status: row.status as EmployeeStatus,
          startDate: dayOf(row.startDate),
          endDate: dayOrNull(row.endDate),
          kind: row.kind as EmployeeKind,
          leaving: employee.leaving !== null,
          employeeCode: row.employeeCode,
          noticeMissing,
          lastWorkingDay: employee.leaving?.lastWorkingDay ?? null,
        },
        today,
      ),
      loans: loans.map((loan) => ({
        id: loan.id,
        fromLine: loan.fromLine,
        toLine: loan.toLine,
        toTeam: loan.toTeam,
        startsAt: toUtcIso(loan.startsAt),
        endsAt: toUtcIso(loan.endsAt),
        state: loanStateOf(loan, now),
        reason: loan.reason,
        decidedBy: loan.createdById ? (names.get(loan.createdById) ?? null) : null,
        version: loan.version,
      })),
      teamHistory: history.map((entry) => ({ team: entry.team, isLead: entry.isLead, since: dayOf(entry.since), until: dayOrNull(entry.until) })),
      leaving: leaving ? caseViewOf(leaving, names) : null,
      notKept: [...NOT_KEPT],
      lastChange: lastAudit ? { at: toUtcIso(lastAudit.at), by: lastAudit.audience === 'OFFICE' ? (names.get(lastAudit.actorId) ?? null) : null } : null,
      canManage: may(context, PEOPLE_EMPLOYEES_MANAGE, row),
      canLeave: may(context, PEOPLE_LEAVERS_MANAGE, row),
      today,
    }
  })
}

/** GET /people/employees/import/:jobId/missing: active records of the job's company whose code the file does not have. */
export async function importMissing(caller: CommandCaller, jobId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const job = await client.importJob.findUnique({ where: { id: jobId }, select: { id: true, importerKey: true, companyId: true, status: true } })
    if (!job || job.importerKey !== EMPLOYEES_IMPORTER_KEY || job.companyId === null) throw new NotFoundError('Employees import not found.')
    const rows = await client.importRow.findMany({ where: { jobId }, select: { key: true } })
    const codes = new Set(rows.flatMap((row) => (row.key === null ? [] : [(JSON.parse(row.key) as unknown[])[0]])).filter((code): code is string => typeof code === 'string'))
    const employees: EmployeeRow[] = await client.employee.findMany({
      where: { AND: [scopeOf(context, PEOPLE_VIEW) as Prisma.EmployeeWhereInput, { companyId: job.companyId, status: 'ACTIVE', employeeCode: { not: null } }] },
      orderBy: SORT,
      take: 2000,
      select: EMPLOYEE_SELECT,
    })
    const missing = employees.filter((row) => !codes.has(row.employeeCode!))
    const sites = new Map((await client.site.findMany({ where: { id: { in: [...new Set(missing.map((row) => row.siteId))] } }, select: { id: true, code: true, name: true } })).map((site) => [site.id, site]))
    const leaving = new Set((await client.leaverCase.findMany({ where: { employeeId: { in: missing.map((row) => row.id) }, status: 'OPEN' }, select: { employeeId: true } })).map((row) => row.employeeId))
    return {
      jobId,
      missing: missing.map((row) => ({ id: row.id, employeeCode: row.employeeCode!, name: nameOf(row), site: sites.get(row.siteId) ?? { id: row.siteId, code: '', name: '' }, leaving: leaving.has(row.id) })),
    }
  })
}
