import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { holds, scopeWhere, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { DepartmentView } from './contract'

/**
 * GET /production/departments (owb- order workflow, b3.3): every department of the companies the reader reaches (a department
 * of no company is the whole factory's), closed ones too (an old route step may name one), by `seq` then number. Who: the office
 * with workorders.view or product.styles.view; the floor with floor.work (row-level security: the floor reads Department). The
 * words of a refusal name the rights, never a code.
 */

export const DEPARTMENTS_FLOOR = 'floor.work' as Permission

/** The right the reader reads departments with, or a 403 in words. */
function readingRight(actor: Actor): Permission {
  if (actor.audience === 'floor') {
    if (holds(actor, DEPARTMENTS_FLOOR)) return DEPARTMENTS_FLOOR
    throw new ForbiddenError('The departments are read on a floor device signed in to work.')
  }
  if (holds(actor, WORKORDERS_VIEW)) return WORKORDERS_VIEW
  if (holds(actor, PRODUCT_STYLES_VIEW)) return PRODUCT_STYLES_VIEW
  throw new ForbiddenError('Reading the departments needs the right to see the work orders or the products.')
}

const asWords = (value: Prisma.JsonValue | null): Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).flatMap(([key, word]) => (typeof word === 'string' ? [[key, word]] : []))) : {}

/** The columns a department row is read with (owb-pd1 1.3: the manage routes answer the same row). */
export const DEPARTMENT_COLUMNS = { id: true, number: true, name: true, shortName: true, nameI18n: true, tone: true, icon: true, workCentreKind: true, seq: true, floorReady: true, status: true, version: true } as const satisfies Prisma.DepartmentSelect
type DepartmentRow = Prisma.DepartmentGetPayload<{ select: typeof DEPARTMENT_COLUMNS }>

/** A department row as the read answers it. */
export const departmentViewOf = (row: DepartmentRow): DepartmentView => ({
  id: row.id,
  number: row.number,
  name: row.name,
  shortName: row.shortName,
  nameI18n: asWords(row.nameI18n),
  tone: row.tone,
  icon: row.icon,
  workCentreKind: row.workCentreKind,
  seq: row.seq,
  floorReady: row.floorReady,
  status: row.status,
  version: row.version,
})

export async function readDepartments(caller: CommandCaller): Promise<{ departments: DepartmentView[] }> {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  const actor = actorOf(context)
  const right = readingRight(actor)
  const rows = await caller.withClient((client) =>
    client.department.findMany({
      where: scopeWhere(actor, right, { company: { field: 'companyId', nullable: true } }) as Prisma.DepartmentWhereInput,
      orderBy: [{ seq: 'asc' }, { number: 'asc' }],
      select: DEPARTMENT_COLUMNS,
    }),
  )
  return { departments: rows.map(departmentViewOf) }
}
