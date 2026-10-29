import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { CreateOperationBody, ListOperationsQuery, OperationRow, OperationStatusBody, OperationView, UpdateOperationBody } from '@nexus/factory-domain/product/routing/contracts'
import { changeOperation, newOperation, operationMachine, type OperationFields, type OperationPatch, type OperationStatus } from '@nexus/factory-domain/product/routing/operations'
import { PRODUCT_ROUTING_VIEW } from '@nexus/factory-domain/product/routing/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import {
  assertMayWrite,
  clearNames,
  contextOf,
  differingOperationIds,
  fieldsOf,
  isUniqueViolation,
  OPERATION_COLUMNS,
  OPERATION_SCOPE,
  operationRowView,
  operationViewInTx,
  operationViewOf,
  readOperation,
  readUses,
  usageOf,
  visibleUseFilter,
} from './store'

/**
 * The operation library (plan A1 §2.4 B; A2 SCR-049 "Libraries: operations"; features PRD-109, PRD-111): the list, one
 * operation with where it is used, and its writes, each through command() with its audit row and its event. The domain
 * (factory-domain product/routing/operations) decides what an operation may be; this file adds what only the database
 * knows: the code is free, and a code copied into routings no longer changes. An operation is archived, never deleted
 * (no role holds a DELETE grant on it). A change here never reaches a routing: routings keep their copy, and their
 * screens show where the minutes differ.
 */

const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))
const invalid = (issues: readonly Issue[]): ValidationError => new ValidationError('The operation is not valid.', issues)
const codeConflict = (code: string) => new ConflictError(`The operation code ${code} is taken.`)

// ---- reads -------------------------------------------------------------------------------------------------------------

interface Cursor {
  readonly code: string
  readonly id: string
}

const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify([cursor.code, cursor.id]), 'utf8').toString('base64url')

function decodeCursor(value: string | undefined): Cursor | null {
  if (value === undefined || value === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') return { code: parsed[0], id: parsed[1] }
  } catch {
    // falls through to the refusal
  }
  throw new ValidationError('The cursor is not valid.', [{ path: 'querystring/cursor', message: 'Send back nextCursor as it came.' }])
}

