import type { BusinessDate } from '../../core/time'
import type { GateLine } from '../gates/gate'
import { GATE_WORDS, type ComplianceGate, type FixPlace, type Who } from '../requirements/rules'

/**
 * The compliance status board's reads (B-W2b-254; PRD-277, PRD-271; design compliance.status SCR-119: cs-kpi readiness
 * tiles, cs-actions "Needs action", cs-matrix style × market, cs-cell the checklist, cs-expiry "What expires next"), pure.
 * A cell is one style for one market: the requirement checklist the gate function computes with the market's languages
 * (every market is asked, as if the style sold there), folded into one state — Ready, Missing n, Blocked (a missing
 * requirement blocks a gate: work cannot go on), Expiring — in words and a code, never a colour alone.
 */

export const CELL_STATES = ['READY', 'MISSING', 'BLOCKED', 'EXPIRING'] as const
export type CellState = (typeof CELL_STATES)[number]

export interface CellSummary {
  readonly state: CellState
  /** Missing requirements (any). */
  readonly missing: number
  /** Missing requirements that block at least one gate. */
  readonly blocking: number
  readonly expiring: number
  /** Checked by a person (no computed check). */
  readonly manual: number
  /** The gates the missing requirements block, in gate order. */
  readonly blockedGates: readonly ComplianceGate[]
  /** The first missing (blocking first) line: what to fix first. */
  readonly first: { readonly code: string; readonly message: string; readonly fix: string | null; readonly who: Who; readonly fixPlace: FixPlace; readonly legalReference: string } | null
}

const GATE_ORDER: readonly ComplianceGate[] = ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT']

/** One cell from its lines (the lines of one style × market; any gate: `blocks` is read from the requirement). */
export function cellOf(lines: readonly GateLine[]): CellSummary {
  // One line per requirement: a style × market cell has one target per requirement.
  const missingLines = lines.filter((line) => line.state === 'MISSING')
  const blockingLines = missingLines.filter((line) => line.requirement.blocks.length > 0)
  const expiring = lines.filter((line) => line.state === 'EXPIRING').length
  const manual = lines.filter((line) => line.state === 'MANUAL').length
  const blockedGates = GATE_ORDER.filter((gate) => blockingLines.some((line) => line.requirement.blocks.includes(gate)))
  const firstLine = blockingLines[0] ?? missingLines[0] ?? lines.find((line) => line.state === 'EXPIRING') ?? null
  const state: CellState = blockingLines.length > 0 ? 'BLOCKED' : missingLines.length > 0 ? 'MISSING' : expiring > 0 ? 'EXPIRING' : 'READY'
  return {
    state,
    missing: missingLines.length,
    blocking: blockingLines.length,
    expiring,
    manual,
    blockedGates,
    first: firstLine ? { code: firstLine.requirement.code, message: firstLine.message, fix: firstLine.fix, who: firstLine.who, fixPlace: firstLine.fixPlace, legalReference: firstLine.requirement.legalReference } : null,
  }
}

export const CELL_WORDS: Readonly<Record<CellState, string>> = { READY: 'Ready', MISSING: 'Missing', BLOCKED: 'Blocked', EXPIRING: 'Expiring' }

/** "Missing 2", "Blocked", "Ready" — the cell's words (screens say their own per code). */
export const cellWords = (cell: Pick<CellSummary, 'state' | 'missing'>): string => (cell.state === 'MISSING' ? `Missing ${cell.missing}` : CELL_WORDS[cell.state])

export interface ActionInput {
  readonly styleId: string
  readonly styleCode: string
  readonly marketCode: string
  readonly marketName: string
  readonly cell: CellSummary
}

export interface NeedsAction {
  readonly styleId: string
  readonly styleCode: string
  readonly marketCode: string
  readonly requirementCode: string
  readonly words: string
  readonly who: Who
  readonly fixPlace: FixPlace
  readonly severity: 'BLOCKED' | 'MISSING' | 'EXPIRING'
}

const WHO_WORDS: Readonly<Record<Who, string>> = { COMPLIANCE: 'Compliance', QUALITY: 'Quality', PRODUCTION: 'Production', SALES: 'Sales' }

/**
 * "Needs action" (cs-actions): the blockers in plain words, worst first (blocked, then missing, then expiring; more
 * blocked gates first, then the style and market), each with who can clear it. `limit` lines and how many there are in all (`count`).
 */
export function needsAction(cells: readonly ActionInput[], limit = 5): { readonly lines: NeedsAction[]; readonly count: number } {
  const rank = { BLOCKED: 0, MISSING: 1, EXPIRING: 2, READY: 3 } as const
  const all = cells
    .filter((entry) => entry.cell.state !== 'READY' && entry.cell.first !== null)
    .sort((a, b) => rank[a.cell.state] - rank[b.cell.state] || b.cell.blockedGates.length - a.cell.blockedGates.length || a.styleCode.localeCompare(b.styleCode) || a.marketCode.localeCompare(b.marketCode))
    .map((entry): NeedsAction => {
      const first = entry.cell.first!
      const gate = entry.cell.blockedGates.at(-1)
      const head = entry.cell.state === 'BLOCKED' && gate ? `${entry.styleCode} cannot ${GATE_WORDS[gate].verb === 'leave' ? `ship to ${entry.marketName}` : `${GATE_WORDS[gate].verb} for ${entry.marketName}`}` : `${entry.styleCode} for ${entry.marketName}`
      return {
        styleId: entry.styleId,
        styleCode: entry.styleCode,
        marketCode: entry.marketCode,
        requirementCode: first.code,
        words: `${head}: ${first.message.replace(/[.\s]+$/u, '')}. ${WHO_WORDS[first.who]}${first.fix ? ` · ${first.fix}` : ''}`,
        who: first.who,
        fixPlace: first.fixPlace,
        severity: entry.cell.state === 'READY' ? 'EXPIRING' : entry.cell.state,
      }
    })
  return { lines: all.slice(0, limit), count: all.length }
}

export interface ExpiryItem {
  readonly recordType: string
  readonly recordId: string
  readonly label: string
  readonly validTo: BusinessDate
}

/** "What expires next" (cs-expiry): the items ending within `months` months from `day`, per month (YYYY-MM), in date order. */
export function expiryMonths(items: readonly ExpiryItem[], day: BusinessDate, months = 12): { readonly month: string; readonly count: number; readonly items: ExpiryItem[] }[] {
  const [year, month] = day.split('-').map(Number) as [number, number]
  const keys = Array.from({ length: months }, (_, index) => {
    const at = new Date(Date.UTC(year, month - 1 + index, 1))
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
  })
  const sorted = [...items].filter((item) => item.validTo >= day).sort((a, b) => a.validTo.localeCompare(b.validTo) || a.label.localeCompare(b.label))
  return keys.map((key) => {
    const inMonth = sorted.filter((item) => item.validTo.startsWith(key))
    return { month: key, count: inMonth.length, items: inMonth }
  })
}

/** The last day of the window `months` months after `day` (the board reads expiries up to it). */
export function windowEnd(day: BusinessDate, months: number): BusinessDate {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const at = new Date(Date.UTC(year, month - 1 + months, date))
  return at.toISOString().slice(0, 10)
}
