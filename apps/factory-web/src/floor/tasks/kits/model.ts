import type { KitBundle, KitLine, KitOrder, ReceiveBody, SendBody, TransportBy } from './api'

/**
 * Subcontract kits' rules without a screen (SCR-181; design floor.kits; SCM-140, SCM-142): what a kit still has to send
 * (the planned lines, each from the place that holds it; the bundles of the cells not sent yet), what a scanned label
 * ticks, why Send is held ("Kit not complete: 2 bundles missing."), the send's body with its DDT; then on the way back
 * what a scanned bundle brings (its garments still out, good, with no tap), a rejection with its reason, the unused
 * material returned, and the receipt's body per operation and bundle. Pure, so the tests hold them.
 */

export type KitsStage = 'mode' | 'pick' | 'kit' | 'ddt' | 'sent' | 'back' | 'received' | 'noPermission'

const key = (value: string | null | undefined) => (value ?? '').trim().toUpperCase()
const num = (value: string | null | undefined) => {
  const parsed = Number(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

// ---- send ---------------------------------------------------------------------------------------------------------------

/** What the screen ticked: planned lines with the place each leaves from (its index in `sources`), and bundles. */
export interface KitDraft {
  readonly lines: Readonly<Record<string, number>>
  readonly bundles: readonly string[]
}

export const emptyKit = (): KitDraft => ({ lines: {}, bundles: [] })

export const plannedLines = (order: KitOrder): KitLine[] => order.kitLines.filter((line) => line.status === 'PLANNED')
/** Bundles still to send: of the order's cells, not named by an earlier send. */
export const bundlesToSend = (order: KitOrder): KitBundle[] => order.bundles.filter((bundle) => !bundle.sent)

/** The place a planned line leaves from by default: the first that holds all of it, else the first that holds some. */
export function defaultSource(line: KitLine): number | null {
  if (line.sources.length === 0) return null
  const covers = line.sources.findIndex((source) => source.covers)
  return covers >= 0 ? covers : 0
}

/** Tick or untick a planned line (ticked: from its default place, or the one asked). */
export function toggleLine(draft: KitDraft, line: KitLine, source: number | null = null): KitDraft {
  const lines = { ...draft.lines }
  if (source === null && line.id in lines) delete lines[line.id]
  else {
    const at = source ?? defaultSource(line)
    if (at === null) return draft
    lines[line.id] = at
  }
  return { ...draft, lines }
}

export function toggleBundle(draft: KitDraft, bundleId: string): KitDraft {
  return draft.bundles.includes(bundleId) ? { ...draft, bundles: draft.bundles.filter((id) => id !== bundleId) } : { ...draft, bundles: [...draft.bundles, bundleId] }
}

/** Everything the kit still lists, ticked. */
export function tickAll(order: KitOrder): KitDraft {
  const lines: Record<string, number> = {}
  for (const line of plannedLines(order)) {
    const at = defaultSource(line)
    if (at !== null) lines[line.id] = at
  }
  return { lines, bundles: bundlesToSend(order).map((bundle) => bundle.id) }
}

/** A bundle's ticket (its code now, or an earlier one of its tickets). */
const bundleNamed = (bundles: readonly KitBundle[], code: string) => bundles.find((bundle) => key(bundle.code) === key(code) || bundle.replacedCodes.some((old) => key(old) === key(code)))

export type KitScan =
  | { readonly kind: 'bundle'; readonly bundleId: string }
  | { readonly kind: 'line'; readonly lineId: string; readonly source: number }
  | { readonly kind: 'sentBefore'; readonly code: string }
  | { readonly kind: 'none' }

/** What a scanned label ticks: a bundle's ticket, a lot's or hide's code (that place's stock), or the material's code. */
export function scanKit(order: KitOrder, code: string): KitScan {
  const bundle = bundleNamed(order.bundles, code)
  if (bundle) return bundle.sent ? { kind: 'sentBefore', code: bundle.code } : { kind: 'bundle', bundleId: bundle.id }
  for (const line of plannedLines(order)) {
    const source = line.sources.findIndex((option) => key(option.lot?.code) === key(code) || key(option.hide?.code) === key(code))
    if (source >= 0) return { kind: 'line', lineId: line.id, source }
  }
  const byItem = plannedLines(order).find((line) => key(line.item.code) === key(code) && defaultSource(line) !== null)
  if (byItem) return { kind: 'line', lineId: byItem.id, source: defaultSource(byItem)! }
  return { kind: 'none' }
}

/** What the kit still misses: planned lines and bundles not ticked, and lines no place of the site holds. */
export function missingOf(order: KitOrder, draft: KitDraft): { lines: number; bundles: number; noStock: number } {
  const planned = plannedLines(order)
  return {
    lines: planned.filter((line) => !(line.id in draft.lines) && line.sources.length > 0).length,
    bundles: bundlesToSend(order).filter((bundle) => !draft.bundles.includes(bundle.id)).length,
    noStock: planned.filter((line) => line.sources.length === 0).length,
  }
}

/** Why the kit cannot go to its DDT yet, as a code the screen words (null: it may). */
export type KitHeld = 'state' | 'nothing' | 'noStock' | 'missing' | null
export function kitHeld(order: KitOrder, draft: KitDraft): KitHeld {
  if (order.actions.send !== null) return 'state'
  if (plannedLines(order).length === 0 && bundlesToSend(order).length === 0) return 'nothing'
  const missing = missingOf(order, draft)
  if (missing.noStock > 0) return 'noStock'
  if (missing.lines > 0 || missing.bundles > 0) return 'missing'
  return null
}

/** The DDT's facts the floor gives (the rest is the office's: the workshop's address, its number, the lines). */
export interface DdtDraft {
  readonly transportBy: TransportBy | null
  readonly packages: number
  readonly grossWeightKg: number | null
  readonly appearance: Appearance
}

/** The goods' appearance as printed on the DDT (aspetto esteriore dei beni, DPR 472/1996): the document's own words. */
export const APPEARANCES = ['BOXES', 'BAGS', 'PALLET', 'LOOSE'] as const
export type Appearance = (typeof APPEARANCES)[number]
const APPEARANCE_PRINTED: Record<Appearance, string> = { BOXES: 'Scatole di cartone', BAGS: 'Sacchi', PALLET: 'Bancale', LOOSE: 'Sfuso' }

export const emptyDdt = (): DdtDraft => ({ transportBy: null, packages: 1, grossWeightKg: null, appearance: 'BOXES' })

export type DdtHeld = 'transport' | 'weight' | null
export function ddtHeld(ddt: DdtDraft): DdtHeld {
  if (ddt.transportBy === null) return 'transport'
  if (ddt.grossWeightKg === null || !(ddt.grossWeightKg > 0)) return 'weight'
  return null
}

/** The ONE send's body: the ticked lines from their places, the ticked bundles, the DDT. */
export function sendBody(order: KitOrder, draft: KitDraft, ddt: DdtDraft): SendBody {
  const lines = plannedLines(order).flatMap((line) => {
    const at = draft.lines[line.id]
    const source = at === undefined ? undefined : line.sources[at]
    return source ? [{ lineId: line.id, fromLocationId: source.location.id, lotId: source.lot?.id ?? null, hideId: source.hide?.id ?? null }] : []
  })
  return {
    version: order.version,
    lines,
    bundles: bundlesToSend(order)
      .filter((bundle) => draft.bundles.includes(bundle.id))
      .map((bundle) => ({ bundleId: bundle.id })),
    ddt: { transportBy: ddt.transportBy ?? 'SENDER', packages: Math.max(1, Math.round(ddt.packages)), grossWeightKg: (ddt.grossWeightKg ?? 0).toFixed(3), appearance: APPEARANCE_PRINTED[ddt.appearance] },
  }
}

// ---- receive back ---------------------------------------------------------------------------------------------------------

/** What came back of a bundle on this receipt: good (a scan), rejected (defective) or scrapped at the workshop, and why. */
export interface BackEntry {
  readonly good: number
  readonly defective: number
  readonly scrapped: number
  readonly reason: string | null
}

export interface BackDraft {
  readonly entries: Readonly<Record<string, BackEntry>>
  /** Kit line id → the quantity of unused material back (base unit) and where it goes. */
  readonly returns: Readonly<Record<string, { readonly quantity: number; readonly toLocationId: string }>>
  /** The workshop's delivery note number. */
  readonly ddtNumber: string | null
}

export const emptyBack = (): BackDraft => ({ entries: {}, returns: {}, ddtNumber: null })

/** Bundles that went out on this order with whole garments (a part's bundle comes back inside its garments). */
export const bundlesOut = (order: KitOrder): KitBundle[] => order.bundles.filter((bundle) => bundle.sent && bundle.part === null)

/** The operations a bundle passes at the workshop: those that send its cell (an operation with no cells sends every one). */
export const operationsOf = (order: KitOrder, bundle: KitBundle) => order.operations.filter((operation) => operation.cells.length === 0 || operation.cells.includes(bundle.workOrderSizeId))

/** What of a bundle came back before (good, rejected, scrapped): the most any of its operations recorded. */
export function backBefore(order: KitOrder, bundle: KitBundle): { good: number; defective: number; scrapped: number } {
  const ids = new Set(operationsOf(order, bundle).map((operation) => operation.id))
  let best = { good: 0, defective: 0, scrapped: 0 }
  for (const row of bundle.back) {
    if (!ids.has(row.operationId)) continue
    if (row.good + row.defective + row.scrapped > best.good + best.defective + best.scrapped) best = { good: row.good, defective: row.defective, scrapped: row.scrapped }
  }
  return best
}

/** The garments of a bundle still at the workshop (before this receipt). */
export function outOf(order: KitOrder, bundle: KitBundle): number {
  const before = backBefore(order, bundle)
  return Math.max(0, bundle.quantity - before.good - before.defective - before.scrapped)
}

export const entryTotal = (entry: BackEntry | undefined): number => (entry ? entry.good + entry.defective + entry.scrapped : 0)

export type BackScan = { readonly kind: 'bundle'; readonly bundleId: string } | { readonly kind: 'notOut'; readonly code: string } | { readonly kind: 'allBack'; readonly code: string } | { readonly kind: 'none' }

/** A scanned bundle ticket on the way back: one that went out and still has garments out. */
export function scanBack(order: KitOrder, draft: BackDraft, code: string): BackScan {
  const bundle = bundleNamed(order.bundles, code)
  if (!bundle) return { kind: 'none' }
  if (!bundle.sent || bundle.part !== null) return { kind: 'notOut', code: bundle.code }
  if (outOf(order, bundle) - entryTotal(draft.entries[bundle.id]) <= 0) return { kind: 'allBack', code: bundle.code }
  return { kind: 'bundle', bundleId: bundle.id }
}

/** A scan brings the bundle's garments still out back good (no tap). */
export function bringBack(order: KitOrder, draft: BackDraft, bundleId: string): BackDraft {
  const bundle = order.bundles.find((entry) => entry.id === bundleId)
  if (!bundle) return draft
  const before = draft.entries[bundleId]
  const left = outOf(order, bundle) - entryTotal(before)
  if (left <= 0) return draft
  return { ...draft, entries: { ...draft.entries, [bundleId]: { good: (before?.good ?? 0) + left, defective: before?.defective ?? 0, scrapped: before?.scrapped ?? 0, reason: before?.reason ?? null } } }
}

/** Takes a bundle off this receipt. */
export function dropBack(draft: BackDraft, bundleId: string): BackDraft {
  const entries = { ...draft.entries }
  delete entries[bundleId]
  return { ...draft, entries }
}

export type RejectKind = 'defective' | 'scrapped'

/** Of the garments of a bundle on this receipt, `count` are rejected (or scrapped at the workshop) with a reason. */
export function rejectBack(order: KitOrder, draft: BackDraft, bundleId: string, count: number, kind: RejectKind, reason: string | null): BackDraft {
  const bundle = order.bundles.find((entry) => entry.id === bundleId)
  if (!bundle) return draft
  const total = Math.max(entryTotal(draft.entries[bundleId]), outOf(order, bundle))
  const rejected = Math.min(Math.max(0, Math.round(count)), total)
  return {
    ...draft,
    entries: {
      ...draft.entries,
      [bundleId]: { good: total - rejected, defective: kind === 'defective' ? rejected : 0, scrapped: kind === 'scrapped' ? rejected : 0, reason: rejected > 0 ? reason : null },
    },
  }
}

/** Unused material back: a quantity (base unit, at most what is at the workshop) to a place (default where it left from). */
export function setReturn(draft: BackDraft, line: KitLine, quantity: number | null, toLocationId?: string | null): BackDraft {
  const returns = { ...draft.returns }
  const most = num(line.atWorkshop)
  const to = toLocationId ?? returns[line.id]?.toLocationId ?? line.from?.id ?? null
  if (quantity === null || !(quantity > 0) || to === null) delete returns[line.id]
  else returns[line.id] = { quantity: Math.min(quantity, most), toLocationId: to }
  return { ...draft, returns }
}

export const materialAtWorkshop = (order: KitOrder): KitLine[] => order.kitLines.filter((line) => line.status === 'SENT' && num(line.atWorkshop) > 0)

export type BackHeld = 'state' | 'nothing' | 'reason' | null
/** Why Finish receipt is held, as a code the screen words (null: it may go). */
export function backHeld(order: KitOrder, draft: BackDraft, reasonsKnown: boolean): BackHeld {
  const entries = Object.values(draft.entries).filter((entry) => entryTotal(entry) > 0)
  if (order.actions.receive !== null && Object.keys(draft.returns).length === 0) return 'state'
  if (entries.length === 0 && Object.keys(draft.returns).length === 0) return 'nothing'
  if (reasonsKnown && entries.some((entry) => entry.defective + entry.scrapped > 0 && !entry.reason)) return 'reason'
  return null
}

/** The ONE receipt's body: each bundle once per operation it passes, the material back, the workshop's note number. */
export function receiveBody(order: KitOrder, draft: BackDraft): ReceiveBody {
  const lines: ReceiveBody['lines'] = []
  for (const bundle of order.bundles) {
    const entry = draft.entries[bundle.id]
    if (!entry || entryTotal(entry) === 0) continue
    for (const operation of operationsOf(order, bundle)) {
      lines.push({ operationId: operation.id, bundleId: bundle.id, good: entry.good, defective: entry.defective, scrapped: entry.scrapped, ...(entry.reason ? { reason: entry.reason } : {}) })
    }
  }
  const returns = order.kitLines.flatMap((line) => {
    const back = draft.returns[line.id]
    if (!back) return []
    return [{ itemId: line.item.id, itemColourId: line.colour?.id ?? null, lotId: line.lot?.id ?? null, hideId: line.hide?.id ?? null, quantity: back.quantity.toFixed(4), uom: line.item.baseUom, toLocationId: back.toLocationId }]
  })
  return { version: order.version, lines, returns, ...(draft.ddtNumber ? { supplierDdt: { number: draft.ddtNumber } } : {}) }
}

/** The receipt's totals as the screen says them before it is sent. */
export function backTotals(draft: BackDraft): { good: number; rejected: number; scrapped: number; bundles: number } {
  const entries = Object.values(draft.entries).filter((entry) => entryTotal(entry) > 0)
  return { good: entries.reduce((sum, entry) => sum + entry.good, 0), rejected: entries.reduce((sum, entry) => sum + entry.defective, 0), scrapped: entries.reduce((sum, entry) => sum + entry.scrapped, 0), bundles: entries.length }
}
