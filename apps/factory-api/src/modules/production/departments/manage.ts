import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { CreateDepartmentBody, DepartmentMoveBody, UpdateDepartmentBody } from '@nexus/factory-domain/production/departments/contracts'
import { PRODUCTION_DEPARTMENTS_MANAGE } from '@nexus/factory-domain/production/departments/permissions'
import {
  cleanName,
  closeRefusal,
  defaultOperationCode,
  departmentRefusalWords,
  nameTakenBy,
  NEW_DEPARTMENT,
  nextDepartmentNumber,
  renameRefusal,
  toneForNew,
  type DepartmentRefusal,
} from '@nexus/factory-domain/production/departments/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import type { DepartmentView } from './contract'
import { DEPARTMENT_COLUMNS, departmentViewOf } from './read'

/**
 * Keeping the factory's departments (owb-pd1 1.3; design § 5x "Manage departments" inside the route builder; S4 settle 7):
 * add, rename, close and open again. production.departments.manage over the department's company (a department of the whole
 * factory — every seeded one, and every one added here — by a grant over every company, as the operation library's
 * tenant-wide rows). Each act is ONE command with its audit rows and `production.department_changed`.
 *
 *   POST  /production/departments            { name, shortName? }                   → 201 { department }
 *         the next number (the highest ever given + 1, under the tenant's department lock, never one used before), the
 *         first free grid tone, kind ASSEMBLY, icon circle-dot, not on the floor; AND its ONE default library operation
 *         (DEPT-<number>, the department's name and kind, 0 standard minutes, departmentDefault) — the step a route makes
 *         from the department (pd2).
 *   PATCH /production/departments/:id        { version, name?, shortName?, nameI18n? } → { department }
 *         renames the default operation with it (its name and names per language).
 *   POST  /production/departments/:id/close | /open  { version }                     → { department }
 *         a closed department leaves the builder's list; routes keep it; nothing is deleted. Its default operation is set
 *         ARCHIVED with it (no new step names it) and ACTIVE again on open.
 *
 * Refusals (code at `refusal/<code>`, words of factory-domain production/departments/rules): NAME_EMPTY 400 · NAME_TAKEN 409 ·
 * FLOOR_FIXED 409 (a floor department: its name stays, it never closes) · CLOSED 409 (rename a closed one) · CODE_TAKEN 409 (the
 * operation code DEPT-<n> is used by another operation) · a stale version 409 (command()'s record guard) · 404 for a department
 * of a company outside the person's grants.
 */

const NUMBER_LOCK = 'factory.department'

function officeContextOf(caller: CommandCaller): RequestContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  return context
}

function refused(code: DepartmentRefusal, facts: { readonly code?: string } = {}): DomainError {
  const message = departmentRefusalWords(code, 'en', facts)
  return new DomainError(code === 'NAME_EMPTY' ? 'validation_failed' : 'conflict', message, [{ path: `refusal/${code}`, message }])
}

function assertMayManage(context: RequestContext, companyId: string | null): void {
  if (!mayWrite(actorOf(context), PRODUCTION_DEPARTMENTS_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? 'A department of the whole factory is kept only by a role over every company.' : 'Keeping the departments needs the right to keep them (the production manager).')
  }
}

/** The department as the person may keep it; another company's (outside the person's grants) or another tenant's is not found. */
async function readForKeeping(caller: CommandCaller, departmentId: string) {
  const context = officeContextOf(caller)
  if (!isUuid(departmentId)) throw new NotFoundError('Department not found.')
  const row = await caller.withClient((client) => client.department.findUnique({ where: { id: departmentId }, select: { ...DEPARTMENT_COLUMNS, companyId: true } }))
  if (!row || !can(actorOf(context), PRODUCTION_DEPARTMENTS_MANAGE, { companyId: row.companyId })) throw new NotFoundError('Department not found.')
  return row
}

/** The tenant's departments, one keeper at a time (numbers and names are decided under this lock). */
async function lockDepartments(tx: CommandTx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', ${NUMBER_LOCK}::text, current_setting('factory.tenant_id', true)), 0))`
  return tx.department.findMany({ select: { id: true, number: true, name: true, shortName: true, tone: true, status: true } })
}

const officeActor = (tools: CommandTools): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

async function viewInTx(tx: CommandTx, departmentId: string): Promise<DepartmentView> {
  return departmentViewOf(await tx.department.findUniqueOrThrow({ where: { id: departmentId }, select: DEPARTMENT_COLUMNS }))
}

