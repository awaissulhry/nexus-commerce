import { recordAddress } from '../../../../lib/records/record-links'
import type { Loaded, Phrase } from '../../../_shared/buying/model'
import { decimalValue, phrase } from '../../../_shared/buying/model'
import type { ActionMessage, ActionMessages, BulkAnswer, ConvertAnswer, Delays, DelayDemand, ItemProfile, PlannedList, PlannedOrder, ProfileRow, ProtectableField, RunLog } from './api'

/**
 * B-W2b-335 — the W2b parts of What to buy & make (SCR-055; design planning.mrp sec:make, sec:tiles#1, sec:requirements#1,
 * pop:run-log#1, pop:item-profile), pure: who may do what, why a planned order cannot be made real (said from the row, never
 * the API's words), what a selection reaches, a planned order's sizes, late and material-late words, the protected cells
 * and their plan values, an action message in our words with the record it opens, the run log's numbers, and the
 * projected stock's rows, refs and chart. Words are keys of `planning-mrp-depth` (this file's DEPTH_NAMESPACE).
 */

export const DEPTH_NAMESPACE = 'planning-mrp-depth'

// ---- who may do what ---------------------------------------------------------------------------------------------------------

export interface DepthCan {
  /** planning.planned.convert (B-W2b-293). */
  convert: boolean
  /** planning.firm: firm or plan again a planned order. */
  firm: boolean
  /** planning.planned.edit (B-W2b-306): change dates (protected), Reset to plan, move many. */
  edit: boolean
  /** planning.actions.manage: Done / Ignore an action message. */
  actions: boolean
  /** workorders.manage: a conversion makes a work order. */
  workOrders: boolean
  /** workorders.release + purchasing.subcontract.manage: a subcontract conversion releases it and drafts the order. */
  subcontract: boolean
}

export function depthCan(permissions: readonly string[]): DepthCan {
  const held = new Set(permissions)
  return {
    convert: held.has('planning.planned.convert'),
    firm: held.has('planning.firm'),
    edit: held.has('planning.planned.edit'),
    actions: held.has('planning.actions.manage'),
    workOrders: held.has('workorders.manage'),
    subcontract: held.has('workorders.release') && held.has('purchasing.subcontract.manage'),
  }
}

// ---- a planned order -----------------------------------------------------------------------------------------------------------

/** Why it cannot be made real now (a key of planning-mrp-depth), said from the row; null: it can. */
export function heldOf(row: PlannedOrder): string | null {
  if (row.status === 'CONVERTED') return 'held.converted'
  if (row.demand.length === 0) return 'held.noDemand'
  if (!row.plannedRevision) return 'held.noRevision'
  return row.held ? 'held.other' : null
}

/** The row's selection box: held with the reason (a converted or unconvertible row may still be moved by days). */
export function selectHeld(row: PlannedOrder, can: DepthCan): string | null {
  if (row.status === 'CONVERTED') return 'held.converted'
  if (!can.convert && !can.edit) return 'held.noRight'
  return null
}

/** What a selection makes real: the rows that can be, by kind. */
export function convertReach(rows: readonly PlannedOrder[]): { make: PlannedOrder[]; subcontract: PlannedOrder[] } {
  const ready = rows.filter((row) => heldOf(row) === null)
  return { make: ready.filter((row) => row.kind === 'MAKE'), subcontract: ready.filter((row) => row.kind === 'SUBCONTRACT') }
}

/** Why "Create n work orders" (or subcontract orders) is held for this person and these rows, or null. */
export function convertHeld(kind: 'MAKE' | 'SUBCONTRACT', reach: number, can: DepthCan): string | null {
  if (!can.convert) return 'held.noConvert'
  if (!can.workOrders) return 'held.noWorkOrders'
  if (kind === 'SUBCONTRACT' && !can.subcontract) return 'held.noSubcontract'
  if (reach === 0) return kind === 'MAKE' ? 'held.noMake' : 'held.noSubcontractRow'
  return null
}

/** Why "Move n by days" is held, or null. */
export function shiftHeld(rows: readonly PlannedOrder[], can: DepthCan): string | null {
  if (!can.edit) return 'held.noEdit'
  if (rows.filter((row) => row.status === 'PLANNED').length === 0) return 'held.noneToMove'
  if (rows.length > 100) return 'held.tooMany'
  return null
}

