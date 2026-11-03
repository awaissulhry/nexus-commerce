import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, holds, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { SAFETY_ORGANISATION_MANAGE, SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { missingRoles, ORGANISATION_LAW, ORGANISATION_LIMITS, RLS_NOTICE_LAW, SAFETY_ROLES, type RlsNoticeStatus, type SafetyRole } from '@nexus/factory-domain/safety/organisation/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { asked, assertMayAt, dateOf, dayOf, dayOrNull, officeOf, placeScope, todayOf } from './access'
import { APPOINTMENT_SELECT, appointmentViews, NOTICE_SELECT, noticeViews, type AppointmentRow } from './store'

/**
 * The safety organisation's reads (B-W2b-120; QHS-224, QHS-226; design plant.calendar sections Safety organisation and RLS
 * notice to INAIL), office only, safety.view, each row checked with can() against its company and site:
 *
 *   GET /safety/organisation              who holds each role (in force and later; `ended=true` the history too), the roles
 *                                         nobody holds today, the companies and sites the caller reaches
 *   GET /safety/appointments/:id          one appointment with its RLS notices
 *   GET /safety/rls-notices               the RLS notices to INAIL, pending first
 *   GET /safety/organisation/people       the Appointment dialog's people of a company (ACTIVE; names only)
 *   GET /safety/organisation/contacts     its outside contacts (organisations of the company or the group, their contacts)
 *   GET /safety/organisation/shifts       its shifts (first-aid and fire teams per shift)
 */

const roleOrder = (role: string): number => SAFETY_ROLES.indexOf(role as SafetyRole)
const byRole = (a: AppointmentRow, b: AppointmentRow): number =>
  a.company.code.localeCompare(b.company.code) || roleOrder(a.role) - roleOrder(b.role) || (a.site?.code ?? '').localeCompare(b.site?.code ?? '') || a.fromDate.getTime() - b.fromDate.getTime() || a.id.localeCompare(b.id)

/** The caller holds the permission at the screen's company (or anywhere, when the screen names none). */
const holdsHere = (context: OfficeContext, permission: Permission): boolean => (context.companyId ? can(actorOf(context), permission, { companyId: context.companyId }) : holds(actorOf(context), permission))

/** The companies and sites the caller reads the organisation of (ACTIVE), narrowed as asked. */
async function placesOf(client: FactoryClient, context: OfficeContext, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }) {
  const actor = actorOf(context)
  const companies = await client.company.findMany({
    where: { AND: [scopeWhere(actor, SAFETY_VIEW, { company: 'id' }) as Prisma.CompanyWhereInput, { status: 'ACTIVE' }, context.companyId ? { id: context.companyId } : {}, query.companyId ? { id: query.companyId } : {}] },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
    select: { id: true, code: true, legalName: true },
  })
  const sites = await client.site.findMany({
    where: { AND: [scopeWhere(actor, SAFETY_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, { status: 'ACTIVE', companyId: { in: companies.map((company) => company.id) } }, query.siteId ? { id: query.siteId } : {}] },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
    select: { id: true, companyId: true, code: true, name: true },
  })
  return companies.map((company) => ({ id: company.id, code: company.code, name: company.legalName, sites: sites.filter((site) => site.companyId === company.id).map((site) => ({ id: site.id, code: site.code, name: site.name })) }))
}

/** GET /safety/organisation. */
export async function readOrganisation(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined; readonly ended?: boolean | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const reach = placeScope(context, SAFETY_VIEW) as Prisma.SafetyAppointmentWhereInput
    const rows = (await client.safetyAppointment.findMany({
      where: { AND: [reach, asked(query) as Prisma.SafetyAppointmentWhereInput, query.ended ? {} : { OR: [{ untilDate: null }, { untilDate: { gte: dateOf(today) } }] }] },
      take: ORGANISATION_LIMITS.list,
      select: APPOINTMENT_SELECT,
    })) as AppointmentRow[]
    rows.sort(byRole)
    const companies = await placesOf(client, context, query)
    const missing = missingRoles(
      companies.map((company) => ({ companyId: company.id, siteIds: company.sites.map((site) => site.id) })),
      rows.map((row) => ({ companyId: row.companyId, siteId: row.siteId, role: row.role as SafetyRole, fromDate: dayOf(row.fromDate), untilDate: dayOrNull(row.untilDate) })),
      today,
    )
    return {
      appointments: await appointmentViews(client, context, rows, today),
      missing,
      companies,
      canManage: holdsHere(context, SAFETY_ORGANISATION_MANAGE),
      canUpload: holdsHere(context, FILES_UPLOAD),
      law: ORGANISATION_LAW,
      today,
    }
  })
}

/** The roles nobody holds today in the caller's reach (the tile), narrowed as asked. */
export async function missingCount(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }, now: Date = new Date()): Promise<number> {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const rows = await client.safetyAppointment.findMany({
      where: { AND: [placeScope(context, SAFETY_VIEW) as Prisma.SafetyAppointmentWhereInput, asked(query) as Prisma.SafetyAppointmentWhereInput, { fromDate: { lte: dateOf(today) } }, { OR: [{ untilDate: null }, { untilDate: { gte: dateOf(today) } }] }] },
      select: { companyId: true, siteId: true, role: true, fromDate: true, untilDate: true },
    })
    const companies = await placesOf(client, context, query)
    return missingRoles(
      companies.map((company) => ({ companyId: company.id, siteIds: company.sites.map((site) => site.id) })),
      rows.map((row) => ({ companyId: row.companyId, siteId: row.siteId, role: row.role as SafetyRole, fromDate: dayOf(row.fromDate), untilDate: dayOrNull(row.untilDate) })),
      today,
    ).length
  })
}

