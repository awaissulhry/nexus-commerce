import { z } from 'zod'
import { operationRow, operationView, type OperationRow, type OperationView } from '@nexus/factory-domain/product/routing/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { getRouting, updateStep } from '../styles/api'

/**
 * Every call the operation library makes (SCR-049 Operations and the operation record), each answer checked against the
 * API's own contract (factory-domain product/routing): the list and its counts, one operation with where it is used,
 * its writes (product.operations.manage), and — for "Update to the library value" on Where used — a draft routing's
 * step changed through the routing's own route with that revision's version (product.routing.manage). No money here.
 */

export type { OperationRow, OperationView }
export type WhereUsed = OperationView['whereUsed'][number]

const enc = encodeURIComponent
const path = (operationId: string) => `/product/operations/${enc(operationId)}`
const key = () => ({ idempotencyKey: newIdempotencyKey() })

export interface OperationQuery {
  q?: string
  kind?: string
  status?: 'ACTIVE' | 'ARCHIVED' | 'ALL'
  usage?: 'UNUSED' | 'DIFFERS'
  limit?: number
  cursor?: string | null
}

const page = z.object({ operations: z.array(operationRow), nextCursor: z.string().nullable(), count: z.number().int() })
export type OperationPage = z.infer<typeof page>

export function listOperations(api: ApiClient, query: OperationQuery): Promise<OperationPage> {
  return api.get('/product/operations', {
    query: { q: query.q?.trim() || undefined, kind: query.kind || undefined, status: query.status ?? 'ACTIVE', usage: query.usage, limit: query.limit ?? 50, cursor: query.cursor ?? undefined },
    schema: page,
  })
}

export async function countOperations(api: ApiClient, query: OperationQuery): Promise<number> {
  return (await listOperations(api, { ...query, limit: 1, cursor: null })).count
}

const one = z.object({ operation: operationView })

export function getOperation(api: ApiClient, operationId: string): Promise<OperationView> {
  return api.get(path(operationId), { schema: one }).then((answer) => answer.operation)
}

export interface OperationInput {
  name: string
  nameI18n: { it?: string; en?: string } | null
  workCentreKind: string
  machineType: string | null
  skill: string | null
  standardMinutes: string
  instructions: string | null
}

export function createOperation(api: ApiClient, body: OperationInput & { code: string; companyId: string | null }): Promise<OperationView> {
  return api.post('/product/operations', { body, schema: one, ...key() }).then((answer) => answer.operation)
}

export function updateOperation(api: ApiClient, operation: Pick<OperationView, 'id' | 'version'>, patch: Partial<OperationInput> & { code?: string }): Promise<OperationView> {
  return api.request('PATCH', path(operation.id), { body: { ...patch, version: operation.version }, schema: one, ...key() }).then((answer) => answer.operation)
}

export function archiveOperation(api: ApiClient, operation: Pick<OperationRow, 'id' | 'version'>, reason?: string): Promise<OperationView> {
  return api.post(`${path(operation.id)}/archive`, { body: { version: operation.version, ...(reason ? { reason } : {}) }, schema: one, ...key() }).then((answer) => answer.operation)
}

export function reactivateOperation(api: ApiClient, operation: Pick<OperationRow, 'id' | 'version'>): Promise<OperationView> {
  return api.post(`${path(operation.id)}/reactivate`, { body: { version: operation.version }, schema: one, ...key() }).then((answer) => answer.operation)
}

/**
 * A draft routing's step takes the library's minutes: read the routing for the revision's version (the BOM and the
 * routing are one versioned record), then change the step with it.
 */
export async function useLibraryMinutes(api: ApiClient, use: Pick<WhereUsed, 'style' | 'revision' | 'stepId'>, standardMinutes: string): Promise<void> {
  const routing = await getRouting(api, use.style.id, use.revision.id)
  await updateStep(api, use.style.id, { id: use.revision.id, version: routing.revision.version }, use.stepId, { standardMinutes })
}
