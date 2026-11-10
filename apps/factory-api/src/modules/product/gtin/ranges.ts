import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { CreateRangeBody, RangeStatusBody, RangesView, RangeView, UpdateRangeBody } from '@nexus/factory-domain/product/gtin/contracts'
import { PRODUCT_GTINS_MANAGE } from '@nexus/factory-domain/product/gtin/permissions'
import { rangeProblems, usedRangeRefusal } from '@nexus/factory-domain/product/gtin/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertMayWrite, contextOf } from '../styles/store'
import { allocationGate, gtinGuarded, RANGE_COLUMNS, rangeViewOf, readRange } from './store'

/**
 * The company's GS1 GTIN ranges (B-W2b-227; PRD-006; factory-domain product/gtin): a GS1 company prefix and a block of item
 * references, the next one to give. A setting: kept by product.gtins.manage over the range's company, read by
 * product.styles.view. Archived, never deleted (the numbers it gave stay explained). Once a number was given its prefix and
 * limits stay (said in words before the database's GtinRange_guard). Assigning from a range is ./assign.ts (GATE-SPEND).
 *
 *   GET  /product/gtin-ranges[?companyId&status]     the ranges the person may see, and whether assigning is open here
 *   POST /product/gtin-ranges                        {companyId, name, gs1Prefix, firstReference, lastReference}
 *   PATCH /product/gtin-ranges/:rangeId              {version, name?, gs1Prefix?, firstReference?, lastReference?}
 *   POST /product/gtin-ranges/:rangeId/archive | restore   {version}
 */

/** GET /product/gtin-ranges */
export async function listRanges(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly status?: 'ACTIVE' | 'ARCHIVED' | undefined }): Promise<RangesView> {
  const actor = actorOf(contextOf(caller))
  const rows = await caller.withClient((client) =>
    client.gtinRange.findMany({
      where: {
        AND: [
          scopeWhere(actor, PRODUCT_STYLES_VIEW, { company: 'companyId' }) as Prisma.GtinRangeWhereInput,
          query.companyId ? { companyId: query.companyId } : {},
          query.status ? { status: query.status } : {},
        ],
      },
      select: RANGE_COLUMNS,
      orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    }),
  )
  return { ranges: rows.map(rangeViewOf), allocation: allocationGate() }
}

const invalid = (issues: { path: string; message: string }[]) =>
  new ValidationError(
    'The GTIN range is not valid.',
    issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })),
  )

/** POST /product/gtin-ranges */
export async function createRange(caller: CommandCaller, body: CreateRangeBody, idempotencyKey?: string): Promise<RangeView> {
  const context = contextOf(caller)
  assertMayWrite(context, PRODUCT_GTINS_MANAGE, body.companyId)
  const input = { name: body.name.trim(), gs1Prefix: body.gs1Prefix.replace(/\s+/g, ''), firstReference: body.firstReference, lastReference: body.lastReference }
  const problems = rangeProblems(input)
  if (problems.length > 0) throw invalid(problems)
  const id = newId()
  const { result } = await gtinGuarded(() =>
    command(caller, { name: 'product.gtins.createRange', idempotencyKey, input: body }, async (tools) => {
      const { tx, now, context: actor } = tools
      const company = await tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } })
      if (!company) throw new ValidationError('The GTIN range is not valid.', [{ path: 'body/companyId', message: 'No such company.' }])
      await tx.gtinRange.create({ data: { id, companyId: body.companyId, ...input, nextReference: input.firstReference, createdAt: now, updatedAt: now, createdById: actor.audience === 'office' ? actor.actorId : null }, select: { id: true } })
      tools.audit({ recordType: 'GtinRange', recordId: id, companyId: body.companyId, after: input, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'gtin_range.changed', subject: id, companyId: body.companyId, payload: { gtinRangeId: id, companyId: body.companyId, name: input.name, change: 'CREATED', given: 0 } })
      return rangeViewOf(await tx.gtinRange.findUniqueOrThrow({ where: { id }, select: RANGE_COLUMNS }))
    }),
  )
  return result
}

