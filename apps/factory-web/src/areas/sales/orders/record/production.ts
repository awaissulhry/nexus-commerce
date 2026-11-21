import { progressFigure, type ProgressFigure } from '../../../../lib/production/model'

/**
 * Lead fix (production-page lane): never "0 sewn" where the site does not scan sewing — the steps a site does not count
 * (a null count) are listed, never 0 (`ownProgress` below; F-PT-403: the old per-work-order `productionProgress` went with its card).
 */
export const COUNTED_STEPS = ['cut', 'sewn', 'finished'] as const
export type CountedStep = (typeof COUNTED_STEPS)[number]

// ── F-SA-234 (sales page plan N2, picks P2, P3, P12; 10-order-page §2.3 P1) ───────────────────────────────────────────────────────
/** What a work order makes for THIS order (the production read's own share: its cells of this order's lines; null where not counted). */
export interface OwnShare {
  readonly cells: number
  readonly pieces: number
  readonly cut: number | null
  readonly sewn: number | null
  readonly checked: number | null
}

/**
 * ONE figure of the order's OWN cells on a work order (never the work order's total): the furthest step reached — cut, sewn, or
 * checked (released by quality) — its words and its bar from the same number (rule R5); a step its site does not count is listed
 * as "not counted here", never 0. Not released: no figure.
 */
export function ownProgress(own: OwnShare, status: string): { readonly figure: ProgressFigure; readonly notCounted: readonly CountedStep[] } {
  const released = status !== 'DRAFT'
  const counts = { cut: own.cut, bundled: null, sewn: own.sewn, finished: own.checked }
  const figure = progressFigure(counts, own.pieces, released)
  const notCounted = released ? COUNTED_STEPS.filter((step) => counts[step] === null) : []
  return { figure, notCounted }
}

/** "Made for this order": its own pieces of the work order's whole (when the whole is read), and what else it makes, in words. */
export function madeForOf(own: OwnShare, total: number | null, also: { readonly orders: readonly { readonly number: string }[]; readonly more: number }, shared: boolean, cutTogether: boolean): { readonly key: string; readonly params: Record<string, string | number> }[] {
  const out: { key: string; params: Record<string, string | number> }[] = [total !== null && total > own.pieces ? { key: 'production.own.of', params: { own: own.pieces, total } } : { key: 'production.own.all', params: { own: own.pieces } }]
  if (also.orders.length > 0) out.push({ key: 'production.own.alsoMakes', params: { number: also.orders.map((order) => order.number).join(', ') } })
  if (also.more > 0) out.push({ key: 'production.own.alsoMore', params: { count: also.more } })
  // A work order made before the one-customer rule: "also makes work of other orders" — no number, no name, no count of theirs.
  if (shared) out.push({ key: 'production.own.alsoOther', params: {} })
  if (cutTogether) out.push({ key: 'production.own.cutTogether', params: {} })
  return out
}
// ── end F-SA-234

// ── F-SA-231b (sa-7's follow-up; 10-order-page §2.2 L3): a style card's artwork chip ───────────────────────────────────────────────
/** One artwork file a line shows that the reader may open (the order read's `lines[].artwork`, files.read). */
export interface ArtworkFile {
  readonly fileId: string
  readonly name: string
  readonly contentType: string
  readonly sizeBytes: number
}

/**
 * The artwork of a style's colour lines for its chip: the files the order read names (each once, in the lines' order — the viewer
 * walks them), and how many — the files' number, else the count the read gave (an older read names no files: the chip then opens the
 * order's Files tab). Never a file the read did not name.
 */
export function artworkOfGroup(lines: readonly { readonly artwork?: readonly ArtworkFile[]; readonly artworkCount?: number }[]): { readonly files: readonly ArtworkFile[]; readonly count: number } {
  const seen = new Set<string>()
  const files: ArtworkFile[] = []
  for (const line of lines) {
    for (const file of line.artwork ?? []) {
      if (seen.has(file.fileId)) continue
      seen.add(file.fileId)
      files.push(file)
    }
  }
  const counted = lines.reduce((sum, line) => sum + (line.artworkCount ?? 0), 0)
  return { files, count: files.length > 0 ? files.length : counted }
}

// ---- F-OP-112 (10-order-page §5.1): Make work orders… in place — the order as the New work order dialog's fixed order, why it waits ----
import type { OrderOption } from '../../../production/_shared/api'
import type { Order } from '../api'
import { nextStep, type OrderAbilities, type Phrase } from '../model'

/** The order as the New work order dialog's one choice (its number, customer, PO, state and pieces; the order fixed, no search). */
export function orderOptionOf(order: Pick<Order, 'id' | 'number' | 'party' | 'customerRef' | 'status' | 'lines'>): OrderOption {
  return { id: order.id, number: order.number, partyName: order.party?.legalName ?? order.party?.code ?? '—', customerRef: order.customerRef, status: order.status, units: order.lines.reduce((sum, line) => sum + line.quantity, 0) }
}

/**
 * Why "Make work orders…" waits on the order (held in words, never hidden): no right to make work orders (`held.noWorkOrders`), and a
 * confirmed order's deposit waiting (its due day) or missing — the band's own rule (nextStep). In production: only the right.
 */
export function makeHeldOf(order: Order, can: OrderAbilities): Phrase | null {
  if (!can.makeWorkOrders) return { key: 'held.noWorkOrders' }
  return order.status === 'CONFIRMED' ? nextStep(order, can).held : null
}
// ---- end F-OP-112