/** The department's ONE default library operation (owb-b1 G3: a partial unique), or null for one made before it had one. */
const defaultOperationOf = (tx: CommandTx, departmentId: string) =>
  tx.operation.findFirst({ where: { departmentId, departmentDefault: true }, select: { id: true, code: true, name: true, status: true, version: true } })

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

// ---- add ---------------------------------------------------------------------------------------------------------------

/** production.departments.create: a new department of the whole factory and its default library operation. */
export async function createDepartment(caller: CommandCaller, body: CreateDepartmentBody, idempotencyKey?: string): Promise<DepartmentView> {
  const context = officeContextOf(caller)
  assertMayManage(context, null)
  const name = cleanName(body.name)
  if (name === '') throw refused('NAME_EMPTY')
  const shortName = cleanName(body.shortName) || name

  const { result } = await command(caller, { name: 'production.departments.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const departments = await lockDepartments(tx)
    if (nameTakenBy(name, departments) || nameTakenBy(shortName, departments)) throw refused('NAME_TAKEN')
    const number = nextDepartmentNumber(departments.map((department) => department.number))
    const tone = toneForNew(departments.filter((department) => department.status === 'ACTIVE').map((department) => department.tone))
    const code = defaultOperationCode(number)
    if (await tx.operation.findFirst({ where: { code }, select: { id: true } })) throw refused('CODE_TAKEN', { code })
    const id = newId()
    const operationId = newId()
    const createdById = officeActor(tools)
    const kind = NEW_DEPARTMENT.workCentreKind
    await tx.department.create({
      data: { id, number, name, shortName, tone, icon: NEW_DEPARTMENT.icon, workCentreKind: kind, seq: number, floorReady: NEW_DEPARTMENT.floorReady, createdAt: now, updatedAt: now, createdById },
      select: { id: true },
    })
    await tx.operation.create({
      data: { id: operationId, code, name, workCentreKind: kind, standardMinutes: '0', departmentId: id, departmentDefault: true, createdAt: now, updatedAt: now, createdById },
      select: { id: true },
    })
    tools.audit({ recordType: 'Department', recordId: id, companyId: null, after: { number, name, shortName, tone, icon: NEW_DEPARTMENT.icon, workCentreKind: kind, floorReady: false, status: 'ACTIVE', defaultOperationId: operationId } })
    tools.audit({ action: 'product.operations.create', recordType: 'Operation', recordId: operationId, companyId: null, after: { companyId: null, code, name, workCentreKind: kind, standardMinutes: '0', departmentId: id, departmentDefault: true, status: 'ACTIVE' } })
    tools.emit({ type: 'production.department_changed', subject: id, companyId: null, payload: { departmentId: id, number, change: 'CREATED' } })
    tools.emit({ type: 'operation.created', subject: operationId, companyId: null, payload: { operationId, code } })
    return viewInTx(tx, id)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw refused('NAME_TAKEN')
    throw error
  })
  return result
}

// ---- rename ------------------------------------------------------------------------------------------------------------

