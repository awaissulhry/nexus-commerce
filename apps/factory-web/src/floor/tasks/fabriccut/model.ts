import type { LabelLayout, LabelPrintStatus } from '@nexus/ui/components/LabelPreview/index'
import type { LabelType, ScanRead } from '../../scan/scan-model'
import type { FabricUsed, LayStatus, LayView, PrintJob, TicketCard, TicketStatus, Trolley } from './api'

/**
 * SCR-182's rules without a screen (B-W2b-121; design floor.fabriccut). Pure, so the tests hold them: where a ticket stands at the
 * table, the roll's report and what it sends, the count at both ends, the fabric used against the estimate, the trolley's label,
 * what a kept (queued) write does to the lay on screen, the refusal codes the screen has words for. No person, no money.
 */

// ---- the refusals the screen words itself (never the API's English) -----------------------------------------------------------

/**
 * Every rule code the routes of this screen answer (factory-domain production lays LAY_REFUSALS, cutorders TICKET_REFUSALS,
 * PLY_REFUSALS, ALLOCATION_REFUSALS, rework RECUT_REFUSALS, cutissue SECONDARY_REFUSALS and TROLLEY_REFUSALS; the floor's
 * FLOOR_NOT_READY; inventory's issue refusals at the fabric-used confirmation). The test holds the domain lists against it.
 */
export const KNOWN_REFUSALS = [
  // the lay at the table (B-W2b-116)
  'NOT_FABRIC',
  'CUT_ORDER_NOT_AT_TABLE',
  'TICKET_NOT_STARTED',
  'LAY_NOT_OPEN',
  'LAY_NOT_SPREAD',
  'LAY_FULL',
  'ROLL_SHORT',
  'ROLL_NOT_IN_LAY',
  'NOT_LAST_ROLL',
  'PLY_TOO_SHORT',
  'NOTHING_SPREAD',
  'PLIES_DIFFER',
  'COUNT_NOT_SPREAD',
  'LAY_NOT_CUT',
  'CONSUMPTION_CLOSED',
  // a roll's checks (B-W2b-112)
  'ROLL_NOT_IN_STOCK',
  'ROLL_OTHER_MATERIAL',
  'ROLL_TOO_NARROW',
  'ROLL_REJECTED',
  'LOT_HELD',
  'LOT_NOT_USABLE',
  'MIXED_SHADE',
  'MIXED_SHRINKAGE',
  'LAY_NOT_PLANNED',
  'ROLL_TWICE',
  // tickets and ply stickers (B-W2b-112)
  'TICKET_VOID',
  'TICKET_DONE',
  'TICKET_STARTED',
  'TICKET_IS_RECUT',
  'CUT_ORDER_NOT_RELEASED',
  'PLIES_NOT_COUNTED',
  'PLIES_BEYOND_COUNT',
  'PLIES_NUMBERED',
  'NO_PARTS',
  'RUN_TOO_BIG',
  'RUN_VOID',
  'WORK_ORDER_ON_HOLD',
  'WORK_ORDER_NOT_OPEN',
  'FLOOR_NOT_READY',
  // the fabric issued at the confirmation (inventory)
  'OVER_ISSUE',
  'QUALITY_HOLD',
  'RESERVED_FOR_OTHER',
  'LENGTH_BEYOND_LEFT',
  // recut tickets (B-W2b-117)
  'BUNDLE_NOT_ACTIVE',
  'BUNDLE_NEEDED',
  'NOT_OF_CELL',
  'MORE_THAN_BUNDLE',
  'NOT_A_PART',
  'NO_SOURCE',
  'LOT_OTHER_MATERIAL',
  'LOT_NOT_SAME_SHADE',
  'REPLACEMENT_NOT_RECUT',
  'REPLACEMENT_NOT_OPEN',
  'REPLACEMENT_HAS_TICKET',
  'REPLACEMENT_OTHER_CELL',
  'REPLACEMENT_OTHER_PART',
  'MORE_THAN_REPLACEMENT',
  'TICKET_IS_CUT',
  'BUNDLE_VOID',
  // secondary processes (B-W2b-117)
  'KIND_OPEN_ALREADY',
  'ON_A_TROLLEY',
  'NOT_A_WORK_CENTRE',
  'WORK_CENTRE_OUTSIDE',
  'WRONG_STATE',
  'SUBCONTRACT_NEEDED',
  'SUBCONTRACT_NOT_SENDABLE',
  'OUTSIDE_FROM_OFFICE',
  // trolleys (B-W2b-117)
  'NOT_A_TROLLEY',
  'TROLLEY_SENT',
  'NO_OPEN_TROLLEY',
  'TROLLEY_NOT_LOADING',
  'TROLLEY_NOT_SENT',
  'TROLLEY_EMPTY',
  'TROLLEY_FULL',
  'LINE_NEEDED',
  'LINE_NOT_ACTIVE',
  'PROCESS_PENDING',
  'ON_THIS_TROLLEY',
  'ON_ANOTHER_TROLLEY',
  'NOT_ON_TROLLEY',
  'OTHER_LINE',
] as const

