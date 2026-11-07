import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { SAFETY_HEALTH_VIEWS } from '@nexus/factory-domain/safety/health/permissions'
import { HEALTH_LIMITS, PROTECTED_HEALTH_LAW, type HealthViewRecord, type ViewWhat } from '@nexus/factory-domain/safety/health/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertMay, officeOf } from './access'
import { FITNESS_CHECK_ACTION } from './fitness'
import { nameOf, userNames } from './store'

/**
 * "Who looked" (B-W2b-135; QHS-256; design plant.health pop-up "Who looked" (Row ⋯, HR, DPO): viewer · time · what; "Every view
 * is recorded and visible to the DPO"; GDPR arts. 5(2), 30, 32): the protected view log of the health records, for HR and the
 * data protection officer (safety.health.views over the person's company and site).
 *
 *   GET /safety/health/views?recordType=HEALTH_VISIT|FITNESS_JUDGEMENT&recordId=   who opened, copied or printed one record
 *   GET /safety/health/views?employeeId=                                           every view of one person's health records,
 *                                                                                  and who checked their fitness yes or no
 *   GET /safety/health/views?companyId=&lists=true                                 who listed or printed the due list
 *
 * Reading the log records nothing (it holds no health value: who looked, when, at what). Newest first.
 */

const VIEW_SELECT = { id: true, companyId: true, recordType: true, recordId: true, employeeId: true, what: true, viewerId: true, viewedAt: true, employee: { select: { firstName: true, lastName: true } } } as const satisfies Prisma.ProtectedViewSelect
const HEALTH_RECORDS = ['HEALTH_VISIT', 'FITNESS_JUDGEMENT', 'HEALTH_VISIT_LIST'] as const

export async function healthViews(caller: CommandCaller, query: { readonly recordType?: 'HEALTH_VISIT' | 'FITNESS_JUDGEMENT' | undefined; readonly recordId?: string | undefined; readonly employeeId?: string | undefined; readonly companyId?: string | undefined; readonly lists?: boolean | undefined; readonly limit?: number | undefined }) {
  const context = officeOf(caller)
  const take = query.limit ?? HEALTH_LIMITS.views
  const modes = [query.recordId !== undefined, query.employeeId !== undefined, query.lists === true].filter(Boolean).length
  if (modes !== 1 || (query.recordId !== undefined) !== (query.recordType !== undefined) || (query.lists === true && !query.companyId)) {
    throw new ValidationError('Ask for one record (recordType and recordId), one person (employeeId), or a company’s lists (companyId and lists=true).', [{ path: 'query', message: 'One of: recordType + recordId, employeeId, companyId + lists=true.' }])
  }
  return caller.withClient(async (client) => {
    let where: Prisma.ProtectedViewWhereInput
    let personId: string | null = null
    if (query.recordId) {
      const owner = query.recordType === 'HEALTH_VISIT'
        ? await client.healthVisit.findUnique({ where: { id: query.recordId }, select: { employee: { select: { id: true, companyId: true, siteId: true } } } })
        : await client.fitnessJudgement.findUnique({ where: { id: query.recordId }, select: { employee: { select: { id: true, companyId: true, siteId: true } } } })
      if (!owner) throw new NotFoundError('Record not found.')
      assertMay(context, SAFETY_HEALTH_VIEWS, owner.employee, 'Record')
      where = { recordType: query.recordType!, recordId: query.recordId }
    } else if (query.employeeId) {
      const person = await client.employee.findUnique({ where: { id: query.employeeId }, select: { id: true, companyId: true, siteId: true } })
      if (!person) throw new NotFoundError('Employee not found.')
      assertMay(context, SAFETY_HEALTH_VIEWS, person, 'Employee')
      where = { employeeId: person.id, recordType: { in: ['HEALTH_VISIT', 'FITNESS_JUDGEMENT'] } }
      personId = person.id
    } else {
      // A company's lists: the permission over the whole company (a list may name people of every site).
      const companyId = query.companyId!
      if ((context.companyId && context.companyId !== companyId) || !can(actorOf(context), SAFETY_HEALTH_VIEWS, { companyId })) throw new NotFoundError('Company not found.')
      where = { companyId, recordType: 'HEALTH_VISIT_LIST' }
    }
    const rows = await client.protectedView.findMany({ where: { AND: [where, { recordType: { in: [...HEALTH_RECORDS] } }] }, orderBy: [{ viewedAt: 'desc' }, { id: 'desc' }], take, select: VIEW_SELECT })
    const checks = personId
      ? await client.auditLog.findMany({ where: { recordType: 'Employee', recordId: personId, action: FITNESS_CHECK_ACTION }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take, select: { actorId: true, at: true } })
      : []
    const users = await userNames(client, [...rows.map((row) => row.viewerId), ...checks.map((row) => row.actorId)])
    return {
      views: rows.map((row) => ({
        id: row.id,
        viewer: { id: row.viewerId, name: users.get(row.viewerId) ?? '' },
        viewedAt: row.viewedAt.toISOString(),
        recordType: row.recordType as HealthViewRecord,
        recordId: row.recordId,
        what: row.what as ViewWhat,
        employee: row.employeeId && row.employee ? { id: row.employeeId, name: nameOf(row.employee) } : null,
      })),
      fitnessChecks: checks.map((row) => ({ viewer: { id: row.actorId, name: users.get(row.actorId) ?? '' }, at: row.at.toISOString() })),
      law: PROTECTED_HEALTH_LAW,
    }
  })
}