/** GET /safety/appointments/:appointmentId. */
export async function appointmentRecord(caller: CommandCaller, appointmentId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const row = isUuid(appointmentId) ? ((await client.safetyAppointment.findUnique({ where: { id: appointmentId }, select: APPOINTMENT_SELECT })) as AppointmentRow | null) : null
    if (!row) throw new NotFoundError('Appointment not found.')
    assertMayAt(context, SAFETY_VIEW, row, 'Appointment')
    const notices = await client.rlsNotice.findMany({ where: { appointmentId: row.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: NOTICE_SELECT })
    return { appointment: (await appointmentViews(client, context, [row], today))[0]!, notices: await noticeViews(client, context, notices), today }
  })
}

const STATUS_RANK: Readonly<Record<RlsNoticeStatus, number>> = { PENDING: 0, FILED: 1, CANCELLED: 2 }

/** GET /safety/rls-notices: pending first (soonest due), then the filed and cancelled ones, newest first. */
export async function listNotices(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly status: RlsNoticeStatus | 'ALL'; readonly limit: number }, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const rows = await client.rlsNotice.findMany({
      where: { AND: [{ appointment: placeScope(context, SAFETY_VIEW) as Prisma.SafetyAppointmentWhereInput }, query.companyId ? { companyId: query.companyId } : {}, query.status === 'ALL' ? {} : { status: query.status }] },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      select: NOTICE_SELECT,
    })
    rows.sort((a, b) => STATUS_RANK[a.status as RlsNoticeStatus] - STATUS_RANK[b.status as RlsNoticeStatus] || (a.status === 'PENDING' ? a.dueOn.getTime() - b.dueOn.getTime() : 0))
    return { notices: await noticeViews(client, context, rows), canManage: holdsHere(context, SAFETY_ORGANISATION_MANAGE), law: RLS_NOTICE_LAW, today: todayOf(now) }
  })
}

const PICK = 200

/** The company, when the caller may appoint there (else a 404, as a record it cannot see). */
async function companyForPicking(client: FactoryClient, context: OfficeContext, companyId: string) {
  const company = isUuid(companyId) ? await client.company.findUnique({ where: { id: companyId }, select: { id: true } }) : null
  if (!company) throw new NotFoundError('Company not found.')
  assertMayAt(context, SAFETY_ORGANISATION_MANAGE, { companyId, siteId: null }, 'Company')
  return company
}

const words = (q: string | undefined): string[] => (q ?? '').trim().split(/\s+/).filter((word) => word !== '').slice(0, 4)

/** GET /safety/organisation/people: ACTIVE people of the company, by name (names and codes only). */
export async function pickPeople(caller: CommandCaller, query: { readonly companyId: string; readonly q?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    await companyForPicking(client, context, query.companyId)
    const rows = await client.employee.findMany({
      where: {
        companyId: query.companyId,
        status: 'ACTIVE',
        AND: words(query.q).map((word) => ({ OR: [{ firstName: { contains: word, mode: 'insensitive' as const } }, { lastName: { contains: word, mode: 'insensitive' as const } }, { displayName: { contains: word, mode: 'insensitive' as const } }, { employeeCode: { contains: word, mode: 'insensitive' as const } }] })),
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      take: PICK + 1,
      select: { id: true, firstName: true, lastName: true, employeeCode: true, siteId: true, site: { select: { code: true, name: true } } },
    })
    return { people: rows.slice(0, PICK).map((row) => ({ id: row.id, name: `${row.firstName} ${row.lastName}`, employeeCode: row.employeeCode, site: { id: row.siteId, code: row.site.code, name: row.site.name } })), complete: rows.length <= PICK }
  })
}

/** GET /safety/organisation/contacts: organisations of the company or the group (ACTIVE), each with its contacts. */
export async function pickContacts(caller: CommandCaller, query: { readonly companyId: string; readonly q?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    await companyForPicking(client, context, query.companyId)
    const parties = await client.party.findMany({
      where: {
        kind: 'ORGANISATION',
        status: 'ACTIVE',
        OR: [{ companyId: query.companyId }, { companyId: null }],
        AND: words(query.q).map((word) => ({ OR: [{ legalName: { contains: word, mode: 'insensitive' as const } }, { code: { contains: word, mode: 'insensitive' as const } }, { contacts: { some: { name: { contains: word, mode: 'insensitive' as const } } } }] })),
      },
      orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
      take: PICK + 1,
      select: { id: true, legalName: true, contacts: { where: { status: 'ACTIVE' }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true, name: true, email: true, phone: true } } },
    })
    const contacts = parties.slice(0, PICK).flatMap((party) => [
      { partyId: party.id, partyName: party.legalName, contactId: null, name: party.legalName, email: null, phone: null },
      ...party.contacts.map((contact) => ({ partyId: party.id, partyName: party.legalName, contactId: contact.id, name: contact.name, email: contact.email, phone: contact.phone })),
    ])
    return { contacts, complete: parties.length <= PICK }
  })
}

/** GET /safety/organisation/shifts: the company's shifts and the group's (ACTIVE). */
export async function pickShifts(caller: CommandCaller, query: { readonly companyId: string }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    await companyForPicking(client, context, query.companyId)
    const shifts = await client.shiftPattern.findMany({ where: { status: 'ACTIVE', OR: [{ companyId: query.companyId }, { companyId: null }] }, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: PICK, select: { id: true, code: true, name: true } })
    return { shifts }
  })
}