const KNOWN = new Set<string>(KNOWN_REFUSALS)
export const isKnownRefusal = (code: string): boolean => KNOWN.has(code)

/** The warnings a write may answer with (201 + `warnings`), worded by the screen. */
export const KNOWN_WARNINGS = ['END_DIFFERS', 'WIDTH_UNKNOWN', 'SHRINKAGE_UNKNOWN', 'SHADE_UNKNOWN', 'LOT_NOT_RELEASED', 'SHADES_ACROSS_LAYS', 'SHRINKAGE_ACROSS_LAYS', 'PLANNED_ON_OTHER_LINE'] as const
const WARNINGS = new Set<string>(KNOWN_WARNINGS)
export const isKnownWarning = (code: string): boolean => WARNINGS.has(code)

// ---- where a ticket stands at the table (design floor.fabriccut status "Step: Spread / Check / Cut / Issue") --------------------

/** The table's steps of one lay, in order. */
export const LAY_STEPS = ['start', 'spread', 'check', 'cut', 'stickers', 'fabric'] as const
export type LayStep = (typeof LAY_STEPS)[number]

/**
 * The step a ticket's lay is at: an OPEN ticket starts (the start scan), a STARTED one spreads until both ends are counted
 * (CHECKED: the cut), a DONE one (its lay CUT) numbers its plies and confirms the fabric used. `null`: nothing to do (void).
 */
export function stepOf(ticket: TicketStatus, lay: LayStatus | null): LayStep | null {
  if (ticket === 'VOID' || lay === 'CANCELLED') return null
  if (ticket === 'OPEN') return 'start'
  if (ticket === 'DONE' || lay === 'CUT') return 'stickers'
  if (lay === 'CHECKED') return 'cut'
  return 'spread'
}

/** Each step's state on the strip: done, the one now, or still to do. */
export function stepStates(now: LayStep): readonly { readonly step: LayStep; readonly state: 'done' | 'now' | 'todo' }[] {
  const at = LAY_STEPS.indexOf(now)
  return LAY_STEPS.map((step, index) => ({ step, state: index < at ? 'done' : index === at ? 'now' : 'todo' }))
}

/** The ticket's ratio as size chips: "46:1 · 48:2" → [{46, 1}, {48, 2}] (a size on several lines is added up by the API). */
export function ratioChips(ratio: string | null): readonly { readonly size: string; readonly ratio: number }[] {
  if (!ratio) return []
  return ratio
    .split('·')
    .map((part) => part.trim())
    .map((part) => {
      const at = part.lastIndexOf(':')
      const value = Number(part.slice(at + 1))
      return at > 0 && Number.isFinite(value) ? { size: part.slice(0, at).trim(), ratio: value } : null
    })
    .filter((chip): chip is { size: string; ratio: number } => chip !== null)
}

/** The ticket's styles and work orders, in the order its lines name them. */
export function linesOf(card: TicketCard): { readonly styles: readonly string[]; readonly workOrders: readonly string[] } {
  return {
    styles: [...new Set(card.lines.map((line) => `${line.style.code} · ${line.colourway.code}`))],
    workOrders: [...new Set(card.lines.map((line) => line.workOrder.number))],
  }
}

