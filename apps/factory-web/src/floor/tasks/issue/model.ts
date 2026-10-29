import type { ScanRead } from '../../scan/scan-model'

/**
 * Pick & issue on the floor (SCR-093; design floor.pick; SCM-215, SCM-194; apps/factory-api modules/inventory/issue), as
 * rules without a screen or a network: what a scanned code is on this work order's pick list (a hide is issued whole by
 * the scan; a lot or an untracked material asks its quantity, defaulted to what the line still needs), the quantity
 * pad's bounds (never more than is on hand, never more than the line still needs: an over-issue is the office's), the
 * words of the last issue and of the undo strip. Quantities are the API's decimal strings in the item's base unit; they
 * are only shown and compared here, never valued (no money on the floor). Pure, so the tests hold them.
 */

export interface PickWorkOrderRow {
  readonly id: string
  readonly number: string
  readonly batchNumber: string | null
  readonly status: string
  readonly dueDate: string | null
  readonly style: { readonly code: string; readonly name: string }
  readonly pieces: number
  readonly colourways: readonly string[]
}

export interface PickCandidate {
  readonly lotId: string | null
  readonly lotCode: string | null
  readonly hideId: string | null
  readonly hideCode: string | null
  readonly hideState: string | null
  readonly grade: string | null
  readonly locationCode: string
  readonly onHand: string
}

export interface PickHeld {
  readonly reason: string
  readonly lotCode: string
  readonly onHand: string
  readonly hides: number
}

export interface PickLine {
  /** itemId + colour: one line per material and colour. */
  readonly key: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly itemCode: string
  readonly itemName: string
  readonly colourCode: string | null
  readonly colourName: string | null
  /** NONE, LOT or HIDE (factory-domain inventory/ledger ITEM_TRACKINGS). */
  readonly tracking: string
  readonly baseUom: string
  readonly planned: string
  readonly issued: string
  readonly toIssue: string
  readonly covered: boolean
  /** Usable stock of the site: how much, oldest first (at most 50 rows; `more` counts the rest). */
  readonly usable: { readonly onHand: string; readonly candidates: readonly PickCandidate[]; readonly more: number }
  readonly held: readonly PickHeld[]
  /** What the work order holds per lot and hide (issued minus returned). */
  readonly atWorkOrder: readonly { readonly lotId: string | null; readonly lotCode: string | null; readonly hideId: string | null; readonly hideCode: string | null; readonly quantity: string }[]
}

export interface PickUndo {
  readonly issueId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
  readonly baseQuantity: string
  readonly occurredAt: string
}

export interface PickList {
  readonly workOrder: {
    readonly id: string
    readonly number: string
    readonly batchNumber: string | null
    readonly status: string
    readonly dueDate: string | null
    /** RELEASED or IN_PROGRESS: stock may be issued to it. */
    readonly issuable: boolean
    readonly style: { readonly code: string; readonly name: string }
  }
  readonly lines: readonly PickLine[]
  /** The person's own last issue to this work order, while it may be undone. */
  readonly undo: PickUndo | null
}

// ---- numbers -----------------------------------------------------------------------------------------------------------

/** A decimal string as a number for showing and comparing (never valued). */
export const num = (value: string | number | null | undefined): number => {
  const n = typeof value === 'number' ? value : Number(value ?? '')
  return Number.isFinite(n) ? n : 0
}

/** Count units are whole; length, area, mass and volume take two decimals on the pad. */
const COUNT_UOMS = new Set(['PCS', 'PAIR', 'SET', 'HIDE', 'SIDE', 'ROLL', 'CONE', 'BOX'])
export const decimalsOf = (uom: string): number => (COUNT_UOMS.has(uom) ? 0 : 2)

/** A pad number as the API's decimal string (at most four decimals). */
export function quantityText(value: number, decimals: number): string {
  const places = Math.max(0, Math.min(4, decimals))
  return value.toFixed(places)
}

// ---- what a scanned code is on this pick list ------------------------------------------------------------------------------

export type ScannedStock =
  /** A hide: issued whole by the scan (0 taps). */
  | { readonly kind: 'hide'; readonly code: string; readonly line: PickLine | null }
  /** A lot or an untracked material: its quantity first (the pad, defaulted). */
  | { readonly kind: 'quantity'; readonly code: string; readonly line: PickLine; readonly onHand: number; readonly label: string }
  /** Nothing the pick list knows: the API decides (a hide, a lot or a material it has, or a refusal in words). */
  | { readonly kind: 'ask'; readonly code: string }

const same = (a: string | null | undefined, b: string) => (a ?? '').trim().toUpperCase() === b.trim().toUpperCase()

/**
 * What a code read on the pick list is. A hide label (its scan id) or a hide among the candidates is issued at once. A
 * lot among the candidates, or a line's untracked material by its item code, asks its quantity. A held lot or anything
 * else goes to the API as scanned: it issues what it may and refuses the rest with the rule's words.
 */
