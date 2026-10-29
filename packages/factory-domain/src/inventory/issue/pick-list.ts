import { NOT_COUNTED_WORDS, usabilityOf, type LotQuality, type UnusableReason } from '../../planning/usable'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { quantityText, type ItemTracking } from '../ledger/moves'
import { stillToIssue, type HideState } from './rules'

/**
 * A work order's pick list (B-W1-39; A2 SCR-093 "need", SCR-070 "Materials & leather"; SCM-215), pure: per material
 * and colour the work order plans (its frozen WorkOrderMaterial rows: one per BOM line × cell, in the base unit), what
 * is planned, what the stock ledger says was issued to it (issued minus returned), what it still needs, and where to
 * take it from: the usable stock of the site, oldest first (by the lot's receipt, then its code, the hide's tag and the
 * location), and the held stock with its reason (planning/usable: chromium VI pending or failed, quality hold, blocked,
 * rejected). What the work order holds of each lot and hide (with what was cut of a hide) is what may come back.
 *
 * Issued is shared over the BOM line × cell rows in their order (BOM line, then cell), each up to its plan; what is
 * issued beyond the plan is the line's `over`. W1 has no bins or reservations: no route order (W2b SCM-212).
 */

/** At most this many usable lots or hides per line are listed (the rest are counted in `more`). */
export const MAX_CANDIDATES = 50

export interface PickMaterial {
  readonly id: string
  readonly bomLineId: string
  readonly bomSeq: number
  readonly placement: string | null
  readonly itemId: string
  readonly itemColourId: string | null
  readonly workOrderSizeId: string
  /** The cell's place in the work order: its colourway's, then the style's size order. */
  readonly cellOrder: number
  readonly colourwayCode: string
  readonly size: string
  readonly baseQuantity: DecimalInput
}

export interface PickItem {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly baseUom: string
  readonly tracking: ItemTracking
}

export interface PickColour {
  readonly id: string
  readonly code: string
  readonly name: string
}

/** A balance of the site: one stock key at one location, above 0. */
export interface PickStock {
  readonly locationId: string
  readonly locationCode: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
  readonly onHand: DecimalInput
}

export interface PickLot extends LotQuality {
  readonly id: string
  readonly code: string
  /** ISO time it was received, or null (opening stock). */
  readonly receivedAt: string | null
  readonly dyeBatch: string | null
}

export interface PickHide {
  readonly id: string
  readonly code: string
  readonly state: HideState
  readonly grade: string | null
}

/** What the work order holds of one stock key: issued minus returned (the ledger), in the base unit. */
export interface AtWorkOrder {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
  readonly quantity: DecimalInput
}

export interface PickInput {
  readonly materials: readonly PickMaterial[]
  readonly items: ReadonlyMap<string, PickItem>
  readonly colours: ReadonlyMap<string, PickColour>
  readonly stock: readonly PickStock[]
  readonly lots: ReadonlyMap<string, PickLot>
  readonly hides: ReadonlyMap<string, PickHide>
  readonly atWorkOrder: readonly AtWorkOrder[]
  /** Per hide: what was cut of it for the work order (net of reversals). */
  readonly cuts: ReadonlyMap<string, DecimalInput>
}

export interface PickRow {
  readonly materialId: string
  readonly bomLineId: string
  readonly bomSeq: number
  readonly placement: string | null
  readonly workOrderSizeId: string
  readonly colourwayCode: string
  readonly size: string
  readonly planned: string
  readonly issued: string
  readonly toIssue: string
}

export interface PickCandidate {
  readonly lotId: string | null
  readonly lotCode: string | null
  readonly hideId: string | null
  readonly hideCode: string | null
  readonly hideState: HideState | null
  readonly grade: string | null
  readonly dyeBatch: string | null
  readonly receivedAt: string | null
  readonly locationId: string
  readonly locationCode: string
  readonly onHand: string
}

export interface PickHeld {
  readonly reason: UnusableReason
  readonly words: string
  readonly lotId: string
  readonly lotCode: string
  readonly onHand: string
  /** Its hides on hand (0 for a lot without hides). */
  readonly hides: number
}

