import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { decimalOfMinor, exportCellOf, isMoneyValue, type StoredValue } from '@nexus/factory-domain/fields/values'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { PEOPLE_VIEW } from '@nexus/factory-domain/people/employees/permissions'
import { PEOPLE_STRUCTURE_MANAGE } from '@nexus/factory-domain/people/structure/permissions'
import { personPicture, teamPicture, type Picture } from '@nexus/factory-domain/people/teams/picture'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { fieldsOfModel, fieldsSeen, referenceWords, valuesOfRecords, type FieldRow } from '../../../platform/fields/registry'
import { assertMay, dayOrNull, officeOf, scopeOf } from '../employees/access'
import { nameOf } from '../employees/store'

/**
 * The factory structure's reads (owb-ss5 steps 5.2 + 5.3; the Shape of owb-ss5.md): office only, people.view over each unit's and
 * person's company and site.
 *
 *   GET /people/structure          the units the caller's scope reaches (closed ones too, marked), the active people of those
 *                                  companies and sites with their unit today, and whether the caller keeps the structure
 *   GET /people/units/:unitId      one unit's profile: what it does, who stands in, the customers it works for (only the ones the
 *                                  caller may see), its own facts (the custom fields of the Team record this person sees), its
 *                                  open order rows (the customer's CODE, never its name; only orders the caller may see), its
 *                                  people and its version
 *
 * A person's picture is their letters (no photo, pick K). The count of a unit's people is the owner's own view of who is where
 * (the Shape types it as a number); no figure about one person's work is read here.
 */

type Client = FactoryClient | CommandTx

export const UNIT_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  lineId: true,
  code: true,
  name: true,
  status: true,
  version: true,
  parentTeamId: true,
  kindWord: true,
  takesOrders: true,
  about: true,
  maxBaskets: true,
  takesNewOrders: true,
  standInEmployeeId: true,
  standInUntil: true,
  worksForPartyIds: true,
  mergedIntoId: true,
  pictureKind: true,
  pictureIcon: true,
  pictureColour: true,
} as const satisfies Prisma.TeamSelect
export type UnitRow = Prisma.TeamGetPayload<{ select: typeof UNIT_SELECT }>

export const readUnit = (client: Client, id: string): Promise<UnitRow | null> => client.team.findUnique({ where: { id }, select: UNIT_SELECT })

/** The unit's row under a row lock (a concurrent change of the same unit waits). */
export async function lockUnit(tx: CommandTx, id: string): Promise<UnitRow> {
  await tx.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${id}::uuid FOR UPDATE`
  const row = await readUnit(tx, id)
  if (!row) throw new NotFoundError('Unit not found.')
  return row
}

/** The structure's own lock (the database's Team_unit_check takes the same one): two changes of the tree wait for each other. */
export async function lockStructure(tx: CommandTx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.team-units', ${tenantId}::uuid), 0))`
}

export interface PersonView {
  readonly employeeId: string
  readonly name: string
  readonly unitId: string | null
  readonly isLeader: boolean
  readonly role: string | null
  readonly picture: Picture
}

export interface UnitView {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly kindWord: string | null
  readonly picture: Picture
  readonly leader: { readonly employeeId: string; readonly name: string } | null
  readonly takesOrders: boolean
  readonly closed: boolean
  readonly siteId: string
  readonly people: number
}

/** The current memberships (TeamMember without an end) of these units, with the person's name and role. */
async function membersOf(client: Client, teamIds: readonly string[]) {
  if (teamIds.length === 0) return []
  return client.teamMember.findMany({
    where: { teamId: { in: [...new Set(teamIds)] }, until: null },
    orderBy: [{ isLead: 'desc' }, { employee: { lastName: 'asc' } }, { employee: { firstName: 'asc' } }, { id: 'asc' }],
    select: { teamId: true, employeeId: true, isLead: true, employee: { select: { firstName: true, lastName: true, jobRole: true } } },
  })
}

/** The structure views of many units, with one read of their members. */
export async function unitViews(client: Client, units: readonly UnitRow[]): Promise<UnitView[]> {
  const members = await membersOf(client, units.map((unit) => unit.id))
  return units.map((unit) => {
    const own = members.filter((member) => member.teamId === unit.id)
    const lead = own.find((member) => member.isLead)
    return {
      id: unit.id,
      parentId: unit.parentTeamId,
      name: unit.name,
      kindWord: unit.kindWord,
      picture: teamPicture({ name: unit.name, pictureKind: unit.pictureKind, pictureIcon: unit.pictureIcon, pictureColour: unit.pictureColour }),
      leader: lead ? { employeeId: lead.employeeId, name: nameOf(lead.employee) } : null,
      takesOrders: unit.takesOrders,
      closed: unit.status !== 'ACTIVE',
      siteId: unit.siteId,
      people: own.length,
    }
  })
}

const personOf = (row: { readonly employeeId: string; readonly isLead: boolean; readonly teamId: string | null; readonly employee: { readonly firstName: string; readonly lastName: string; readonly jobRole: string | null } }): PersonView => {
  const name = nameOf(row.employee)
  return { employeeId: row.employeeId, name, unitId: row.teamId, isLeader: row.isLead, role: row.employee.jobRole, picture: personPicture(name) }
}