// ---- one roll of the lay report (MES-038) ------------------------------------------------------------------------------------------

export interface RollDraft {
  readonly code: string
  /** The plies from this roll: the pad starts at what the lay still needs. */
  readonly plies: number | null
  /** The cutter changed the plies: sent; untouched, the office takes what is needed as far as the roll goes. */
  readonly pliesTouched: boolean
  readonly splices: number
  /** In metres. */
  readonly endLoss: number | null
  /** In metres: the roll end measured back (null: not measured). */
  readonly endReturned: number | null
}

/** A length of a roll's report in metres (the report keeps the roll's own unit). */
export const toMetres = (value: string, uom: string): number => Number(value) / (uom === 'CM' ? 100 : uom === 'MM' ? 1000 : 1)

/**
 * A scanned roll's draft: plies default to what the lay still needs (design "plies default to what is needed"). A roll the lay
 * already has (the office's allocation, or one spread before) starts at its row, so a scan confirms or corrects it.
 */
export function rollDraftOf(code: string, needed: number, row?: { readonly plies: number; readonly splices: number; readonly endLoss: string; readonly endReturned: string; readonly uom: string } | null): RollDraft {
  if (row) {
    const endLoss = toMetres(row.endLoss, row.uom)
    const endReturned = toMetres(row.endReturned, row.uom)
    return { code, plies: row.plies, pliesTouched: true, splices: row.splices, endLoss: endLoss > 0 ? endLoss : null, endReturned: endReturned > 0 ? endReturned : null }
  }
  return { code, plies: needed > 0 ? needed : null, pliesTouched: false, splices: 0, endLoss: null, endReturned: null }
}

/** A length in metres as the API takes it: at most three decimals, no trailing zeros ("0.3"). */
export function metresText(value: number): string {
  const fixed = Math.max(0, Math.round(value * 1000) / 1000).toFixed(3)
  return fixed.replace(/\.?0+$/, '') || '0'
}

/** The body of the roll's write (and of its queued `production.lay.roll`): only what the cutter said. */
export function rollBody(draft: RollDraft): { code: string; plies?: number; splices?: number; endLoss?: string; endReturned?: string; uom?: 'M' } {
  const endLoss = draft.endLoss !== null && draft.endLoss > 0 ? metresText(draft.endLoss) : undefined
  const endReturned = draft.endReturned !== null && draft.endReturned > 0 ? metresText(draft.endReturned) : undefined
  return {
    code: draft.code,
    ...(draft.pliesTouched && draft.plies !== null && draft.plies > 0 ? { plies: draft.plies } : {}),
    ...(draft.splices > 0 ? { splices: draft.splices } : {}),
    ...(endLoss ? { endLoss } : {}),
    ...(endReturned ? { endReturned } : {}),
    ...(endLoss || endReturned ? { uom: 'M' as const } : {}),
  }
}

/** Why "Add roll" waits (null: it may go): a touched pad with no plies. */
export function rollHeld(draft: RollDraft, needed: number): 'plies' | 'full' | null {
  if (draft.pliesTouched && (draft.plies === null || draft.plies < 1)) return 'plies'
  if (!draft.pliesTouched && needed === 0) return 'full'
  return null
}

// ---- the count at both ends (MES-039: any difference blocks the cut) ----------------------------------------------------------------

/** What the screen says before it sends a count: a difference stops it (refusal "Left 24, right 23"), nothing spread, or none. */
export function countProblem(count: { readonly left: number | null; readonly right: number | null }, spread: number): 'empty' | 'differ' | 'nothing' | null {
  if (spread === 0) return 'nothing'
  if (count.left === null || count.right === null || count.left < 1 || count.right < 1) return 'empty'
  if (count.left !== count.right) return 'differ'
  return null
}

// ---- fabric used (MES-046) -------------------------------------------------------------------------------------------------------