/** Why a row's dates cannot be changed now, or null. */
export function editHeld(row: PlannedOrder, can: DepthCan): string | null {
  if (!can.edit) return 'held.noEdit'
  if (row.status === 'CONVERTED') return 'held.converted'
  if (row.firm) return 'held.firm'
  return null
}

/** Why Firm / Plan again is held, or null. */
export function firmHeld(row: PlannedOrder, can: DepthCan): string | null {
  if (!can.firm) return 'held.noFirm'
  if (row.status === 'CONVERTED') return 'held.converted'
  return null
}

/** The size run in a few characters: "48 ×2 · 50 ×4". */
export const sizesText = (row: Pick<PlannedOrder, 'sizes'>): string => row.sizes.map((entry) => `${entry.size} ×${entry.quantity}`).join(' · ')

/** The order numbers it makes, each once, in their order. */
export const ordersOf = (row: Pick<PlannedOrder, 'demand'>): { id: string; number: string }[] =>
  row.demand.reduce<{ id: string; number: string }[]>((all, entry) => (all.some((order) => order.id === entry.orderId) ? all : [...all, { id: entry.orderId, number: entry.orderNumber }]), [])

/** A protected field's dot: it is the planner's value; the plan's own value for the tooltip (null: none known). */
export function protection(row: PlannedOrder, field: ProtectableField): { protectedNow: boolean; plan: string | null } {
  const protectedNow = row.protectedFields.includes(field)
  const value = (row.plan as Record<string, unknown>)[field]
  return { protectedNow, plan: protectedNow && typeof value === 'string' ? value : null }
}

/** Late demand of a planned order (the run starts it today and it is ready after the day needed): need day and days late. */
export function lateOf(row: PlannedOrder): Phrase | null {
  return row.late ? phrase('late.planned', { need: row.late.needDate, count: row.late.daysLate }) : null
}

/** The material that makes a planned order's demand late (GET /planning/delays): its earliest usable day, the latest one. */
export function materialLateOf(row: Pick<PlannedOrder, 'demand'>, delays: Delays | null): DelayDemand | null {
  if (!delays) return null
  const lines = new Set(row.demand.map((entry) => entry.orderLineId))
  return delays.demands.filter((demand) => lines.has(demand.orderLine.id)).reduce<DelayDemand | null>((worst, demand) => (!worst || demand.daysLate > worst.daysLate ? demand : worst), null)
}

/** "SEED-LEA-100 BLK": a material and its colour as codes. */
export const materialCode = (material: { item: { code: string }; colour: { code: string } | null }): string => [material.item.code, material.colour?.code].filter(Boolean).join(' ')

/** The rows the To make list shows (soonest start first; the API's order) and a search over style, colour, orders, line, workshop. */
export function visiblePlanned(rows: readonly PlannedOrder[], q: string): PlannedOrder[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter((row) => [row.style.code, row.style.name, row.colourway.code, row.line?.name, row.line?.code, row.workshop?.name, row.workshop?.code, ...row.demand.map((entry) => entry.orderNumber)].filter(Boolean).some((text) => text!.toLowerCase().includes(needle)))
}

// ---- action messages -----------------------------------------------------------------------------------------------------------

/** The record an action message is about, in our words: "PO-0012, line 2", "WO-0003", the planned order or material. */
export function messageRecord(message: ActionMessage): Phrase {
  const fact = (key: string) => (message.facts[key] === null || message.facts[key] === undefined ? '' : String(message.facts[key]))
  switch (message.record.type) {
    case 'PurchaseOrderLine':
      return fact('lineSeq') ? phrase('msg.rec.poLine', { number: fact('purchaseOrderNumber'), line: fact('lineSeq') }) : phrase('msg.rec.po', { number: fact('purchaseOrderNumber') })
    case 'WorkOrder':
      return phrase('msg.rec.workOrder', { number: message.record.label })
    case 'SubcontractOrder':
      return phrase('msg.rec.subcontract', { number: message.record.label })
    case 'PlannedWorkOrder':
      return phrase('msg.rec.planned', { label: fact('plannedWorkOrder') })
    case 'MaterialRequirement':
      return phrase('msg.rec.firm', { material: fact('material') })
  }
}

