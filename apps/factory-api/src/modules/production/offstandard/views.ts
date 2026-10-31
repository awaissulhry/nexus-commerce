import { toUtcIso } from '@nexus/factory-domain/core/time'
import { minutesOf, unusualOf } from '@nexus/factory-domain/production/offstandard/rules'
import type { BlockRowView, CodeView } from './contract'
import { codesById, editedBlocks, linesById, stationsById, wordsOf, type BlockRow, type CodeRow, type Place, type Reader, type StationPlace } from './store'

/**
 * How off-standard time is shown (B-W2b-29): a code in the settings grid, a code as a tile, a block in a list (where,
 * which code, when, its state; never who: `named` only), a block on the tablet. One block's record (blocks.ts) adds its
 * worker where the site records workers.
 */

export const isoDay = (date: Date): string => date.toISOString().slice(0, 10)
/** A site's day as the Date column keeps it (midnight UTC of that calendar day). */
export const dayColumn = (day: string): Date => new Date(`${day}T00:00:00.000Z`)

export function codeViewOf(row: CodeRow, usedCount: number, callTypes: readonly string[]): CodeView {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    kind: row.kind,
    payRule: row.payRule,
    needsApproval: row.needsApproval,
    labelIt: row.labelIt,
    labelEn: row.labelEn,
    labelI18n: wordsOf(row.labelI18n),
    icon: row.icon,
    colour: row.colour,
    sortOrder: row.sortOrder,
    active: row.active,
    usedCount,
    callTypes: [...callTypes],
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

export const tileOf = (row: CodeRow) => ({
  id: row.id,
  code: row.code,
  kind: row.kind,
  needsApproval: row.needsApproval,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  labelI18n: wordsOf(row.labelI18n),
  icon: row.icon,
  colour: row.colour,
})

/** What a list of blocks reads once: their codes, stations, lines and which were changed after they ended. */
export interface RowFacts {
  readonly codes: Map<string, CodeRow>
  readonly stations: Map<string, StationPlace>
  readonly lines: Map<string, Place>
  readonly edited: Set<string>
  readonly now: Date
}

export async function rowFactsOf(db: Reader, blocks: readonly BlockRow[], now: Date): Promise<RowFacts> {
  const [codes, stations, lines, edited] = [
    await codesById(db, blocks.map((block) => block.codeId)),
    await stationsById(db, blocks.map((block) => block.stationId)),
    await linesById(db, blocks.map((block) => block.lineId)),
    await editedBlocks(db, blocks.filter((block) => block.endedAt !== null).map((block) => block.id)),
  ]
  return { codes, stations, lines, edited, now }
}

const placeOf = (row: Place | undefined) => (row ? { id: row.id, code: row.code, name: row.name } : null)

export function rowOf(block: BlockRow, facts: RowFacts): BlockRowView {
  const code = facts.codes.get(block.codeId)!
  const edited = facts.edited.has(block.id)
  return {
    id: block.id,
    version: block.version,
    siteId: block.siteId,
    line: block.lineId ? placeOf(facts.lines.get(block.lineId)) : null,
    station: block.stationId ? placeOf(facts.stations.get(block.stationId)) : null,
    code: { ...tileOf(code), payRule: code.payRule },
    source: block.source,
    status: block.status,
    workDate: isoDay(block.workDate),
    startedAt: toUtcIso(block.startedAt),
    endedAt: block.endedAt ? toUtcIso(block.endedAt) : null,
    minutes: minutesOf(block.startedAt, block.endedAt, facts.now),
    named: block.workerId !== null,
    helpCallId: block.helpCallId,
    unusual: block.status === 'PENDING' ? unusualOf({ status: block.status, source: block.source, startedAt: block.startedAt, endedAt: block.endedAt, edited }, facts.now) : [],
    decidedAt: block.approvedAt ? toUtcIso(block.approvedAt) : block.rejectedAt ? toUtcIso(block.rejectedAt) : null,
  }
}

/** A block on the tablet: its tile, since when, its state. */
export function floorBlockOf(block: BlockRow, code: CodeRow, now: Date) {
  return {
    id: block.id,
    version: block.version,
    code: tileOf(code),
    status: block.status,
    startedAt: toUtcIso(block.startedAt),
    endedAt: block.endedAt ? toUtcIso(block.endedAt) : null,
    minutes: minutesOf(block.startedAt, block.endedAt, now),
  }
}
export type FloorBlockView = ReturnType<typeof floorBlockOf>
