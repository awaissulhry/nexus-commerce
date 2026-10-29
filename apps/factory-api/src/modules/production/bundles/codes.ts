import { ConflictError } from '@nexus/factory-domain/core/errors'
import { tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { highestBundleRef, nextBundleCodes } from '@nexus/factory-domain/production/bundles/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import type { RequestContext } from '../../../core/context'
import { systemContext } from '../../../platform/outbox/system'
import { highestBundleCode, lockBundleCodes } from './store'

/**
 * Ticket codes for bundles (B-W1-41; PLT-126): BUNDLE scannable ids of the tenant, `BN-<tag>-<ref>-<check>`, the next
 * references after the tenant's highest one, never reused (a reprint takes a new one, a void bundle keeps its own).
 *
 * The codes are unique in the tenant (Bundle @@unique tenantId + code), but a floor device's row-level security shows
 * it only its own site's bundles. So, until the "floor numbering" schema step brings a BUNDLE NumberKind (with
 * GOODS_RECEIPT, LOT and HIDE for floor receiving, and per-tablet blocks for offline tags), withTicketCodes is the ONE
 * way to take codes:
 *   1. before the command, the tenant's highest code is read in the tenant's system context (every site);
 *   2. inside the command, after the tenant's bundle-code advisory lock, the caller's own view is read again (its
 *      site's bundles made since are counted) and the codes run on from the higher of the two;
 *   3. a code another site of the tenant took between 1 and 2 fails the insert on the unique key: the command rolls
 *      back whole (no receipt) and runs again from 1, at most MAX_ATTEMPTS times.
 * Replace this file's body with allocateNumber of the BUNDLE series when that step lands; callers keep their shape.
 */

const MAX_ATTEMPTS = 4

/** Takes the next codes inside the command, under the tenant's bundle-code lock. */
export interface TicketCodes {
  take(tx: CommandTx, count: number): Promise<string[]>
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

/** The request as the tenant's system caller (the worker's context): it reads every site of the tenant. */
export function asTenantSystem(caller: CommandCaller, context: Exclude<RequestContext, { audience: 'platform' }>): CommandCaller {
  const system = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  system.factoryContext = systemContext(context.tenantId, context.requestId)
  return system
}

/** Runs `write` (one command that takes ticket codes with `codes.take`), again when another site took the same codes. */
export async function withTicketCodes<T>(caller: CommandCaller, write: (codes: TicketCodes) => Promise<T>): Promise<T> {
  const context = caller.factoryContext
  if (!context || context.audience === 'platform') throw new ConflictError('Bundle tickets are made for a tenant.')
  const tag = tenantTag(context.tenantId)
  for (let attempt = 1; ; attempt++) {
    const tenantWide = highestBundleRef([await asTenantSystem(caller, context).withClient((client) => highestBundleCode(client, tag))], tag)
    const codes: TicketCodes = {
      async take(tx, count) {
        await lockBundleCodes(tx, context.tenantId)
        const seen = highestBundleRef([await highestBundleCode(tx, tag)], tag)
        return nextBundleCodes(tag, Math.max(tenantWide, seen), count)
      },
    }
    try {
      return await write(codes)
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      if (attempt >= MAX_ATTEMPTS) throw new ConflictError('Another site of this factory took the same ticket codes at the same moment. Send it again.')
    }
  }
}
