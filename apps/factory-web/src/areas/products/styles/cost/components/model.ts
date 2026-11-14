import type { ComponentsView } from '../versions/api'
import type { Phrase } from '../versions/model'

/**
 * The cost sheet's W2b steps on the style's Cost tab (B-W2b-430 on B-W2b-418's components; design products.styles › Cost ›
 * Cost sheet: "Subcontract (W2b)", "Packaging (W2b)", "Freight and duties on materials (W2b)", "Commissions (W2b)"), pure:
 * which lines a size takes (every-size lines and its own), each step's lines and amount, a line in our words — never the
 * API's English: a line's label is a record's name (a material, an operation, a workshop, a packaging type) or a person's
 * own words (a typed line); the few labels the components compose in English (an outside operation "… at …", the transport
 * out and back, "Freight on …", a carton's share) are read back into their names and said here — and "How is this made?" from
 * the line's figures. Words: the `cost-sheets` catalogue (`steps.*`, `stepCat.*`, `stepLine.*`, `stepHow.*`).
 */

export type ComponentLine = ComponentsView['lines'][number]
export type SheetCategory = ComponentLine['category']

/** The W2b steps of the sheet, in the design's order; freight and duty are one step. */
export const W2B_STEPS = [
  { id: 'subcontract', categories: ['SUBCONTRACT'] },
  { id: 'packaging', categories: ['PACKAGING'] },
  { id: 'freight', categories: ['FREIGHT', 'DUTY'] },
  { id: 'commission', categories: ['COMMISSION'] },
] as const satisfies ReadonlyArray<{ id: string; categories: readonly SheetCategory[] }>
export type W2bStep = (typeof W2B_STEPS)[number]['id']

/** The lines a size takes: every-size lines (size null) and its own. */
export function linesForSize<L extends Pick<ComponentLine, 'size'>>(lines: readonly L[], size: string): L[] {
  return lines.filter((line) => line.size === null || line.size === size)
}

/** One step for a size: its lines and its amount (null without the cost grain, or while a line of it has no figure). */
export function stepOf(lines: readonly ComponentLine[], size: string, categories: readonly SheetCategory[]): { lines: ComponentLine[]; amount: string | null } {
  const own = linesForSize(lines, size).filter((line) => (categories as readonly string[]).includes(line.category))
  if (own.length === 0) return { lines: own, amount: '0' }
  let total = 0
  for (const line of own) {
    if (line.cost === undefined || line.cost === null) return { lines: own, amount: null }
    total += Number(line.cost)
  }
  return { lines: own, amount: total.toFixed(6) }
}

/** A size's total of every step (the components' split); null without the grain or while it misses an input. */
export function sizeTotal(view: Pick<ComponentsView, 'split'>, size: string): { total: string | null; knownTotal: string | null; complete: boolean } {
  const cell = view.split.find((entry) => entry.size === size)
  if (!cell) return { total: null, knownTotal: null, complete: false }
  return { total: cell.total ?? null, knownTotal: cell.knownTotal ?? null, complete: cell.complete }
}

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** An uplift's kind of material as the components name it ("protector materials" → PROTECTOR), or null. */
const KIND_OF = /^(.+) materials$/

/** A line in our words (see the module comment); `kindWords` names a kind of material in the page's language. */
export function lineWords(line: Pick<ComponentLine, 'category' | 'label'>, kindWords: (kind: string) => string): Phrase {
  const label = (line.label ?? '').trim()
  if (line.category === 'SUBCONTRACT') {
    const back = /^Transport back from (.+)$/.exec(label)
    if (back) return phrase('stepLine.transportBack', { workshop: back[1]! })
    const out = /^Transport to (.+)$/.exec(label)
    if (out) return phrase('stepLine.transportOut', { workshop: out[1]! })
    const outside = /^(.+) at (.+)$/.exec(label)
    if (outside) return phrase('stepLine.outside', { operation: outside[1]!, workshop: outside[2]! })
  }
  if (line.category === 'FREIGHT' || line.category === 'DUTY') {
    const match = /^(Freight|Insurance|Duty) on (.+)$/.exec(label)
    if (match) {
      const what = match[1]!.toLowerCase()
      if (match[2] === 'the material') return phrase(`stepLine.${what}OnMaterial`)
      const kind = KIND_OF.exec(match[2]!)
      if (kind) return phrase(`stepLine.${what}OnKind`, { kind: kindWords(kind[1]!.toUpperCase()) })
    }
  }
  if (line.category === 'PACKAGING') {
    const match = /^(.+): one garment's share$/.exec(label)
    if (match) return phrase('stepLine.cartonShare', { name: match[1]! })
  }
  if (label === '') return phrase('stepLine.unnamed')
  return phrase('stepLine.named', { label })
}

/** The garments a carton's share was divided by, from the line's note (the components write "… ÷ N garments."), or null. */
export function cartonPiecesOf(line: Pick<ComponentLine, 'note'>): number | null {
  const match = /÷ (\d+) garments/.exec(line.note ?? '')
  return match ? Number(match[1]) : null
}

/**
 * "How is this made?" for a line: a percent of its base, a piece rate, a carton's share, the landed cost read, or quantity ×
 * unit cost. `money` writes a cost (null without the grain): then only the quantities and percents are said.
 */
export function howWords(line: Pick<ComponentLine, 'source' | 'pct' | 'quantity' | 'unitCost' | 'cost' | 'note' | 'category'>, money: (value: string | null | undefined) => string | null, number: (value: string) => string): Phrase {
  const cost = money(line.cost)
  const unit = money(line.unitCost)
  if (line.pct !== undefined && line.pct !== null) {
    if (line.source === 'LANDED_COST') return phrase(cost ? 'stepHow.landed' : 'stepHow.landedNoGrain', { pct: number(line.pct), amount: cost ?? '' })
    return phrase(cost ? 'stepHow.percent' : 'stepHow.percentNoGrain', { pct: number(line.pct), amount: cost ?? '' })
  }
  if (line.source === 'PIECE_RATE') return phrase(cost ? 'stepHow.pieceRate' : 'stepHow.pieceRateNoGrain', { amount: cost ?? '' })
  const pieces = line.category === 'PACKAGING' ? cartonPiecesOf(line) : null
  if (pieces !== null) return phrase(cost ? 'stepHow.carton' : 'stepHow.cartonNoGrain', { pieces, amount: cost ?? '' })
  if (!cost || !unit) return phrase('stepHow.quantityOnly', { quantity: number(line.quantity) })
  return phrase('stepHow.plain', { quantity: number(line.quantity), unit, amount: cost })
}

/** The steps that have lines or are asked for: a step without a line says "none on this sheet" (never 0 as a figure). */
export function stepsFor(lines: readonly ComponentLine[], size: string): Array<{ id: W2bStep; lines: ComponentLine[]; amount: string | null }> {
  return W2B_STEPS.map((step) => ({ id: step.id, ...stepOf(lines, size, step.categories) }))
}

/** The size the card opens on: the one asked (W1's cost cell) when the components cost it, else the base size, else the first. */
export function sizeInView(view: Pick<ComponentsView, 'sizes' | 'style'>, asked: string | null): string | null {
  if (asked && view.sizes.includes(asked)) return asked
  if (view.style.baseSize && view.sizes.includes(view.style.baseSize)) return view.style.baseSize
  return view.sizes[0] ?? null
}
