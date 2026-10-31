import { ConflictError, ForbiddenError, type Issue } from '@nexus/factory-domain/core/errors'
import type { ClockRefusal } from '@nexus/factory-domain/people/clock/rules'
import type { CommandCaller } from '../../../core/command'
import type { FloorContext, RequestContext } from '../../../core/context'
import { systemContext } from '../../../platform/outbox/system'
import { legalGateFor, legalGateReader, requireLegalGate, type GateRecord } from '../privacy/gate'

/**
 * Who reaches the clock (B-W2b-33), and the refusal every route answers with. The floor only: the signed-in worker at the
 * device's site (floor.work), or a person who shows a badge (or a name and PIN) at an enrolled tablet. Before anything
 * of a person is read or written, the site's ATTENDANCE legal gate must be on (Statuto dei Lavoratori art. 4 c.2-3;
 * B-W2b-27 `requireLegalGate`): while it is off, clocking is refused in its words (409 `gate/ATTENDANCE`).
 */

/** A clock action refused by its rule (factory-domain people/clock/rules): a 409 with `refusal/<CODE>` and the fix. */
export class ClockRefusedError extends ConflictError {
  override name = 'ClockRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: ClockRefusal) {
    super(refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: refusal.message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

export const refuse = (refusal: ClockRefusal): never => {
  throw new ClockRefusedError(refusal)
}

export function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/**
 * The same caller with another context: its withClient follows `this.factoryContext` (a FastifyRequest's does), so the
 * reads and the command run in that context's scope. The kiosk's clock runs as the person it proved; the shift reads
 * as the tenant's system caller (the floor reads no shift pattern and no person's default shift).
 */
export function asContext(caller: CommandCaller, context: RequestContext): CommandCaller {
  const view = Object.create(caller) as CommandCaller & { factoryContext: RequestContext | null }
  view.factoryContext = context
  return view
}

/** The tenant's system caller over a floor caller (reads only: shifts, the break rule). */
export function systemOf(caller: CommandCaller): CommandCaller {
  const context = floorOf(caller)
  return asContext(caller, systemContext(context.tenantId, context.requestId))
}

/** The site's ATTENDANCE gate in force, or the refusal in words (read as the system: the floor reads no legal basis). */
export async function requireAttendanceGate(caller: CommandCaller, siteId: string): Promise<GateRecord> {
  return legalGateReader(caller, (db) => requireLegalGate(db, siteId, 'ATTENDANCE'))
}

/** Whether the site's ATTENDANCE gate is on (the system's read, for the automatic clock-out). */
export async function attendanceOpen(db: Parameters<typeof legalGateFor>[0], siteId: string): Promise<boolean> {
  return (await legalGateFor(db, siteId, 'ATTENDANCE')).open
}
