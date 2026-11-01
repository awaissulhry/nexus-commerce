import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import type { LabourRefusal } from '@nexus/factory-domain/production/labour/rules'
import { PRODUCTION_LABOUR_VIEW } from '@nexus/factory-domain/production/labour/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { readLine, sitesById, type LineRow, type SiteRow } from './store'

/**
 * Who reaches labour records (B-W2b-45), and the refusal every route answers with: the office within its grants (can()
 * on the line's or the record's company and site), a floor device only at its own site, for the signed-in worker's own
 * records.
 */

/** A labour action refused by its rule (factory-domain production/labour/rules): a 409 with `refusal/<CODE>` and the fix. */
export class LabourRefusedError extends ConflictError {
  override name = 'LabourRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: LabourRefusal) {
    super(refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: refusal.message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

export const refuse = (refusal: LabourRefusal): never => {
  throw new LabourRefusedError(refusal)
}

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/** The record's company and site are reached with the permission (and with production.labour.view): else 404. */
export function reaches(context: OfficeContext, permission: Permission, place: { readonly companyId: string; readonly siteId: string }): boolean {
  const actor = actorOf(context)
  return can(actor, PRODUCTION_LABOUR_VIEW, place) && can(actor, permission, place)
}

/** A line of a site the caller reaches with the permission, and its site; 404 otherwise (its existence is not told). */
export async function officeLine(caller: CommandCaller, lineId: string, permission: Permission): Promise<{ readonly line: LineRow; readonly site: SiteRow }> {
  const context = officeOf(caller)
  const found = await caller.withClient(async (db) => {
    const line = await readLine(db, lineId)
    const site = line ? (await sitesById(db, [line.siteId])).get(line.siteId) : undefined
    return line && site ? { line, site } : null
  })
  if (!found || !reaches(context, permission, { companyId: found.site.companyId, siteId: found.site.id })) throw new NotFoundError('Line not found.')
  return found
}
