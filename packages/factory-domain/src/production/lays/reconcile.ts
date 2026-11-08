import type { Issue } from '../../core/errors'
import type { Language } from '../../inventory/rolls/rolls'

/**
 * Cut against ordered (B-W2b-116; MES-045 "Cut reconciliation"; design production.cutting pop "Reconcile cut": "planned vs cut per
 * size, material issued vs used vs returned, end bits, variance reason"), pure. Once a cut order is CUT the office reconciles it:
 * one row per line (CutReconciliation, append-only), and the cut order is RECONCILED.
 *
 *   ordered  the line's garments (ratio × the cut order's plies for fabric)
 *   cut      FABRIC: the line's ratio × the plies counted at both ends on its CUT lays (every ply is cut by the whole marker);
 *            LEATHER: the cell's garments cut in the cut log less what earlier reconciled leather cut orders took of the cell
 *            (the cut log names no cut order)
 *   recut    garments of the cell whose panels were recut (RECUT tickets done since the release), at most the cut
 *   reason   a variance reason exactly when cut differs from ordered (a code of the list below; OTHER with words)
 *
 * A fabric cut order is reconciled once each CUT lay's fabric used is confirmed (that issued its fabric to the work orders).
 * Counts only: no money, no person.
 */

export const CUT_VARIANCE_REASONS = ['PLIES_SHORT', 'FABRIC_SHORT', 'ROLL_FAULT', 'MISCUT', 'OVERCUT', 'OTHER'] as const
export type CutVarianceReason = (typeof CUT_VARIANCE_REASONS)[number]

export const VARIANCE_WORDS: Readonly<Record<CutVarianceReason, { readonly it: string; readonly en: string }>> = Object.freeze({
  PLIES_SHORT: { it: 'Meno strati stesi del piano', en: 'Fewer plies spread than planned' },
  FABRIC_SHORT: { it: 'Tessuto finito', en: 'The fabric ran out' },
  ROLL_FAULT: { it: 'Difetto del rotolo', en: 'A fault in the roll' },
  MISCUT: { it: 'Errore di taglio', en: 'Cut wrong' },
  OVERCUT: { it: 'Tagliato in più', en: 'Cut more than ordered' },
  OTHER: { it: 'Altro (scritto)', en: 'Other (in words)' },
})

export const isVarianceReason = (value: string): value is CutVarianceReason => (CUT_VARIANCE_REASONS as readonly string[]).includes(value)

export const RECONCILE_REFUSALS = ['NOT_CUT', 'FABRIC_NOT_CONFIRMED'] as const
export type ReconcileRefusalCode = (typeof RECONCILE_REFUSALS)[number]
export interface ReconcileRefusal {
  readonly code: ReconcileRefusalCode
  readonly message: string
}

/** A fabric line's garments cut: its ratio × the plies counted on the cut order's CUT lays. */
export const fabricCut = (ratio: number, countedPlies: number): number => ratio * countedPlies

/** A leather line's garments cut: the cell's cut less what earlier reconciliations of the cell took, from 0. */
export const leatherCut = (cellCut: number, reconciledBefore: number): number => Math.max(0, cellCut - reconciledBefore)

export interface LineFigures {
  readonly ordered: number
  readonly cut: number
  readonly recut: number
  /** cut − ordered. */
  readonly difference: number
  readonly needsReason: boolean
}

export function lineFigures(ordered: number, cut: number, recutDone: number): LineFigures {
  return { ordered, cut, recut: Math.min(cut, Math.max(0, recutDone)), difference: cut - ordered, needsReason: cut !== ordered }
}

