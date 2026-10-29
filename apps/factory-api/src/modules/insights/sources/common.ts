import type { FactoryClient } from '@nexus/factory-db'
import type { AttentionCandidate, AttentionKind, Viewer } from '@nexus/factory-domain/insights/attention'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'

/**
 * What every source of Today shares (B-W1-52). A source reads ONLY the rows its kind's view permission reaches
 * (scopeWhere over the record's company, site and party), through the owning module's own reads where one exists, and
 * turns those that need a person into candidates; factory-domain insights/attention decides which are the viewer's. It
 * writes nothing. Queries run one after another (one connection runs one query at a time).
 */

export interface SourceInput {
  readonly caller: CommandCaller
  readonly viewer: Viewer
}

export interface SourceAnswer {
  readonly kind: AttentionKind
  readonly candidates: AttentionCandidate[]
  /** False when the source stopped at its limit: the count is at least what is shown. */
  readonly complete: boolean
}

export type Source = (input: SourceInput) => Promise<SourceAnswer>

/** The most rows one source reads (W1 volumes are far below it; an answer says when it was reached). */
export const SOURCE_LIMIT = 200
/** The most records a source runs a heavy check on (the release check, a style's compliance, a register trace). */
export const CHECK_LIMIT = 50

export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dayOrNull = (value: Date | null): BusinessDate | null => (value ? dayOf(value) : null)
export const asDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)

/** The first `limit` rows, and whether there were no more. */
export function capped<T>(rows: readonly T[], limit: number): { readonly rows: T[]; readonly complete: boolean } {
  return { rows: rows.slice(0, limit), complete: rows.length <= limit }
}

/** Party names by id (legal name). */
export async function partyNames(db: FactoryClient, ids: Iterable<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.party.findMany({ where: { id: { in: wanted } }, select: { id: true, legalName: true } })).map((row) => [row.id, row.legalName]))
}