/** GET /people/structure. */
export async function structure(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly includeClosed?: boolean | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const units = await client.team.findMany({
      where: { AND: [scopeOf(context, PEOPLE_VIEW) as Prisma.TeamWhereInput, query.siteId ? { siteId: query.siteId } : {}, query.includeClosed === false ? { status: 'ACTIVE' } : {}] },
      orderBy: [{ siteId: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: 2000,
      select: UNIT_SELECT,
    })
    const employees = await client.employee.findMany({
      where: { AND: [scopeOf(context, PEOPLE_VIEW) as Prisma.EmployeeWhereInput, { status: 'ACTIVE' }, query.siteId ? { siteId: query.siteId } : {}] },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      take: 5000,
      select: { id: true, firstName: true, lastName: true, jobRole: true },
    })
    const memberships = employees.length === 0 ? [] : await client.teamMember.findMany({ where: { employeeId: { in: employees.map((row) => row.id) }, until: null }, select: { employeeId: true, teamId: true, isLead: true } })
    const homeOf = new Map(memberships.map((row) => [row.employeeId, row]))
    return {
      units: await unitViews(client, units),
      people: employees.map((employee) => {
        const home = homeOf.get(employee.id)
        return personOf({ employeeId: employee.id, isLead: home?.isLead ?? false, teamId: home?.teamId ?? null, employee })
      }),
      may: { manage: holds(actorOf(context), PEOPLE_STRUCTURE_MANAGE) },
    }
  })
}

/** A custom value as one line of words (the unit's own facts; a money value only reached a person who holds its grain). */
function factText(field: FieldRow, value: StoredValue, words: (id: string) => string | null): string | null {
  if (field.type === 'MONEY') return isMoneyValue(value) ? `${decimalOfMinor(value)} ${value.currency}` : null
  const cell = exportCellOf(field, value, 'en', words)
  if (cell === null) return null
  if (typeof cell === 'string') return cell
  if (typeof cell === 'number') return field.unit ? `${cell} ${field.unit}` : String(cell)
  if ('day' in cell) return cell.day
  if ('decimal' in cell) return cell.decimal
  if ('at' in cell) return cell.at
  return null
}

/** "Your own facts" of a record of a model (Team, Employee): the custom fields this person sees, with their values, in order. */
export async function ownFactsOf(client: Client, context: OfficeContext, model: 'Team' | 'Employee', record: { readonly id: string; readonly companyId: string }) {
  const actor = actorOf(context)
  const fields = fieldsSeen(actor, await fieldsOfModel(client, model), record.companyId, null)
  if (fields.length === 0) return []
  const values = (await valuesOfRecords(client, model, [record.id], fields.map((field) => field.id))).get(record.id)
  if (!values || values.size === 0) return []
  const references = await referenceWords(client, actor, fields, values.values())
  return fields.flatMap((field) => {
    const value = values.get(field.id)
    const shown = value ? factText(field, value.value, (id) => references.get(id) ?? null) : null
    return shown === null ? [] : [{ label: field.labelEn, value: shown }]
  })
}

/** One unit's profile (the Shape of GET /people/units/:unitId). */
export async function unitRecordView(client: Client, context: OfficeContext, unit: UnitRow) {
  const actor = actorOf(context)
  const [view] = await unitViews(client, [unit])
  const members = await membersOf(client, [unit.id])
  const standIn = unit.standInEmployeeId ? await client.employee.findUnique({ where: { id: unit.standInEmployeeId }, select: { id: true, firstName: true, lastName: true } }) : null
  const parties = unit.worksForPartyIds.length === 0 ? [] : await client.party.findMany({ where: { id: { in: unit.worksForPartyIds } }, select: { id: true, companyId: true, legalName: true, tradeName: true } })
  const partyOf = new Map(parties.map((party) => [party.id, party]))
  const worksFor = unit.worksForPartyIds.flatMap((partyId) => {
    const party = partyOf.get(partyId)
    if (!party || !can(actor, PARTIES_VIEW, { companyId: party.companyId ?? unit.companyId, partyId })) return []
    return [{ partyId, name: party.tradeName ?? party.legalName }]
  })
  const rows = await client.orderTeam.findMany({ where: { teamId: unit.id, endedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200, select: { salesOrderId: true, companyId: true, partyId: true } })
  const seen = rows.filter((row) => can(actor, ORDERS_VIEW, { companyId: row.companyId, partyId: row.partyId }))
  const orders = new Map(
    (seen.length === 0 ? [] : await client.salesOrder.findMany({ where: { id: { in: seen.map((row) => row.salesOrderId) } }, select: { id: true, number: true, status: true } })).map((order) => [order.id, order]),
  )
  const codes = new Map((seen.length === 0 ? [] : await client.party.findMany({ where: { id: { in: [...new Set(seen.map((row) => row.partyId))] } }, select: { id: true, code: true } })).map((party) => [party.id, party.code]))
  const work = seen.flatMap((row) => {
    const order = orders.get(row.salesOrderId)
    return order ? [{ orderId: order.id, number: order.number, customerCode: codes.get(row.partyId) ?? '', state: order.status as string }] : []
  })
  return {
    ...view!,
    about: unit.about,
    standIn: standIn ? { employeeId: standIn.id, name: nameOf(standIn), until: dayOrNull(unit.standInUntil) } : null,
    worksFor,
    maxBaskets: unit.maxBaskets,
    takesNewOrders: unit.takesNewOrders,
    ownFacts: await ownFactsOf(client, context, 'Team', unit),
    work,
    members: members.map((member) => personOf(member)),
    version: unit.version,
  }
}

/** GET /people/units/:unitId. */
export async function unitRecord(caller: CommandCaller, unitId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const unit = isUuid(unitId) ? await readUnit(client, unitId) : null
    if (!unit) throw new NotFoundError('Unit not found.')
    assertMay(context, PEOPLE_VIEW, unit, 'Unit')
    return unitRecordView(client, context, unit)
  })
}