/** The pad's first figure: what was confirmed, else the lay report's, in metres (two decimals). */
export function fabricStart(used: FabricUsed): number {
  return Math.round(Number(used.confirmed ?? used.recorded) * 100) / 100
}

/** The figure against the estimate, for the words: more or less by how many metres and per cent (whole), or the same. */
export function fabricDifference(value: number, estimated: string): { readonly kind: 'more' | 'less' | 'same'; readonly metres: number; readonly percent: number } {
  const estimate = Number(estimated)
  const diff = Math.round((value - estimate) * 100) / 100
  if (Math.abs(diff) < 0.005 || !Number.isFinite(diff)) return { kind: 'same', metres: 0, percent: 0 }
  const percent = estimate > 0 ? Math.round((Math.abs(diff) / estimate) * 100) : 0
  return { kind: diff > 0 ? 'more' : 'less', metres: Math.abs(diff), percent }
}

/**
 * The body of the confirmation: `{}` when the cutter confirms the lay report's own figure the first time (the office posts it),
 * else the figure typed in metres. `null`: nothing to send (posted already with this very figure).
 */
export function fabricBody(value: number, used: FabricUsed): { confirmed?: string; uom?: 'M' } | null {
  const same = (figure: string | null) => figure !== null && Math.abs(Number(figure) - value) < 0.005
  if (used.posted && same(used.confirmed ?? used.recorded)) return null
  if (!used.posted && same(used.recorded)) return {}
  return { confirmed: metresText(value), uom: 'M' }
}

// ---- trolleys to sewing (MES-048) -------------------------------------------------------------------------------------------------

/** A trolley's label as scanned or typed (factory-domain cutissue trolleyCodeOf): trimmed, upper case. */
export const trolleyCodeOf = (code: string): string => code.trim().toUpperCase()

/** A trolley label: letters and digits, `. _ - /` inside, at most 20 (factory-domain trolleyCodeProblem). */
export const isTrolleyCode = (code: string): boolean => {
  const label = trolleyCodeOf(code)
  return label.length > 0 && label.length <= 20 && /^[A-Z0-9][A-Z0-9._/-]*$/.test(label)
}

/** A bundle the line names missing, or found again (one tap on its row). */
export const toggleMissing = (missing: readonly string[], code: string): readonly string[] => (missing.includes(code) ? missing.filter((entry) => entry !== code) : [...missing, code])

/** Why Send waits: no bundle on it, or none loaded yet here (a kept load counts). */
export const sendHeld = (trolley: Trolley | null, kept: number): 'empty' | null => ((trolley?.counts.bundles ?? 0) + kept > 0 ? null : 'empty')

// ---- a write kept on the tablet moves the lay on screen at once (the office's answer replaces it) -------------------------------

/** A kept roll: a row "saved on this tablet" and the sums as it would leave them (plies untouched: as needed). */
export function applyKeptRoll(view: LayView, draft: RollDraft): LayView {
  const plies = draft.pliesTouched && draft.plies !== null ? draft.plies : view.spread.needed
  const row = { id: `kept:${view.rolls.length + 1}:${draft.code}`, seq: (view.rolls.at(-1)?.seq ?? 0) + 10, code: draft.code, lotCode: '', plies, splices: draft.splices, endLoss: metresText(draft.endLoss ?? 0), endReturned: metresText(draft.endReturned ?? 0), uom: 'M', used: '', shade: null }
  const existing = view.rolls.findIndex((entry) => entry.code === draft.code)
  const rolls = existing >= 0 ? view.rolls.map((entry, index) => (index === existing ? { ...entry, ...row, id: entry.id, seq: entry.seq, lotCode: entry.lotCode } : entry)) : [...view.rolls, row]
  const spread = rolls.reduce((sum, entry) => sum + entry.plies, 0)
  return { ...view, lay: { ...view.lay, status: view.lay.status === 'PLANNED' || view.lay.status === 'CHECKED' ? 'SPREADING' : view.lay.status, counted: null }, rolls, spread: { ...view.spread, plies: spread, rolls: rolls.length, needed: Math.max(0, view.lay.plies - spread) } }
}

