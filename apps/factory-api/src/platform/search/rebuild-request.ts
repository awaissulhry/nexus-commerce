import { command, type CommandCaller } from '../../core/command'
import { ApiError } from '../../core/errors'

/**
 * POST /search/rebuild (search.rebuild; B-W2a-32): asks the worker to read the tenant's records again into the search
 * index — every type with an indexer, or the types named. ONE command: its audit row (who asked, which types) and the
 * event `search.rebuild_requested`, which the worker's handler `search.rebuild` follows (platform/search/indexing.ts).
 * Nothing in any record changes; a repeated Idempotency-Key answers the same and asks nothing again.
 */
export async function requestRebuild(caller: CommandCaller, body: { readonly recordTypes?: readonly string[] | undefined }, idempotencyKey: string | undefined): Promise<{ requested: true; recordTypes: string[] | null }> {
  const context = caller.factoryContext
  if (!context) throw new ApiError('unauthenticated')
  if (context.audience !== 'office') throw new ApiError('forbidden')
  const recordTypes = body.recordTypes ? [...new Set(body.recordTypes)].sort() : null
  const { result } = await command(caller, { name: 'search.requestRebuild', idempotencyKey, input: { recordTypes } }, async (tools) => {
    tools.audit({ action: 'search.requestRebuild', recordType: 'Tenant', recordId: context.tenantId, companyId: null, after: { recordTypes } })
    tools.emit({ type: 'search.rebuild_requested', subject: context.tenantId, companyId: null, payload: { recordTypes, requestedById: context.actorId } })
    return { requested: true as const, recordTypes }
  })
  return result
}