export interface PickHolding {
  readonly lotId: string | null
  readonly lotCode: string | null
  readonly hideId: string | null
  readonly hideCode: string | null
  readonly quantity: string
  /** What was cut of the hide for the work order (0 for anything else). */
  readonly cut: string
  /** What may come back: what it holds minus what was cut. */
  readonly returnable: string
}

export interface PickLine {
  readonly itemId: string
  readonly itemCode: string
  readonly itemName: string
  readonly tracking: ItemTracking
  readonly baseUom: string
  readonly itemColourId: string | null
  readonly colourCode: string | null
  readonly colourName: string | null
  readonly planned: string
  readonly issued: string
  readonly toIssue: string
  /** Issued beyond the plan (over-issues). */
  readonly over: string
  /** Nothing left to issue. */
  readonly covered: boolean
  readonly rows: PickRow[]
  readonly usable: { readonly onHand: string; readonly candidates: PickCandidate[]; readonly more: number }
  readonly held: PickHeld[]
  readonly atWorkOrder: PickHolding[]
}

const keyOf = (itemId: string, itemColourId: string | null): string => `${itemId}|${itemColourId ?? '-'}`
const dec = (value: DecimalInput): Decimal => new Dec(value)
const text = quantityText
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Oldest first: the lot's receipt (none last), its code, the hide's tag, the location's code. */
export function oldestFirst(a: PickCandidate, b: PickCandidate): number {
  if (a.receivedAt !== b.receivedAt) {
    if (a.receivedAt === null) return 1
    if (b.receivedAt === null) return -1
    return compare(a.receivedAt, b.receivedAt)
  }
  return compare(a.lotCode ?? '', b.lotCode ?? '') || compare(a.hideCode ?? '', b.hideCode ?? '') || compare(a.locationCode, b.locationCode)
}

/** The pick list (rules in the header): one line per material and colour, in BOM order. */
export function pickList(input: PickInput): PickLine[] {
  const groups = new Map<string, PickMaterial[]>()
  for (const material of input.materials) {
    const key = keyOf(material.itemId, material.itemColourId)
    groups.set(key, [...(groups.get(key) ?? []), material])
  }
  const held = new Map<string, Decimal>()
  for (const row of input.atWorkOrder) {
    const key = keyOf(row.itemId, row.itemColourId)
    held.set(key, (held.get(key) ?? ZERO).plus(dec(row.quantity)))
  }

  const lines = [...groups.entries()].map(([key, materials]) => {
    const first = materials[0]!
    const item = input.items.get(first.itemId)
    const colour = first.itemColourId ? input.colours.get(first.itemColourId) : undefined
    const ordered = [...materials].sort((a, b) => a.bomSeq - b.bomSeq || a.cellOrder - b.cellOrder || compare(a.id, b.id))
    const planned = ordered.reduce((sum, row) => sum.plus(dec(row.baseQuantity)), ZERO)
    const issued = held.get(key) ?? ZERO
    let left = Dec.max(ZERO, issued)
    const rows: PickRow[] = ordered.map((row) => {
      const plan = dec(row.baseQuantity)
      const share = Dec.min(left, plan)
      left = left.minus(share)
      return {
        materialId: row.id,
        bomLineId: row.bomLineId,
        bomSeq: row.bomSeq,
        placement: row.placement,
        workOrderSizeId: row.workOrderSizeId,
        colourwayCode: row.colourwayCode,
        size: row.size,
        planned: text(plan),
        issued: text(share),
        toIssue: text(plan.minus(share)),
      }
    })
    const toIssue = stillToIssue({ planned, issued })
    return {
      order: ordered[0]!.bomSeq,
      line: {
        itemId: first.itemId,
        itemCode: item?.code ?? first.itemId,
        itemName: item?.name ?? '',
        tracking: item?.tracking ?? 'NONE',
        baseUom: item?.baseUom ?? '',
        itemColourId: first.itemColourId,
        colourCode: colour?.code ?? null,
        colourName: colour?.name ?? null,
        planned: text(planned),
        issued: text(issued),
        toIssue: text(toIssue),
        over: text(Dec.max(ZERO, issued.minus(planned))),
        covered: toIssue.lte(0),
        rows,
        ...stockOf(input, first.itemId, first.itemColourId),
        atWorkOrder: holdingsOf(input, first.itemId, first.itemColourId),
      } satisfies PickLine,
    }
  })
  return lines.sort((a, b) => a.order - b.order || compare(a.line.itemCode, b.line.itemCode) || compare(a.line.colourCode ?? '', b.line.colourCode ?? '')).map((entry) => entry.line)
}

