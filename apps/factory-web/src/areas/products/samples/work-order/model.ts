import type { WorkOrderBody, WorkOrderOptions } from '../api'
import { refusalPhrase, type Phrase } from '../model'

/**
 * "Make sample work order" (SCR-110-record, the Sample tab; B-W2b-246's dialog, B-W2b-284's second way), pure: on an order line
 * of the style (the order that charges the samples), or — an internal or uncharged proto, fit or salesman round — without one,
 * from the round's own cells (the API's `withoutLine`: allowed, or the refusal in words; a cell of "any colourway" needs the
 * colourway it is made in when the style has several). What holds the Make button is said in our words from the facts (the
 * API's `blockers` and `warnings` are English sentences without codes: counted, never shown).
 */

/** The two ways: on order lines, or without an order line (the round's own cells). */
export type WorkOrderMode = 'lines' | 'none'

export interface WorkOrderChoice {
  readonly mode: WorkOrderMode
  /** "none" only: the colourway of the round's cells of any colourway ('' while not picked). */
  readonly colourwayId: string
}

const LINES: WorkOrderChoice = { mode: 'lines', colourwayId: '' }

/** Both ways are open: there are order lines to pick and the round may be made without one. */
export const bothWays = (options: WorkOrderOptions): boolean => options.lines.length > 0 && options.withoutLine.allowed

/**
 * The way the dialog opens on: without an order line when the round may be made so and it is internal (the factory's own
 * development) or no order line is there; else on order lines.
 */
export function defaultMode(options: WorkOrderOptions): WorkOrderMode {
  if (!options.withoutLine.allowed) return 'lines'
  return options.round.partyId === null || options.lines.length === 0 ? 'none' : 'lines'
}

/** The round's cells of no colourway: a colourway is picked for them (none when the API already took the style's only one). */
export const needsColourway = (options: WorkOrderOptions): boolean => options.withoutLine.cells.some((cell) => cell.colourwayId === null)

/** The cells the work order without an order line would make: each with its colourway's code (the picked one for "any colourway"). */
export function cellsWithoutLine(options: WorkOrderOptions, colourwayId: string): { key: string; colourway: string | null; size: string; quantity: number }[] {
  const picked = options.withoutLine.colourways.find((row) => row.id === colourwayId) ?? null
  return options.withoutLine.cells.map((cell, index) => ({
    key: `${index}`,
    colourway: cell.colourwayId === null ? (picked?.code ?? null) : cell.colourwayCode,
    size: cell.size,
    quantity: cell.quantity,
  }))
}

/** The make dialog's facts said in our words. */
export function workOrderFacts(options: WorkOrderOptions, chosen: readonly string[], choice: WorkOrderChoice = LINES): { blockers: Phrase[]; warnings: Phrase[] } {
  const blockers: Phrase[] = []
  const warnings: Phrase[] = []
  if (choice.mode === 'none') {
    if (!options.withoutLine.allowed) blockers.push(refusalPhrase(options.withoutLine.refusal?.code))
    if (options.sites.length === 0) blockers.push({ key: 'wo.blocker.noSites' })
    if (options.withoutLine.allowed && needsColourway(options) && !choice.colourwayId) blockers.push({ key: 'wo.blocker.pickColourway' })
    if (options.sites.length > 0 && options.blockers.length > 0 && blockers.length === 0) blockers.push({ key: 'wo.blocker.other', params: { count: options.blockers.length } })
  } else {
    if (options.lines.length === 0) {
      blockers.push({ key: options.round.partyId ? 'wo.blocker.noLinesCustomer' : 'wo.blocker.noLines' })
      if (options.withoutLine.refusal) blockers.push(refusalPhrase(options.withoutLine.refusal.code))
    }
    if (options.sites.length === 0) blockers.push({ key: 'wo.blocker.noSites' })
    if (options.lines.length > 0 && chosen.length === 0) blockers.push({ key: 'wo.blocker.pickLine' })
    if (options.lines.length > 0 && options.sites.length > 0 && options.blockers.length > 0 && blockers.length === 0) blockers.push({ key: 'wo.blocker.other', params: { count: options.blockers.length } })
  }
  if (options.round.revision.status === 'DRAFT') warnings.push({ key: 'wo.warning.draft', params: { revision: options.round.revision.revision } })
  if (options.warnings.length > 0 && options.round.revision.status !== 'DRAFT') warnings.push({ key: 'wo.warning.other', params: { count: options.warnings.length } })
  return { blockers, warnings }
}

/** The POST body of the dialog as it stands: on the chosen order lines, or without an order line (the colourway when one is needed). */
export function workOrderBodyOf(dialog: { readonly siteId: string; readonly dueDate: string; readonly lineIds: readonly string[] } & WorkOrderChoice, options: WorkOrderOptions, version: number): WorkOrderBody {
  const base = { version, ...(dialog.siteId ? { siteId: dialog.siteId } : {}), ...(dialog.dueDate ? { dueDate: dialog.dueDate } : {}) }
  if (dialog.mode === 'none') return { ...base, ...(needsColourway(options) && dialog.colourwayId ? { colourwayId: dialog.colourwayId } : {}) }
  return { ...base, lines: dialog.lineIds.map((salesOrderLineId) => ({ salesOrderLineId })) }
}
