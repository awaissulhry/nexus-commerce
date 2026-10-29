import { decimalValue, type BuyingCan, type Loaded, type Phrase } from '../../_shared/buying/model'
import type { SiteOption, SupplierOption } from '../../_shared/buying/api'
import type { LiveState } from '../../_shared/buying/hooks'
import type { Drafted, Explain, OpenDraft, Plan, PlanLine, PlanRun, SetAsideReason, StockLine } from './api'

/**
 * What to buy & make (SCR-055) — the screen's rules, pure: the saved views (the tiles are some of them), which lines a
 * view shows and in what order, the netting said as words from the numbers, a line's decision in words, which lines an
 * action reaches (and why the others not), the Draft POs dialog's cards per supplier, the stock the plan may not use
 * counted by reason, and the CSV of the selected lines.
 */

export const PLAN_VIEWS = ['open', 'toBuy', 'late', 'make', 'held', 'inDraft', 'ordered', 'setAside', 'leather', 'all'] as const
export type PlanView = (typeof PLAN_VIEWS)[number]

export function viewOf(value: string | null | undefined): PlanView {
  return (PLAN_VIEWS as readonly string[]).includes(value ?? '') ? (value as PlanView) : 'open'
}

const isShort = (line: PlanLine) => (decimalValue(line.netQuantity) ?? 0) > 0
const isDraftOrder = (line: PlanLine) => line.decision === 'ORDERED' && line.purchaseOrder?.status === 'DRAFT'

/** Whether a line belongs to a view. */
export function inView(line: PlanLine, view: PlanView): boolean {
  switch (view) {
    case 'open':
      return line.decision === 'OPEN' && isShort(line)
    case 'toBuy':
      return line.decision === 'OPEN' && isShort(line) && line.action === 'BUY'
    case 'late':
      return line.decision === 'OPEN' && isShort(line) && line.action === 'BUY' && !!line.orderBy?.passed
    case 'make':
      return line.decision === 'OPEN' && isShort(line) && line.action === 'MAKE'
    case 'held':
      return isShort(line) && (decimalValue(line.heldStock) ?? 0) > 0
    case 'inDraft':
      return isDraftOrder(line)
    case 'ordered':
      return line.decision === 'ORDERED'
    case 'setAside':
      return line.decision === 'IGNORED'
    case 'leather':
      return line.item.kind === 'LEATHER'
    case 'all':
      return true
  }
}

/** The tiles: saved views whose counts come from the run (never from the filtered lines). */
export const TILES: readonly { id: string; view: PlanView; count: (summary: Plan['summary']) => number }[] = Object.freeze([
  { id: 'toBuy', view: 'toBuy', count: (summary) => summary.toBuy },
  { id: 'late', view: 'late', count: (summary) => summary.orderByPassed },
  { id: 'make', view: 'make', count: (summary) => summary.toMake },
  { id: 'inDraft', view: 'inDraft', count: (summary) => summary.inDraftPurchaseOrder },
  { id: 'setAside', view: 'setAside', count: (summary) => summary.setAside },
])

/** A search over the material, its colour, the supplier and the orders behind a line. */
export function matches(line: PlanLine, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [line.item.code, line.item.name, line.colour?.code, line.colour?.name, line.supplier?.name, line.supplier?.code, ...line.orders.map((order) => order.number), line.purchaseOrder?.number]
    .filter(Boolean)
    .some((text) => text!.toLowerCase().includes(needle))
}

/** The grid's order: by supplier (no supplier last), then the order-by day, the need day, the run's own order. */
export function sortLines(lines: readonly PlanLine[]): PlanLine[] {
  return [...lines].sort((a, b) => {
    const sa = a.supplier?.name ?? '￿'
    const sb = b.supplier?.name ?? '￿'
    if (sa !== sb) return sa.localeCompare(sb)
    const oa = a.orderBy?.date ?? a.needDate
    const ob = b.orderBy?.date ?? b.needDate
    if (oa !== ob) return oa.localeCompare(ob)
    return a.seq - b.seq
  })
}

