import type { Prisma } from '@nexus/factory-db'
import type { ReasonList } from '@nexus/factory-domain/reasons/lists'
import { storeOf, type ReasonRow } from './sources'

/**
 * How other modules read a reason list (B-W2a-18): pass your own client (`tools.tx` inside a command, or
 * `caller.withClient`); no permission is checked here (your route checks its own). Every list, whatever table keeps it.
 * Records keep the code as text (never a reference), so check it here inside the command that stores it: an unknown or
 * inactive code is refused in your words; a code that needs detail needs your note.
 */

type Client = Prisma.TransactionClient

export interface ReasonFact {
  readonly code: string
  readonly active: boolean
  readonly needsDetail: boolean
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n: Readonly<Record<string, string>>
}

const factOf = (row: ReasonRow): ReasonFact => ({ code: row.code, active: row.active, needsDetail: row.needsDetail, labelIt: row.labelIt, labelEn: row.labelEn, labelI18n: row.labelI18n })

/** One code of a list (active or not), or null when the list has no such code. */
export async function reasonFor(client: Client, list: ReasonList, code: string): Promise<ReasonFact | null> {
  const row = (await storeOf(list).rows(client, [list])).find((entry) => entry.code === code)
  return row ? factOf(row) : null
}

/** The active codes of a list. */
export async function activeReasonCodes(client: Client, list: ReasonList): Promise<Set<string>> {
  return new Set((await storeOf(list).rows(client, [list], { activeOnly: true })).map((row) => row.code))
}

/** The words of codes of a list (active or not), for a record's view: code → its facts. */
export async function reasonWords(client: Client, list: ReasonList): Promise<Map<string, ReasonFact>> {
  return new Map((await storeOf(list).rows(client, [list])).map((row) => [row.code, factOf(row)]))
}