/** Why the cut order is not reconciled now (null: it may be). */
export function reconcileRefusal(order: { readonly number: string; readonly status: string }, unconfirmedLays: readonly number[]): ReconcileRefusal | null {
  if (order.status !== 'CUT') {
    const why = order.status === 'RECONCILED' ? 'is reconciled already' : order.status === 'CANCELLED' ? 'was cancelled' : `is ${order.status.toLowerCase().replace('_', ' ')}`
    return { code: 'NOT_CUT', message: `Cut order ${order.number} ${why}: a cut order is reconciled once it is cut.` }
  }
  if (unconfirmedLays.length > 0) {
    const lays = unconfirmedLays.map((seq) => String(seq)).join(', ')
    return { code: 'FABRIC_NOT_CONFIRMED', message: `The fabric used on lay${unconfirmedLays.length === 1 ? '' : 's'} ${lays} is not confirmed: confirm it first (it issues the fabric to the work orders).` }
  }
  return null
}

export interface ReasonDraft {
  readonly lineId: string
  readonly reasonCode?: string | undefined
  readonly note?: string | null | undefined
}

/** The reasons' problems (paths under `lines/<index>`): one per line that differs, none on a line that does not, OTHER with words. */
export function reasonProblems(lines: readonly { readonly id: string; readonly seq: number; readonly figures: LineFigures }[], given: readonly ReasonDraft[]): Issue[] {
  const problems: Issue[] = []
  const byLine = new Map(given.map((entry, index) => [entry.lineId, { entry, index }]))
  given.forEach((entry, index) => {
    if (!lines.some((line) => line.id === entry.lineId)) problems.push({ path: `lines/${index}/lineId`, message: 'Not a line of this cut order still to reconcile.' })
  })
  if (byLine.size !== given.length) problems.push({ path: 'lines', message: 'A line is named twice.' })
  for (const line of lines) {
    const found = byLine.get(line.id)
    const code = found?.entry.reasonCode?.trim()
    const at = found ? `lines/${found.index}` : 'lines'
    if (line.figures.needsReason && !code) {
      problems.push({ path: `${at}/reasonCode`, message: `Line ${line.seq} cut ${line.figures.cut} of ${line.figures.ordered}: say why (a variance reason).` })
    } else if (!line.figures.needsReason && code) {
      problems.push({ path: `${at}/reasonCode`, message: `Line ${line.seq} cut what it ordered: it takes no variance reason.` })
    } else if (code && !isVarianceReason(code)) {
      problems.push({ path: `${at}/reasonCode`, message: `A variance reason of the list: ${CUT_VARIANCE_REASONS.join(', ')}.` })
    } else if (code === 'OTHER' && !(found?.entry.note ?? '').trim()) {
      problems.push({ path: `${at}/note`, message: 'Other: say why in words.' })
    }
  }
  return problems
}

/** Ordered and cut per size, in the order sizes first appear: "planned vs cut per size". */
export function bySize(lines: readonly { readonly size: string; readonly figures: LineFigures }[]): { size: string; ordered: number; cut: number; recut: number; difference: number }[] {
  const sizes = new Map<string, { size: string; ordered: number; cut: number; recut: number; difference: number }>()
  for (const line of lines) {
    const entry = sizes.get(line.size) ?? { size: line.size, ordered: 0, cut: 0, recut: 0, difference: 0 }
    entry.ordered += line.figures.ordered
    entry.cut += line.figures.cut
    entry.recut += line.figures.recut
    entry.difference = entry.cut - entry.ordered
    sizes.set(line.size, entry)
  }
  return [...sizes.values()]
}

/** "80 ordered · 78 cut (−2)" (it "80 ordinati · 78 tagliati (−2)"); "80 ordered · 80 cut" when equal. */
export function reconcileWords(sum: { readonly ordered: number; readonly cut: number }, language: Language): string {
  const it = language === 'it'
  const difference = sum.cut - sum.ordered
  const tail = difference === 0 ? '' : ` (${difference > 0 ? '+' : '−'}${Math.abs(difference)})`
  return `${sum.ordered} ${it ? 'ordinati' : 'ordered'} · ${sum.cut} ${it ? 'tagliati' : 'cut'}${tail}`
}