export function visibleLines(lines: readonly PlanLine[], view: PlanView, q: string): PlanLine[] {
  return sortLines(lines.filter((line) => inView(line, view) && matches(line, q)))
}

/** A line's decision in words: open, in a draft PO, ordered (with the order's state), set aside with its reason. */
export function decisionPhrase(line: PlanLine): Phrase {
  if (line.decision === 'IGNORED') return { key: `decision.setAside.${line.decisionReason ?? 'OTHER'}` }
  if (line.decision === 'ORDERED') {
    if (!line.purchaseOrder) return { key: 'decision.orderedUnknown' }
    if (line.purchaseOrder.status === 'DRAFT') return { key: 'decision.inDraft', params: { number: line.purchaseOrder.number } }
    return { key: 'decision.ordered', params: { number: line.purchaseOrder.number, status: `poStatus.${line.purchaseOrder.status}` } }
  }
  return { key: line.action === 'MAKE' ? 'decision.toMake' : 'decision.open' }
}

/** Why an action cannot reach this line (the row's box is held with it), or null when one can. */
export function heldReason(line: PlanLine, can: Pick<BuyingCan, 'planDecide' | 'poManage'>): string | null {
  if (line.decision === 'ORDERED') return 'held.ordered'
  if (line.decision === 'IGNORED') return can.planDecide ? null : 'held.noDecide'
  if (!isShort(line)) return 'held.covered'
  if (!can.planDecide && !can.poManage) return 'held.noRight'
  return null
}

/** Why "Draft PO" is held on this line, or null. */
export function draftHeld(line: PlanLine, can: Pick<BuyingCan, 'poManage'>): string | null {
  if (!can.poManage) return 'held.noPurchasing'
  if (line.action !== 'BUY') return 'held.makeLine'
  if (line.decision === 'ORDERED') return 'held.ordered'
  if (line.decision === 'IGNORED') return 'held.setAside'
  if (!isShort(line)) return 'held.covered'
  return null
}

/** Buy lines a Draft POs run takes from a selection (open, short, to buy). */
export const draftable = (lines: readonly PlanLine[]): PlanLine[] => lines.filter((line) => line.action === 'BUY' && line.decision === 'OPEN' && isShort(line))

/** One card of the Draft POs dialog: one supplier, its lines, and whether an open draft can take them. */
export interface DraftCard {
  /** null: lines with no supplier on record (the person picks one per card). */
  supplierId: string | null
  supplierName: string | null
  lines: PlanLine[]
  /** The supplier's newest open draft at the site, if any. */
  draft: OpenDraft | null
}

export function draftCards(lines: readonly PlanLine[], drafts: readonly OpenDraft[]): DraftCard[] {
  const cards = new Map<string, DraftCard>()
  for (const line of draftable(lines)) {
    const key = line.supplier?.id ?? ''
    const card = cards.get(key) ?? { supplierId: line.supplier?.id ?? null, supplierName: line.supplier?.name ?? null, lines: [], draft: line.supplier ? (drafts.find((draft) => draft.partyId === line.supplier!.id) ?? null) : null }
    card.lines.push(line)
    cards.set(key, card)
  }
  return [...cards.values()].sort((a, b) => (a.supplierName ?? '￿').localeCompare(b.supplierName ?? '￿'))
}

/** The suppliers a set of lines would draft for ("23 lines · 6 suppliers"; lines without a supplier count apart). */
export function draftReach(lines: readonly PlanLine[]): { lines: number; suppliers: number; noSupplier: number } {
  const own = draftable(lines)
  return { lines: own.length, suppliers: new Set(own.flatMap((line) => (line.supplier ? [line.supplier.id] : []))).size, noSupplier: own.filter((line) => !line.supplier).length }
}

/** The stock the plan may not use, counted by reason (the notice: "2 lots on quality hold, 1 lot without a valid Cr VI test"). */
export function heldByReason(stock: readonly StockLine[]): { reason: string; lots: number }[] {
  const counts = new Map<string, number>()
  for (const line of stock) if (line.reason && line.reason !== 'OTHER_COLOUR') counts.set(line.reason, (counts.get(line.reason) ?? 0) + 1)
  return [...counts].map(([reason, lots]) => ({ reason, lots }))
}