export function stockOfScan(list: PickList, read: ScanRead): ScannedStock {
  const code = read.code
  if (read.kind === 'label' && read.type === 'hide') return { kind: 'hide', code, line: list.lines.find((line) => line.usable.candidates.some((row) => same(row.hideCode, code))) ?? null }
  for (const line of list.lines) {
    if (line.usable.candidates.some((row) => same(row.hideCode, code))) return { kind: 'hide', code, line }
    const lot = line.usable.candidates.filter((row) => row.hideCode === null && same(row.lotCode, code))
    if (lot.length > 0) return { kind: 'quantity', code: lot[0]!.lotCode ?? code, line, onHand: lot.reduce((sum, row) => sum + num(row.onHand), 0), label: lot[0]!.lotCode ?? code }
    if (line.tracking === 'NONE' && same(line.itemCode, code)) return { kind: 'quantity', code: line.itemCode, line, onHand: num(line.usable.onHand), label: line.itemCode }
  }
  return { kind: 'ask', code }
}

// ---- the quantity pad -------------------------------------------------------------------------------------------------------

export interface PadBounds {
  readonly min: number
  readonly max: number
  readonly decimals: number
  /** What the work order still needs, up to what is on hand (the default). */
  readonly suggested: number
  /** The line has all it needs: the floor issues no more (an over-issue is the office's, with a reason). */
  readonly covered: boolean
}

export function padBounds(line: PickLine, onHand: number): PadBounds {
  const decimals = decimalsOf(line.baseUom)
  const step = 1 / 10 ** decimals
  const toIssue = num(line.toIssue)
  const max = Math.max(0, Math.min(onHand, toIssue))
  return { min: max > 0 ? step : 0, max, decimals, suggested: max, covered: toIssue <= 0 }
}

// ---- the pick list's progress and words ------------------------------------------------------------------------------------

/** "3 of 5 covered": the lines with all they need. */
export function coveredCount(list: PickList): { covered: number; total: number } {
  return { covered: list.lines.filter((line) => line.covered).length, total: list.lines.length }
}

/** The line's name: "Pelle bovina · NERO". */
export const lineName = (line: Pick<PickLine, 'itemName' | 'colourCode' | 'colourName'>): string => {
  const colour = line.colourName ?? line.colourCode
  return colour ? `${line.itemName} · ${colour}` : line.itemName
}

/** The stock of the undo strip: its hide or lot code (else the material's), with the line it went to. */
export function undoStock(list: PickList): { code: string; line: PickLine | null; quantity: number } | null {
  const undo = list.undo
  if (!undo) return null
  const line = list.lines.find((entry) => entry.itemId === undo.itemId && entry.itemColourId === undo.itemColourId) ?? null
  const held = line?.atWorkOrder.find((row) => (undo.hideId ? row.hideId === undo.hideId : undo.lotId !== null && row.lotId === undo.lotId)) ?? null
  const code = (undo.hideId ? held?.hideCode : held?.lotCode) ?? line?.itemCode ?? '—'
  return { code, line, quantity: num(undo.baseQuantity) }
}

/** The pick list after an issue's answer (the line's planned, issued and still to issue), until it is read again. */
export function withLine(list: PickList, key: string, after: { planned: string; issued: string; toIssue: string }): PickList {
  return {
    ...list,
    lines: list.lines.map((line) => (line.key === key ? { ...line, ...after, covered: num(after.toIssue) <= 0 } : line)),
  }
}

/** The refusal codes the screen has its own words for (factory-domain inventory/issue/rules REFUSALS; the rest: the API's). */
export const ISSUE_REFUSAL_WORDS = [
  'WORK_ORDER_NOT_OPEN',
  'NOT_IN_WORK_ORDER',
  'OTHER_COLOUR',
  'CR_VI_PENDING',
  'CR_VI_FAILED',
  'QUALITY_HOLD',
  'BLOCKED',
  'REJECTED',
  'HIDE_USED_UP',
  'NOTHING_ON_HAND',
  'MORE_THAN_ON_HAND',
  'OVER_ISSUE',
  'NOT_LAST_ACTION',
  'REVERSED_ALREADY',
] as const

/**
 * ALREADY_ISSUED names the work order and the time it went to (no person): the API's own sentence is shown for it (it
 * carries facts the screen has no other way to know). Held stock's reasons (planning/usable UNUSABLE_REASONS).
 */
export const HELD_REASONS = ['CR_VI_PENDING', 'CR_VI_FAILED', 'QUALITY_HOLD', 'BLOCKED', 'REJECTED'] as const

/** The units the screen names in its own words (`unit.<UOM>`); any other shows its code. */
export const UNIT_KEYS = ['PCS', 'PAIR', 'SET', 'M', 'CM', 'MM', 'M2', 'DM2', 'FT2', 'KG', 'G', 'L', 'HIDE', 'SIDE', 'ROLL', 'CONE', 'BOX'] as const
