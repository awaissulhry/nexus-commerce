import type { JudgementRow, PpeCard, ShownJudgement, VisitRow } from './api'

/**
 * The pure rules of Employee › Safety (B-W2b-146; design people.employees rec:Employee tab "Safety": Role risk sheet, PPE
 * issued, Fitness judgement, Incidents): who may read which section, the PPE rows and the missing kit items, the fitness
 * section's state (only the outcome, never clinical data), the next visit due. Health values are the tab's state alone.
 */

export const SAFETY_NAMESPACES = ['people-training', 'people', 'lists', 'shell'] as const

export interface SafetyCan {
  /** people.view: the role sheet (the person's record is already read with it). */
  roleSheet: boolean
  /** safety.view: PPE issued. */
  ppe: boolean
  /** safety.health.view: the fitness judgement and the next visit (HR and the occupational doctor; every view recorded). */
  health: boolean
  /** safety.incidents.people: incidents that name a person (the safety officer and HR). */
  incidents: boolean
}

export function safetyCan(permissions: readonly string[]): SafetyCan {
  const held = new Set(permissions)
  return { roleSheet: held.has('people.view'), ppe: held.has('safety.view'), health: held.has('safety.health.view'), incidents: held.has('safety.incidents.people') }
}

/** One row of "PPE issued": a receipt's line (voided lines left out), newest first. */
export interface PpeRow {
  id: string
  issuedAt: string
  item: { name: string; nameI18n: Record<string, string> | null; code: string }
  size: string | null
  quantity: number
  /** SIGNED_PIN, SIGNED_PAPER, NOT_SIGNED, VOIDED (the receipt's). */
  receipt: string
  receiptId: string
}

export function ppeRowsOf(card: Pick<PpeCard, 'receipts'>): PpeRow[] {
  return card.receipts
    .flatMap((entry) => entry.lines.filter((line) => line.voided === null).map((line) => ({ id: line.id, issuedAt: line.issuedAt, item: line.item, size: line.size, quantity: line.quantity, receipt: entry.state, receiptId: entry.id })))
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
}

/** The kit items the person misses units of (the role's kit against what they hold). */
export const missingKit = (card: Pick<PpeCard, 'kit'>) => card.kit.filter((line) => line.missing > 0)

export const itemName = (item: { name: string; nameI18n: Record<string, string> | null }, locale: string): string => item.nameI18n?.[locale] || item.name

/** The receipt's state as a tone and a message key. */
export function receiptTone(state: string): { tone: 'success' | 'warning' | 'neutral'; key: string } {
  if (state === 'SIGNED_PIN' || state === 'SIGNED_PAPER') return { tone: 'success', key: `ppe.receipt.${state}` }
  if (state === 'VOIDED') return { tone: 'neutral', key: 'ppe.receipt.VOIDED' }
  return { tone: 'warning', key: 'ppe.receipt.NOT_SIGNED' }
}

// ---- fitness ----------------------------------------------------------------------------------------------------------------------

/** The judgement in force (or the latest current one): the API's `state=current` answer, newest day first. */
export const currentJudgement = (rows: readonly JudgementRow[]): JudgementRow | null => [...rows].sort((a, b) => b.judgedOn.localeCompare(a.judgedOn))[0] ?? null

/** The next open visit by due day (overdue first). */
export const nextVisit = (visits: readonly VisitRow[]): VisitRow | null => [...visits].filter((visit) => visit.status === 'DUE' || visit.status === 'BOOKED').sort((a, b) => (a.booked?.on ?? a.dueOn).localeCompare(b.booked?.on ?? b.dueOn))[0] ?? null

/** The outcome in words' keys: Fit / Fit with limits / Temporarily unfit until … / Unfit (never a clinical word). */
export function outcomeKey(judgement: Pick<ShownJudgement, 'outcome' | 'unfitUntil'>): { key: string; until: string | null } {
  return { key: `fitness.outcome.${judgement.outcome}`, until: judgement.outcome === 'TEMPORARILY_UNFIT' ? judgement.unfitUntil : null }
}

/** The fitness section's state while it is not shown: who may not see it says so; a reader sees the anonymised row only. */
export type FitnessState =
  | { status: 'restricted' }
  | { status: 'loading' }
  | { status: 'error'; problem: string }
  | { status: 'none' }
  | { status: 'hidden'; judgement: JudgementRow }
  | { status: 'opening'; judgement: JudgementRow }
  | { status: 'shown'; judgement: ShownJudgement; next: VisitRow | null; recordedAt: string }
  | { status: 'failed'; judgement: JudgementRow }