/** How long a run took, in whole seconds (null while it runs). */
export function runSeconds(run: PlanRun): number | null {
  if (!run.finishedAt) return null
  return Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))
}

/** The run state the band's pill shows: running (a newer attempt), failed (a newer attempt failed), done, or none yet. */
export function planState(plan: Plan | null): 'none' | 'done' | 'running' | 'failed' {
  if (!plan) return 'none'
  if (plan.latestAttempt?.status === 'RUNNING') return 'running'
  if (plan.latestAttempt?.status === 'FAILED') return 'failed'
  return plan.run ? 'done' : 'none'
}

// ---- the page's model --------------------------------------------------------------------------------------------------

export interface DraftDialog {
  /** The lines the person asked to draft (open buy lines among them). */
  lines: PlanLine[]
  drafts: OpenDraft[] | null
  draftsProblem: string | null
  /** Per supplier: an open draft's id, or null for a new one; absent = the supplier's open draft (the API's default). */
  into: Record<string, string | null>
  /** Lines with no supplier: the supplier picked per line. */
  suppliers: Record<string, SupplierOption>
  supplierQuery: string
  supplierOptions: SupplierOption[] | null
  busy: boolean
  problem: Phrase | null
  result: Drafted | null
}

export type PlanDialog =
  | { kind: 'draft'; draft: DraftDialog }
  | { kind: 'setAside'; lineIds: string[]; reason: SetAsideReason | ''; note: string; busy: boolean; problem: Phrase | null }
  | { kind: 'history'; runs: PlanRun[] | null; problem: string | null }
  | { kind: 'explainer' }
  | { kind: 'keys' }

/** A notice after a write, with an Undo when the write can be put back. */
export interface PlanNotice {
  tone: 'success' | 'danger' | 'info'
  words: Phrase
  /** Open the order the lines went into. */
  open?: { href: string; label: string } | null
  undo?: { kind: 'draft'; purchaseOrderLineIds: string[]; cancelOrderIds: string[] } | { kind: 'setAside'; lines: { id: string; version: number }[] } | null
}

export interface PlanModel {
  prefix: string
  can: BuyingCan
  sites: Loaded<SiteOption[]>
  siteId: string | null
  plan: Loaded<Plan>
  view: PlanView
  q: string
  /** The not-counted stock behind "short although stock exists" (read when the run counts such lines). */
  held: StockLine[] | null
  live: LiveState
  updates: number
  running: boolean
  /** Rows a Draft PO is being made for (their cell says so). */
  drafting: readonly string[]
  notice: PlanNotice | null
  dialog: PlanDialog | null
  /** The Why drawer: the line (`?line=`) and its explanation. */
  why: { lineId: string; explain: Loaded<Explain> } | null
  /** Design cases: preset selection, focused row, keys panel. */
  selected?: readonly string[]
  focusRow?: number
  keysOpen?: boolean
  timeZone?: string
}

export interface PlanActions {
  onSite?: (siteId: string) => void
  onView?: (view: PlanView) => void
  onSearch?: (q: string) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onRun?: () => void
  onDraftOne?: (lineId: string) => void
  onDraftMany?: (lineIds: string[]) => void
  onSetAside?: (lineIds: string[]) => void
  onReopen?: (lineIds: string[]) => void
  onExport?: (lineIds: string[]) => void
  onWhy?: (lineId: string | null) => void
  onHistory?: () => void
  onExplainer?: () => void
  onKeys?: () => void
  onCloseDialog?: () => void
  onUndo?: () => void
  onDismissNotice?: () => void
  draft?: {
    onInto?: (supplierId: string, purchaseOrderId: string | null) => void
    onSupplierQuery?: (q: string) => void
    onPickSupplier?: (lineId: string, supplier: SupplierOption | null) => void
    onCreate?: () => void
  }
  setAside?: { onReason?: (reason: SetAsideReason) => void; onNote?: (note: string) => void; onConfirm?: () => void }
}