/** The site's stock of one material and colour: usable candidates (oldest first) and held lots with their reason. */
function stockOf(input: PickInput, itemId: string, itemColourId: string | null): Pick<PickLine, 'usable' | 'held'> {
  const candidates: PickCandidate[] = []
  const heldBy = new Map<string, { reason: UnusableReason; lotCode: string; onHand: Decimal; hides: Set<string> }>()
  let usableOnHand = ZERO
  for (const row of input.stock) {
    if (row.itemId !== itemId || row.itemColourId !== itemColourId || dec(row.onHand).lte(0)) continue
    const lot = row.lotId ? input.lots.get(row.lotId) : undefined
    const hide = row.hideId ? input.hides.get(row.hideId) : undefined
    const usability = usabilityOf(lot ?? null)
    if (!usability.usable) {
      const entry = heldBy.get(row.lotId!) ?? { reason: usability.reason, lotCode: lot?.code ?? '', onHand: ZERO, hides: new Set<string>() }
      entry.onHand = entry.onHand.plus(dec(row.onHand))
      if (row.hideId) entry.hides.add(row.hideId)
      heldBy.set(row.lotId!, entry)
      continue
    }
    if (hide && (hide.state === 'CONSUMED' || hide.state === 'SCRAPPED')) continue
    usableOnHand = usableOnHand.plus(dec(row.onHand))
    candidates.push({
      lotId: row.lotId,
      lotCode: lot?.code ?? null,
      hideId: row.hideId,
      hideCode: hide?.code ?? null,
      hideState: hide?.state ?? null,
      grade: hide?.grade ?? null,
      dyeBatch: lot?.dyeBatch ?? null,
      receivedAt: lot?.receivedAt ?? null,
      locationId: row.locationId,
      locationCode: row.locationCode,
      onHand: text(row.onHand),
    })
  }
  candidates.sort(oldestFirst)
  return {
    usable: { onHand: text(usableOnHand), candidates: candidates.slice(0, MAX_CANDIDATES), more: Math.max(0, candidates.length - MAX_CANDIDATES) },
    held: [...heldBy.entries()]
      .map(([lotId, entry]) => ({ reason: entry.reason, words: NOT_COUNTED_WORDS[entry.reason], lotId, lotCode: entry.lotCode, onHand: text(entry.onHand), hides: entry.hides.size }))
      .sort((a, b) => compare(a.lotCode, b.lotCode)),
  }
}

/** What the work order holds of one material and colour, per lot and hide, with what may come back. */
function holdingsOf(input: PickInput, itemId: string, itemColourId: string | null): PickHolding[] {
  return input.atWorkOrder
    .filter((row) => row.itemId === itemId && row.itemColourId === itemColourId && dec(row.quantity).gt(0))
    .map((row) => {
      const cut = row.hideId ? dec(input.cuts.get(row.hideId) ?? '0') : ZERO
      return {
        lotId: row.lotId,
        lotCode: row.lotId ? (input.lots.get(row.lotId)?.code ?? null) : null,
        hideId: row.hideId,
        hideCode: row.hideId ? (input.hides.get(row.hideId)?.code ?? null) : null,
        quantity: text(row.quantity),
        cut: text(cut),
        returnable: text(Dec.max(ZERO, dec(row.quantity).minus(cut))),
      }
    })
    .sort((a, b) => compare(a.lotCode ?? '', b.lotCode ?? '') || compare(a.hideCode ?? '', b.hideCode ?? ''))
}