/** A kept Undo: the last roll off the report. */
export function applyKeptUndo(view: LayView): LayView {
  const rolls = view.rolls.slice(0, -1)
  const spread = rolls.reduce((sum, entry) => sum + entry.plies, 0)
  return { ...view, lay: { ...view.lay, status: view.lay.status === 'CHECKED' ? 'SPREADING' : view.lay.status, counted: null }, rolls, spread: { ...view.spread, plies: spread, rolls: rolls.length, needed: Math.max(0, view.lay.plies - spread) } }
}

/** A kept count of equal ends that match the plies spread: the lay checked (the office checks it again on arrival). */
export function applyKeptCount(view: LayView, count: { readonly left: number; readonly right: number }, at: string): LayView {
  return { ...view, lay: { ...view.lay, status: 'CHECKED', counted: { left: count.left, right: count.right, checkedAt: at } } }
}

/** A row the tablet holds that the office has not answered yet. */
export const isKeptRow = (id: string): boolean => id.startsWith('kept:')

// ---- labels -------------------------------------------------------------------------------------------------------------------

const PRINT_STATUS: Readonly<Record<PrintJob['status'], LabelPrintStatus>> = { QUEUED: 'queued', SENT: 'sent', PRINTED: 'printed', FAILED: 'failed' }
export const printStatusOf = (job: PrintJob): LabelPrintStatus => PRINT_STATUS[job.status]

/** One ply sticker as the label printer prints it: "Ply 7 · 48" / "Sleeve 1/2" / "CO-… · Lay 2 · 2/3" (the API's words). */
export function stickerLayout(lines: readonly [string, string, string], name: string): LabelLayout {
  return {
    name,
    widthMm: 50,
    heightMm: 25,
    paddingMm: 2,
    blocks: [
      { kind: 'title', text: lines[0], size: 'lg' },
      { kind: 'text', text: lines[1], size: 'md', bold: true },
      { kind: 'fill' },
      { kind: 'text', text: lines[2], size: 'sm' },
    ],
  }
}

/** A recut ticket's label from the API's lines (heading, title, fields) and its scan code as a Code 128. */
export function recutLayout(label: { readonly heading: string; readonly title: string; readonly fields: readonly { readonly label: string; readonly value: string }[] }, code: string): LabelLayout {
  return {
    name: label.heading,
    widthMm: 76,
    heightMm: 48,
    blocks: [
      { kind: 'text', text: label.heading, size: 'sm', bold: true },
      { kind: 'title', text: label.title, size: 'md' },
      { kind: 'fields', fields: label.fields.slice(0, 4).map((field) => ({ label: field.label, value: field.value, size: 'sm' as const })), columns: 2 },
      { kind: 'fill' },
      { kind: 'barcode', value: code, heightMm: 8 },
    ],
  }
}

// ---- what a scan is on each step --------------------------------------------------------------------------------------------------

/**
 * What a scan is to this screen. A cut ticket's, a recut's or a trolley's code is a number the office prints, not a label code:
 * one that only looks like a label with a wrong check symbol, or reads as a carton's (the cut ticket series "CT<company>-…" shares
 * the carton labels' CT- prefix), is taken as the code it is (`ticketLike`); a label of another kind is that label.
 */
export function fabricScan(read: Exclude<ScanRead, { kind: 'badge' }>, raw: string): { readonly code: string; readonly label: LabelType | null; readonly misread: boolean; readonly ticketLike: boolean } {
  const misread = read.kind === 'otherFactory' || read.kind === 'typo'
  // B-W2b-F16: the reader names a cut ticket's number itself (a free code); a misread or carton read still counts.
  const ticketLike = misread || (read.kind === 'label' && read.type === 'carton') || (read.kind === 'free' && read.cutTicket === true)
  return { code: ticketLike ? raw.trim() : read.code, label: read.kind === 'label' && !ticketLike ? read.type : null, misread, ticketLike }
}

/** The same ticket scanned again (any case, spaces dropped). */
export const sameCode = (left: string, right: string): boolean => left.trim().toUpperCase().replace(/\s+/g, '') === right.trim().toUpperCase().replace(/\s+/g, '')