/** What to do, in our words, from the action, the days and the quantities ("Bring forward from 26 Nov to 18 Nov"). */
export function messageWhat(message: ActionMessage): Phrase {
  const { action, fromDate, toDate, fromQuantity, toQuantity, uom } = message
  if ((action === 'EXPEDITE' || action === 'DEFER') && fromDate && toDate) return phrase(`msg.${action}`, { from: fromDate, to: toDate })
  if ((action === 'INCREASE' || action === 'DECREASE') && fromQuantity !== null && toQuantity !== null) return phrase(`msg.${action}`, { from: fromQuantity, to: toQuantity, unit: uom ?? '' })
  if (action === 'CANCEL' && fromQuantity !== null) return phrase('msg.CANCEL_qty', { quantity: fromQuantity, unit: uom ?? '' })
  return phrase(`msg.${action}_plain`)
}

/** Where the message's record opens: its own page (record-links); a firm planned order opens its line's Why; a planned order none. */
export function messageHref(message: ActionMessage, prefix: string, built: ReadonlySet<string>): { kind: 'page'; href: string } | { kind: 'why'; lineId: string } | null {
  if (message.record.type === 'PlannedWorkOrder') return null
  if (message.record.type === 'MaterialRequirement') return { kind: 'why', lineId: message.record.id }
  return { kind: 'page', href: `${prefix}${recordAddress({ type: message.record.open.type, id: message.record.open.id, label: message.record.label }, built)}` }
}

/** Why Done / Ignore is held on these messages, or null. */
export function decideHeld(messages: readonly ActionMessage[], can: DepthCan): string | null {
  if (!can.actions) return 'held.noActions'
  if (messages.length === 0 || messages.every((message) => message.status !== 'OPEN')) return 'held.noneOpen'
  if (messages.some((message) => message.status === 'OPEN' && !message.may.decide)) return 'held.notLatest'
  return null
}

export const openMessages = (messages: readonly ActionMessage[]): ActionMessage[] => messages.filter((message) => message.status === 'OPEN')

// ---- the run log -------------------------------------------------------------------------------------------------------------------

/** The counts the log shows first (the rest under "every count"), in the inputs' order. */
export const LOG_MAIN_COUNTS = ['orderLines', 'orderLinesPlanned', 'orders', 'lateOrderLines', 'materials', 'stockLines', 'purchaseLines', 'reservations', 'firmPlannedOrders', 'itemParameters'] as const

/** The log's proposals counted: lines to buy, to make, planned orders by kind. */
export function logCounts(log: RunLog): { buy: number; make: number; plannedMake: number; plannedSubcontract: number } {
  return {
    buy: log.proposals.requirements.filter((line) => line.action === 'BUY').length,
    make: log.proposals.requirements.filter((line) => line.action === 'MAKE').length,
    plannedMake: log.proposals.plannedOrders.filter((row) => row.kind === 'MAKE').length,
    plannedSubcontract: log.proposals.plannedOrders.filter((row) => row.kind === 'SUBCONTRACT').length,
  }
}

// ---- the projected stock of a material ---------------------------------------------------------------------------------------------

/** A week's name: "PAST", "LATER" or the ISO week (2026-W47 → "W47"). */
export const weekName = (row: Pick<ProfileRow, 'key'>): { kind: 'past' | 'later' | 'week'; week: string } =>
  row.key === 'PAST' ? { kind: 'past', week: '' } : row.key === 'LATER' ? { kind: 'later', week: '' } : { kind: 'week', week: row.key.replace(/^\d{4}-/, '') }

/** The chart's points: the projected balance (with the plan too) per week and the safety-stock line, and one domain for both axes. */
export function profileChart(profile: ItemProfile): { data: Record<string, number | string>[]; domain: [number, number]; ticks: number[] } {
  const safety = decimalValue(profile.safetyStock) ?? 0
  const data = profile.rows.map((row) => {
    const name = weekName(row)
    return { week: name.kind === 'week' ? name.week : name.kind === 'past' ? '<' : '>', projected: decimalValue(row.projected) ?? 0, safety }
  })
  const values = data.flatMap((point) => [point.projected, point.safety])
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  // A round step (1, 2 or 5 × a power of ten) so the axis reads 0, 50, 100 … and both axes share it.
  const rough = Math.max(1, (max - min) / 4)
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ?? 10 * power
  const floor = Math.floor(min / step) * step
  const low = floor - (min < 0 && floor === min ? step : 0)
  const high = Math.max(low + step, Math.ceil(max / step) * step + (Math.ceil(max / step) * step === max ? step : 0))
  const ticks: number[] = []
  for (let tick = low; tick <= high + step / 2; tick += step) ticks.push(Math.round(tick * 1000) / 1000)
  return { data, domain: [low, high], ticks }
}

