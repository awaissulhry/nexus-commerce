import { toUtcIso } from '@nexus/factory-domain/core/time'
import { REMAKE_CHANNELS, type RemakeChannel } from '@nexus/factory-domain/sales/returns-outcomes/rules'
import type { Reader } from '../returns/store'

/**
 * Remakes, exchanges and closing's reads (B-W2b-346). Every read names its columns and selects no relation; a reader takes
 * the command's transaction or a scoped client, and row-level security decides what it finds.
 *
 * A remake asked (SAL-298) is kept as the audit row `returnsOutcomes.remakeAsked` on the RMA, written in the command that
 * asks it (the lines it is for, how it came, what is wrong with the fit in words): ReturnOutcomeWanted has no REMAKE
 * value (a schema need, named in the step's notes), as B-W2b-192 kept the customer's wish on its audit row before
 * B-W2b-F13b gave it a column. A request from outside keeps the fit words as the RMA's customerNote too.
 */

export const REMAKE_ACTION = 'returnsOutcomes.remakeAsked'
export const RETURN_RECORD = 'ReturnAuthorisation'

export interface RemakeAsked {
  readonly at: string
  readonly via: RemakeChannel
  readonly lineIds: string[]
  readonly fit: string
}

const asked = (row: { at: Date; after: unknown }): RemakeAsked | null => {
  const after = (row.after ?? {}) as Record<string, unknown>
  const via = typeof after.via === 'string' && (REMAKE_CHANNELS as readonly string[]).includes(after.via) ? (after.via as RemakeChannel) : null
  if (!via || !Array.isArray(after.lineIds)) return null
  return { at: toUtcIso(row.at), via, lineIds: after.lineIds.filter((id): id is string => typeof id === 'string'), fit: typeof after.fit === 'string' ? after.fit : '' }
}

/** The remake asked on an RMA (the first one), or null. */
export async function remakeOf(db: Reader, returnId: string): Promise<RemakeAsked | null> {
  const row = await db.auditLog.findFirst({ where: { recordType: RETURN_RECORD, recordId: returnId, action: REMAKE_ACTION }, select: { at: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  return row ? asked(row) : null
}

/** The remakes asked on these RMAs (id → the first one). */
export async function remakesOf(db: Reader, returnIds: readonly string[]): Promise<Map<string, RemakeAsked>> {
  if (returnIds.length === 0) return new Map()
  const rows = await db.auditLog.findMany({ where: { recordType: RETURN_RECORD, recordId: { in: [...returnIds] }, action: REMAKE_ACTION }, select: { recordId: true, at: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  const out = new Map<string, RemakeAsked>()
  for (const row of rows) {
    const value = asked(row)
    if (value && !out.has(row.recordId)) out.set(row.recordId, value)
  }
  return out
}
