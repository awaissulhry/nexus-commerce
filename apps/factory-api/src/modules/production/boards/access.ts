import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { BoardRefusal } from '@nexus/factory-domain/production/boards/targets'
import type { CommandCaller } from '../../../core/command'
import type { FloorContext, OfficeContext } from '../../../core/context'
import { systemView } from '../scans/access'
import { assertMay, may } from '../calls/access'
import { lineOf, type LineRow, type Reader } from './store'

/**
 * Who may do what with the line boards (B-W2b-50): each line is checked with can() against its company and site; a floor
 * device only at its own site (can() pins it, row-level security too). A board rule's refusal is a 409 whose issues are
 * `refusal/<CODE>` (the words) and `fix` (the one thing to do), as the floor's task screens read them.
 *
 * The floor's reads (the team leader's line view) are checked as the floor session, then read in the tenant's system view
 * (`systemView`): the boards count from the working calendars and the planning settings, which the floor role does not
 * read. The answers are line totals of the device's own site only.
 */

export type BoardContext = OfficeContext | FloorContext

export function contextOf(caller: Pick<CommandCaller, 'factoryContext'>): BoardContext {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'office' && context.audience !== 'floor')) throw new ForbiddenError()
  return context
}

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export { assertMay, may }

/** The caller's reads: the office as itself, the floor through the tenant's system view (after its checks). */
export function readerOf(caller: CommandCaller, context: BoardContext): CommandCaller {
  return context.audience === 'floor' ? systemView(caller) : caller
}

/** A line the caller may read with the permission (else not found). */
export async function knownLine(caller: CommandCaller, context: BoardContext, lineId: string, permission: Permission): Promise<LineRow> {
  const line = await caller.withClient((db: Reader) => lineOf(db, lineId))
  if (!line) throw new NotFoundError('Line not found.')
  assertMay(context, permission, { companyId: line.companyId, siteId: line.siteId }, 'Line')
  return line
}

export class BoardRefusedError extends ConflictError {
  override name = 'BoardRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: BoardRefusal, detail?: string) {
    super(detail ? `${refusal.message} (${detail})` : refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: detail ? `${refusal.message} (${detail})` : refusal.message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

export const refuse = (refusal: BoardRefusal, detail?: string): never => {
  throw new BoardRefusedError(refusal, detail)
}