/** PATCH /product/gtin-ranges/:rangeId */
export async function updateRange(caller: CommandCaller, rangeId: string, body: UpdateRangeBody, idempotencyKey?: string): Promise<RangeView> {
  const context = contextOf(caller)
  const seen = await readRange(caller, rangeId)
  assertMayWrite(context, PRODUCT_GTINS_MANAGE, seen.companyId)
  const { result } = await gtinGuarded(() =>
    command(caller, { name: 'product.gtins.updateRange', idempotencyKey, input: { rangeId, ...body }, record: { type: 'GtinRange', id: rangeId, expectedVersion: body.version } }, async (tools) => {
      const { tx } = tools
      const row = await tx.gtinRange.findUniqueOrThrow({ where: { id: rangeId }, select: RANGE_COLUMNS })
      if (row.status === 'ARCHIVED') throw new InvalidStateError(`GTIN range ${row.name} is archived: restore it before changing it.`)
      const next = {
        name: body.name === undefined ? row.name : body.name.trim(),
        gs1Prefix: body.gs1Prefix === undefined ? row.gs1Prefix : body.gs1Prefix.replace(/\s+/g, ''),
        firstReference: body.firstReference ?? row.firstReference,
        lastReference: body.lastReference ?? row.lastReference,
      }
      const used = usedRangeRefusal(row, next)
      if (used) throw new ConflictError(used)
      const problems = rangeProblems(next)
      if (problems.length > 0) throw invalid(problems)
      // While nothing was given, the next reference follows a new first one — forward only (the database never lets it go back).
      const nextReference = row.nextReference > row.firstReference ? row.nextReference : next.firstReference
      if (nextReference < row.nextReference) {
        throw new ConflictError(`GTIN range ${row.name} starts at reference ${row.nextReference}: its first reference moves only up (a lower block is a new range).`)
      }
      await tx.gtinRange.update({ where: { id: rangeId }, data: { ...next, nextReference }, select: { id: true } })
      const before = { name: row.name, gs1Prefix: row.gs1Prefix, firstReference: row.firstReference, lastReference: row.lastReference }
      tools.audit({ recordType: 'GtinRange', recordId: rangeId, companyId: row.companyId, before, after: next, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'gtin_range.changed', subject: rangeId, companyId: row.companyId, payload: { gtinRangeId: rangeId, companyId: row.companyId, name: next.name, change: 'UPDATED', given: 0 } })
      return rangeViewOf(await tx.gtinRange.findUniqueOrThrow({ where: { id: rangeId }, select: RANGE_COLUMNS }))
    }),
  )
  return result
}

/** POST /product/gtin-ranges/:rangeId/archive | restore */
export async function setRangeStatus(caller: CommandCaller, rangeId: string, to: 'ACTIVE' | 'ARCHIVED', body: RangeStatusBody, idempotencyKey?: string): Promise<RangeView> {
  const context = contextOf(caller)
  const seen = await readRange(caller, rangeId)
  assertMayWrite(context, PRODUCT_GTINS_MANAGE, seen.companyId)
  const { result } = await command(
    caller,
    { name: to === 'ARCHIVED' ? 'product.gtins.archiveRange' : 'product.gtins.restoreRange', idempotencyKey, input: { rangeId, ...body }, record: { type: 'GtinRange', id: rangeId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.gtinRange.findUniqueOrThrow({ where: { id: rangeId }, select: RANGE_COLUMNS })
      if (row.status === to) throw new InvalidStateError(`GTIN range ${row.name} is ${to === 'ARCHIVED' ? 'archived' : 'in use'} already.`)
      await tx.gtinRange.update({ where: { id: rangeId }, data: { status: to }, select: { id: true } })
      tools.audit({ recordType: 'GtinRange', recordId: rangeId, companyId: row.companyId, before: { status: row.status }, after: { status: to }, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'gtin_range.changed', subject: rangeId, companyId: row.companyId, payload: { gtinRangeId: rangeId, companyId: row.companyId, name: row.name, change: to === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED', given: 0 } })
      return rangeViewOf(await tx.gtinRange.findUniqueOrThrow({ where: { id: rangeId }, select: RANGE_COLUMNS }))
    },
  )
  return result
}