/** The material's place in the grid's order (J / K): the previous and next line ids, null at an end. */
export function walkOf(order: readonly string[], lineId: string): { index: number; previous: string | null; next: string | null } {
  const index = order.indexOf(lineId)
  return { index, previous: index > 0 ? order[index - 1]! : null, next: index >= 0 && index < order.length - 1 ? order[index + 1]! : null }
}

// ---- the page's W2b model --------------------------------------------------------------------------------------------------------

export interface ConvertDialog {
  kind: 'MAKE' | 'SUBCONTRACT'
  rows: PlannedOrder[]
  phase: 'reading' | 'ready' | 'saving' | 'done' | 'failed'
  preview: ConvertAnswer | null
  done: ConvertAnswer | null
  problem: string | null
}

export interface ShiftDialog {
  rows: PlannedOrder[]
  days: number
  phase: 'reading' | 'ready' | 'saving' | 'done' | 'failed'
  preview: BulkAnswer | null
  done: BulkAnswer | null
  problem: string | null
}

export interface DatesDialog {
  rowId: string
  startDate: string
  dueDate: string
  busy: boolean
  problem: string | null
}

export interface DecideDialog {
  ids: string[]
  status: 'DONE' | 'IGNORED'
  note: string
  busy: boolean
  problem: string | null
}

export type DepthDialog = { kind: 'convert'; convert: ConvertDialog } | { kind: 'shift'; shift: ShiftDialog } | { kind: 'dates'; dates: DatesDialog } | { kind: 'decide'; decide: DecideDialog }

/** The W2b parts' notice: a key of planning-mrp-depth and its values. */
export interface DepthNotice {
  tone: 'success' | 'danger' | 'info' | 'warning'
  words: Phrase
}

export interface DepthModel {
  can: DepthCan
  planned: Loaded<PlannedList> | null
  messages: Loaded<ActionMessages> | null
  /** The decided messages are listed too. */
  allMessages: boolean
  delays: Delays | null
  dialog: DepthDialog | null
  notice: DepthNotice | null
  /** Rows a single write is on (their buttons say so). */
  busy: readonly string[]
  /** The run log open in Run history. */
  log: { runId: string; log: Loaded<RunLog> } | null
  /** "Projected stock — <material>" (`?profile=<line>`). */
  profile: { lineId: string; profile: Loaded<ItemProfile> } | null
  /** The office pages that are built (record-links). */
  built: ReadonlySet<string>
  /** Design cases: the To make list's selection, the messages' selection. */
  selected?: readonly string[]
  selectedMessages?: readonly string[]
}

export interface DepthActions {
  onRetry?: () => void
  onConvert?: (kind: 'MAKE' | 'SUBCONTRACT', rowIds: string[]) => void
  onConvertSave?: () => void
  onShift?: (rowIds: string[]) => void
  onShiftDays?: (days: number) => void
  onShiftSave?: () => void
  onFirm?: (rowId: string, firm: boolean) => void
  onDates?: (rowId: string) => void
  onDatesChange?: (field: 'startDate' | 'dueDate', value: string) => void
  onDatesSave?: () => void
  onReset?: (rowId: string, field: ProtectableField) => void
  onDecide?: (ids: string[], status: 'DONE' | 'IGNORED') => void
  onDecideNote?: (note: string) => void
  onDecideSave?: () => void
  onAllMessages?: (all: boolean) => void
  onCloseDialog?: () => void
  onDismissNotice?: () => void
  onLog?: (runId: string | null) => void
  onProfile?: (lineId: string | null) => void
  onRetryProfile?: () => void
}

/** The To make tile: planned orders not made real yet ("—" while unknown). */
export const toMakeCount = (planned: Loaded<PlannedList> | null): number | null => (planned?.status === 'ready' ? planned.value.counts.make + planned.value.counts.subcontract : null)

/** Open action messages of the latest plan (null while unknown). */
export const openMessageCount = (messages: Loaded<ActionMessages> | null): number | null => (messages?.status === 'ready' ? messages.value.counts.open : null)
