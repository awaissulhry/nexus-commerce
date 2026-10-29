import { decimalOf, decimalText } from '../units/units'
import type { BomLineData } from './rules'

/**
 * The difference between two revisions' BOMs (feature PRD-076; plan A1 §2.5: a change is a new revision), pure: what the
 * office reads before it releases a new revision, or when it asks what changed between the one a work order was made
 * from and today's.
 *
 * Lines have new ids in every revision, so a line of one is matched to a line of the other by what it is: the same
 * material, placement and colourway (the n-th such line of one with the n-th of the other, in BOM order). A line whose
 * material changed is one removed and one added. Decimals are compared as numbers ("45.0000" is "45").
 */

export interface BomSnapshot {
  readonly plannedHideYieldPct: string | null
  readonly labelTemplateId: string | null
  readonly lines: readonly BomLineData[]
}

export type FieldValue = string | number | boolean | null

export interface FieldChange {
  readonly field: string
  readonly from: FieldValue
  readonly to: FieldValue
}

export interface ChangedLine {
  readonly from: BomLineData
  readonly to: BomLineData
  readonly fields: readonly FieldChange[]
  readonly sizes: readonly { readonly size: string; readonly from: string | null; readonly to: string | null }[]
  readonly colours: readonly { readonly colourwayId: string; readonly from: string | null; readonly to: string | null }[]
}

export interface BomDiff {
  /** The revision's own fields that changed (planned hide yield, label template). */
  readonly revision: readonly FieldChange[]
  readonly added: readonly BomLineData[]
  readonly removed: readonly BomLineData[]
  readonly changed: readonly ChangedLine[]
  readonly unchanged: number
}

const sameDecimal = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : decimalOf(a).eq(decimalOf(b)))
const shown = (value: string | null): string | null => (value === null ? null : decimalText(value))
const keyOf = (line: BomLineData): string => `${line.itemId}\u0000${line.placement ?? ''}\u0000${line.colourwayId ?? ''}`

function lineFields(from: BomLineData, to: BomLineData): FieldChange[] {
  const fields: FieldChange[] = []
  const plain = (field: 'seq' | 'uom' | 'sizeDependent' | 'colourDependent' | 'itemColourId' | 'supplierId' | 'note') => {
    if (from[field] !== to[field]) fields.push({ field, from: from[field], to: to[field] })
  }
  const decimal = (field: 'qty' | 'wastagePct') => {
    if (!sameDecimal(from[field], to[field])) fields.push({ field, from: shown(from[field]), to: shown(to[field]) })
  }
  plain('seq')
  plain('uom')
  plain('sizeDependent')
  // A size-dependent line's own quantity follows its sizes: its sizes say what changed.
  if (!from.sizeDependent && !to.sizeDependent) decimal('qty')
  decimal('wastagePct')
  plain('colourDependent')
  plain('itemColourId')
  plain('supplierId')
  plain('note')
  return fields
}

function sizeChanges(from: BomLineData, to: BomLineData): ChangedLine['sizes'] {
  if (!from.sizeDependent && !to.sizeDependent) return []
  const before = new Map(from.sizeDependent ? from.sizes.map((row) => [row.size, row.qty]) : [])
  const after = new Map(to.sizeDependent ? to.sizes.map((row) => [row.size, row.qty]) : [])
  const sizes = [...new Set([...to.sizes.map((row) => row.size), ...from.sizes.map((row) => row.size)])]
  return sizes
    .map((size) => ({ size, from: shown(before.get(size) ?? null), to: shown(after.get(size) ?? null) }))
    .filter((change) => !sameDecimal(change.from, change.to))
}

function colourChanges(from: BomLineData, to: BomLineData): ChangedLine['colours'] {
  if (!from.colourDependent && !to.colourDependent) return []
  const before = new Map(from.colourDependent ? from.colours.map((cell) => [cell.colourwayId, cell.itemColourId]) : [])
  const after = new Map(to.colourDependent ? to.colours.map((cell) => [cell.colourwayId, cell.itemColourId]) : [])
  const colourways = [...new Set([...to.colours.map((cell) => cell.colourwayId), ...from.colours.map((cell) => cell.colourwayId)])]
  return colourways.map((colourwayId) => ({ colourwayId, from: before.get(colourwayId) ?? null, to: after.get(colourwayId) ?? null })).filter((change) => change.from !== change.to)
}

export function diffBoms(from: BomSnapshot, to: BomSnapshot): BomDiff {
  const revision: FieldChange[] = []
  if (!sameDecimal(from.plannedHideYieldPct, to.plannedHideYieldPct)) revision.push({ field: 'plannedHideYieldPct', from: shown(from.plannedHideYieldPct), to: shown(to.plannedHideYieldPct) })
  if (from.labelTemplateId !== to.labelTemplateId) revision.push({ field: 'labelTemplateId', from: from.labelTemplateId, to: to.labelTemplateId })

  const queues = new Map<string, BomLineData[]>()
  for (const line of [...from.lines].sort((a, b) => a.seq - b.seq)) queues.set(keyOf(line), [...(queues.get(keyOf(line)) ?? []), line])
  const added: BomLineData[] = []
  const changed: ChangedLine[] = []
  let unchanged = 0
  for (const line of [...to.lines].sort((a, b) => a.seq - b.seq)) {
    const queue = queues.get(keyOf(line))
    const match = queue?.shift()
    if (!match) {
      added.push(line)
      continue
    }
    const change: ChangedLine = { from: match, to: line, fields: lineFields(match, line), sizes: sizeChanges(match, line), colours: colourChanges(match, line) }
    if (change.fields.length + change.sizes.length + change.colours.length === 0) unchanged++
    else changed.push(change)
  }
  const removed = [...queues.values()].flat().sort((a, b) => a.seq - b.seq)
  return { revision, added, removed, changed, unchanged }
}
