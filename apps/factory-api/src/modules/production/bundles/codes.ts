import { ConflictError } from '@nexus/factory-domain/core/errors'
import type { CommandCaller, CommandTx } from '../../../core/command'
import type { RequestContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { allocateScanIds } from '../../../platform/numbering/scan-ids'
import { systemContext } from '../../../platform/outbox/system'

/**
 * Ticket codes for bundles (B-W1-41; PLT-126): BUNDLE scan ids of the tenant, `BN-<tag>-<ref>-<check>`, never reused (a
 * reprint takes a new one, a void bundle keeps its own).
 *
 * They come from the tenant's BUNDLE counter (platform/numbering/scan-ids `allocateScanIds`: one ONLINE number block per
 * make or reprint, taken inside the command under the tenant's `factory.scan-ids` lock, so a command that rolls back
 * takes none). The counter is tenant-wide, so a floor tablet that sees only its own site's bundles never takes another
 * site's code. A tablet that prints tickets offline numbers them from its own block instead (`useScanIds`).
 * withTicketCodes is the ONE way the bundle commands take codes.
 */

/** Takes the next codes inside the command. */
export interface TicketCodes {
  take(tx: CommandTx, count: number): Promise<string[]>
}

/** The request as the tenant's system caller (the worker's context): it reads every site of the tenant. */
export function asTenantSystem(caller: CommandCaller, context: Exclude<RequestContext, { audience: 'platform' }>): CommandCaller {
  const system = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  system.factoryContext = systemContext(context.tenantId, context.requestId)
  return system
}

/** Runs `write` (one command that takes ticket codes with `codes.take`) with the tenant's BUNDLE counter. */
export async function withTicketCodes<T>(caller: CommandCaller, write: (codes: TicketCodes) => Promise<T>): Promise<T> {
  const context = caller.factoryContext
  if (!context || context.audience === 'platform') throw new ConflictError('Bundle tickets are made for a tenant.')
  return write({
    async take(tx, count) {
      return [...(await allocateScanIds({ tx, context, now: serverClock.now() }, 'BUNDLE', count)).codes]
    },
  })
}