/** production.departments.update: its name, short name or names per language; its default operation is renamed with it. */
export async function updateDepartment(caller: CommandCaller, departmentId: string, body: UpdateDepartmentBody, idempotencyKey?: string): Promise<DepartmentView> {
  const context = officeContextOf(caller)
  const seen = await readForKeeping(caller, departmentId)
  assertMayManage(context, seen.companyId)
  const { version, ...patch } = body
  const early = renameRefusal(seen, patch)
  if (early) throw refused(early)
  const name = patch.name === undefined ? seen.name : cleanName(patch.name)
  const shortName = patch.shortName === undefined ? seen.shortName : cleanName(patch.shortName)
  const names: Prisma.InputJsonObject | null | undefined = patch.nameI18n === undefined ? undefined : patch.nameI18n === null ? null : { ...patch.nameI18n }
  const wordsBefore = departmentViewOf(seen).nameI18n
  const namesChange = names !== undefined && JSON.stringify(names ?? {}) !== JSON.stringify(wordsBefore)
  if (name === seen.name && shortName === seen.shortName && !namesChange) return departmentViewOf(seen)

  const { result } = await command(
    caller,
    { name: 'production.departments.update', idempotencyKey, input: { departmentId, ...body }, record: { type: 'Department', id: departmentId, expectedVersion: version } },
    async (tools) => {
      const { tx, now } = tools
      const departments = await lockDepartments(tx)
      const row = await tx.department.findUniqueOrThrow({ where: { id: departmentId }, select: { ...DEPARTMENT_COLUMNS, companyId: true } })
      const refusal = renameRefusal(row, { name, shortName })
      if (refusal) throw refused(refusal)
      if ((name !== row.name && nameTakenBy(name, departments, departmentId)) || (shortName !== row.shortName && nameTakenBy(shortName, departments, departmentId))) throw refused('NAME_TAKEN')
      await tx.department.update({ where: { id: departmentId }, data: { name, shortName, ...(names ? { nameI18n: names } : {}), updatedAt: now }, select: { id: true } })
      if (names === null) await tx.$executeRaw`UPDATE "Department" SET "nameI18n" = NULL WHERE "id" = ${departmentId}::uuid`
      tools.audit({
        recordType: 'Department',
        recordId: departmentId,
        companyId: row.companyId,
        before: { name: row.name, shortName: row.shortName, nameI18n: departmentViewOf(row).nameI18n },
        after: { name, shortName, nameI18n: names === undefined ? departmentViewOf(row).nameI18n : names },
      })
      tools.emit({ type: 'production.department_changed', subject: departmentId, companyId: row.companyId, payload: { departmentId, number: row.number, change: 'RENAMED' } })
      // Its default library operation takes the new name (a route shows the department's name; the library its operation's).
      const operation = await defaultOperationOf(tx, departmentId)
      if (operation && (operation.name !== name || names !== undefined)) {
        await tx.operation.update({ where: { id: operation.id }, data: { name, ...(names ? { nameI18n: names } : {}), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        if (names === null) await tx.$executeRaw`UPDATE "Operation" SET "nameI18n" = NULL WHERE "id" = ${operation.id}::uuid`
        tools.audit({ action: 'product.operations.update', recordType: 'Operation', recordId: operation.id, companyId: row.companyId, before: { name: operation.name }, after: { name, ...(names !== undefined ? { nameI18n: names } : {}) } })
        tools.emit({ type: 'operation.updated', subject: operation.id, companyId: row.companyId, payload: { operationId: operation.id, code: operation.code, fields: names !== undefined ? ['name', 'nameI18n'] : ['name'] } })
      }
      return viewInTx(tx, departmentId)
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw refused('NAME_TAKEN')
    throw error
  })
  return result
}

// ---- close, open -------------------------------------------------------------------------------------------------------

/** production.departments.close / open: out of the builder's list and back; routes keep it, nothing is deleted. */
export async function moveDepartment(caller: CommandCaller, departmentId: string, to: 'CLOSED' | 'ACTIVE', body: DepartmentMoveBody, idempotencyKey?: string): Promise<DepartmentView> {
  const context = officeContextOf(caller)
  const seen = await readForKeeping(caller, departmentId)
  assertMayManage(context, seen.companyId)
  if (to === 'CLOSED') {
    const refusal = closeRefusal(seen)
    if (refusal) throw refused(refusal)
  }
  // Already so: nothing changes (no command, no version bump), as a PATCH with no change.
  if (seen.status === to) return departmentViewOf(seen)

  const { result } = await command(
    caller,
    { name: to === 'CLOSED' ? 'production.departments.close' : 'production.departments.open', idempotencyKey, input: { departmentId, ...body }, record: { type: 'Department', id: departmentId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const row = await tx.department.findUniqueOrThrow({ where: { id: departmentId }, select: { ...DEPARTMENT_COLUMNS, companyId: true } })
      if (to === 'CLOSED') {
        const refusal = closeRefusal(row)
        if (refusal) throw refused(refusal)
      }
      await tx.department.update({ where: { id: departmentId }, data: { status: to, updatedAt: now }, select: { id: true } })
      tools.audit({ recordType: 'Department', recordId: departmentId, companyId: row.companyId, before: { status: row.status }, after: { status: to } })
      tools.emit({ type: 'production.department_changed', subject: departmentId, companyId: row.companyId, payload: { departmentId, number: row.number, change: to === 'CLOSED' ? 'CLOSED' : 'OPENED' } })
      // Its default operation follows it: archived while the department is closed (no new step names it), active again on open.
      const operation = await defaultOperationOf(tx, departmentId)
      const operationTo = to === 'CLOSED' ? 'ARCHIVED' : 'ACTIVE'
      if (operation && operation.status !== operationTo) {
        await tx.operation.update({ where: { id: operation.id }, data: { status: operationTo, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        tools.audit({ action: to === 'CLOSED' ? 'product.operations.archive' : 'product.operations.reactivate', recordType: 'Operation', recordId: operation.id, companyId: row.companyId, before: { status: operation.status }, after: { status: operationTo } })
        tools.emit({ type: 'operation.status_changed', subject: operation.id, companyId: row.companyId, payload: { operationId: operation.id, code: operation.code, status: operationTo } })
      }
      return viewInTx(tx, departmentId)
    },
  )
  return result
}