/** The operations the caller may see, by code, one page at a time, each with where it is used (SCR-049). */
export async function listOperations(caller: CommandCaller, query: ListOperationsQuery): Promise<{ operations: OperationRow[]; nextCursor: string | null; count: number }> {
  const context = contextOf(caller)
  const search = query.q?.trim()
  return caller.withClient(async (client) => {
    const usage: Prisma.OperationWhereInput =
      query.usage === 'UNUSED' ? { NOT: visibleUseFilter(context) } : query.usage === 'DIFFERS' ? { id: { in: await differingOperationIds(client, context) } } : {}
    const filters: Prisma.OperationWhereInput[] = [
      scopeWhere(actorOf(context), PRODUCT_ROUTING_VIEW, OPERATION_SCOPE) as Prisma.OperationWhereInput,
      query.status === 'ALL' ? {} : { status: query.status },
      search
        ? {
            OR: [
              { code: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              { machineType: { contains: search, mode: 'insensitive' } },
              { skill: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {},
      query.kind ? { workCentreKind: { in: query.kind } } : {},
      query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
      usage,
    ]
    const cursor = decodeCursor(query.cursor)
    const after: Prisma.OperationWhereInput = cursor ? { OR: [{ code: { gt: cursor.code } }, { code: cursor.code, id: { gt: cursor.id } }] } : {}
    // One after another on the one client (a page, then its count, then its uses).
    const rows = await client.operation.findMany({ where: { AND: [...filters, after] }, select: OPERATION_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: query.limit + 1 })
    const count = await client.operation.count({ where: { AND: filters } })
    const page = rows.slice(0, query.limit)
    const uses = await readUses(
      client,
      context,
      page.map((row) => row.id),
    )
    const usageByOperation = usageOf(uses, new Map(page.map((row) => [row.id, fieldsOf(row).standardMinutes])))
    const last = page.at(-1)
    return {
      operations: page.map((row) => operationRowView(row, usageByOperation.get(row.id)!)),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
      count,
    }
  })
}

/** One operation with where it is used. */
export async function getOperation(caller: CommandCaller, operationId: string): Promise<OperationView> {
  const row = await readOperation(caller, operationId)
  return caller.withClient((client) => operationViewOf(client, contextOf(caller), row))
}

// ---- create ------------------------------------------------------------------------------------------------------------

const auditedFields = (fields: Partial<OperationFields>): Record<string, unknown> => ({ ...fields })

/** product.operations.create: an operation of one company or of every company. */
export async function createOperation(caller: CommandCaller, body: CreateOperationBody, idempotencyKey?: string): Promise<OperationView> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  assertMayWrite(context, companyId)
  const { companyId: _company, ...input } = body
  const outcome = newOperation(input)
  if (!outcome.ok) throw invalid(prefixed(outcome.issues))
  const operation = outcome.operation

  const { result } = await command(caller, { name: 'product.operations.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) {
      throw invalid([{ path: 'body/companyId', message: 'No such company.' }])
    }
    if (await tx.operation.findFirst({ where: { code: operation.code }, select: { id: true } })) throw codeConflict(operation.code)
    const id = newId()
    await tx.operation.create({
      data: { ...operation, nameI18n: operation.nameI18n ?? undefined, id, companyId, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
      select: { id: true },
    })
    tools.audit({ recordType: 'Operation', recordId: id, companyId, after: { companyId, ...auditedFields(operation), status: 'ACTIVE' } })
    tools.emit({ type: 'operation.created', subject: id, companyId, payload: { operationId: id, code: operation.code } })
    return operationViewInTx(tx, tools.context, id)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw codeConflict(operation.code)
    throw error
  })
  return result
}

// ---- update ------------------------------------------------------------------------------------------------------------

function activeOnly(status: OperationStatus): void {
  if (status !== 'ACTIVE') throw new InvalidStateError('This operation is archived: reactivate it before changing it.')
}

/**
 * product.operations.update: the fields sent (versioned, COL-078). Its code changes only while no routing step copied it;
 * routings keep their own minutes (the routing screens show the difference; a draft takes the library's value by a step
 * change).
 */
export async function updateOperation(caller: CommandCaller, operationId: string, body: UpdateOperationBody, idempotencyKey?: string): Promise<OperationView> {
  const context = contextOf(caller)
  const seen = await readOperation(caller, operationId)
  assertMayWrite(context, seen.companyId)
  activeOnly(seen.status)
  const { version, ...patch } = body

  const { result } = await command(
    caller,
    { name: 'product.operations.update', idempotencyKey, input: { operationId, ...body }, record: { type: 'Operation', id: operationId, expectedVersion: version } },
    async (tools) => {
      const { tx, now } = tools
      const row = await tx.operation.findUniqueOrThrow({ where: { id: operationId }, select: OPERATION_COLUMNS })
      activeOnly(row.status)
      const current = fieldsOf(row)
      const used = (await tx.routingOperation.count({ where: { operationId } })) > 0
      const change = changeOperation(current, patch as OperationPatch, used)
      if (!change.ok) throw invalid(prefixed(change.issues))
      const { operation: next, changed } = change
      if (changed.includes('code') && (await tx.operation.findFirst({ where: { code: next.code, id: { not: operationId } }, select: { id: true } }))) throw codeConflict(next.code)

      const data = Object.fromEntries(changed.filter((field) => !(field === 'nameI18n' && next.nameI18n === null)).map((field) => [field, next[field]])) as Prisma.OperationUncheckedUpdateInput
      await tx.operation.update({ where: { id: operationId }, data: { ...data, updatedAt: now }, select: { id: true } })
      if (changed.includes('nameI18n') && next.nameI18n === null) await clearNames(tx, operationId)
      tools.audit({
        recordType: 'Operation',
        recordId: operationId,
        companyId: row.companyId,
        before: Object.fromEntries(changed.map((field) => [field, current[field]])),
        after: Object.fromEntries(changed.map((field) => [field, next[field]])),
      })
      if (changed.length > 0) tools.emit({ type: 'operation.updated', subject: operationId, companyId: row.companyId, payload: { operationId, code: next.code, fields: [...changed] } })
      return operationViewInTx(tx, context, operationId)
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('The operation code is taken.')
    throw error
  })
  return result
}

// ---- archive, reactivate -----------------------------------------------------------------------------------------------

/** product.operations.archive / reactivate: out of new routing steps and back; routings that use it keep their steps. */
export async function moveOperation(caller: CommandCaller, operationId: string, to: OperationStatus, body: OperationStatusBody, idempotencyKey?: string): Promise<OperationView> {
  const context = contextOf(caller)
  const seen = await readOperation(caller, operationId)
  assertMayWrite(context, seen.companyId)
  const name = to === 'ARCHIVED' ? 'product.operations.archive' : 'product.operations.reactivate'
  const { result } = await command(
    caller,
    { name, idempotencyKey, input: { operationId, ...body }, record: { type: 'Operation', id: operationId, expectedVersion: body.version, transition: { machine: operationMachine, to } } },
    async (tools) => {
      tools.audit({ recordType: 'Operation', recordId: operationId, companyId: seen.companyId, before: { status: tools.record!.from }, after: { status: to }, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'operation.status_changed', subject: operationId, companyId: seen.companyId, payload: { operationId, code: seen.code, status: to } })
      return operationViewInTx(tools.tx, context, operationId)
    },
  )
  return result
}
