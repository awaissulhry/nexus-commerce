import { MAX_BUNDLE_SIZE, splitBundles } from '@nexus/factory-domain/production/bundles/rules'
import type { LabelBlock, LabelLayout } from '@nexus/ui/components/LabelPreview/index'
import type { QueueItem } from '../../queue/model'

/**
 * Bundles & tickets (SCR-095; MES-065, MES-066, MES-068, MES-073; design floor.bundles), the rules without a screen:
 * the proposal per cell (the same split as the API: factory-domain production/bundles `splitBundles` — full bundles of
 * the target size, the last one takes the rest; one garment per bundle for a made-to-measure unit), a bundle's quantity
 * changed by a tap (the bundles before it stay, the ones after it are split again, so every cut garment still has a
 * bundle), what this tablet has made and not yet seen recorded (taken off "to bundle" at once, also offline), the
 * ticket's label as LabelPreview data, and where a ticket's print job stands. Pure, so the tests hold it.
 */

export const MIN_BUNDLE_SIZE = 1
export { MAX_BUNDLE_SIZE }

/** Bundles one tap makes at most (each is one event of the tablet's queue, one ticket). */
export const MAX_BUNDLES_PER_TAP = 100

/** The bundle size after a + or − (1 … 500). */
export function nextBundleSize(size: number, step: 1 | -1): number {
  return Math.min(MAX_BUNDLE_SIZE, Math.max(MIN_BUNDLE_SIZE, size + step))
}

/** A cell's proposed bundles: what is still to bundle, by the target size (one garment each when single-piece). */
export function proposalOf(available: number, size: number, singlePiece: boolean): number[] {
  return splitBundles(Math.max(0, available), singlePiece ? 1 : Math.max(MIN_BUNDLE_SIZE, size))
}

/**
 * The proposal after one bundle's quantity is typed: the bundles before it stay, it takes `value` (at most what is left
 * after the ones before it, at least 1), and the rest is split again by the size. Every garment still has a bundle.
 */
export function editQuantity(quantities: readonly number[], index: number, value: number, available: number, size: number): number[] {
  const before = quantities.slice(0, Math.max(0, index))
  const used = before.reduce((sum, quantity) => sum + quantity, 0)
  const room = Math.max(0, available - used)
  if (room === 0) return before
  const own = Math.min(room, Math.max(1, Math.round(value)))
  return [...before, own, ...splitBundles(room - own, Math.max(MIN_BUNDLE_SIZE, size))]
}

/** The most a bundle at `index` may hold: what is left after the bundles before it. */
export function maxAt(quantities: readonly number[], index: number, available: number): number {
  return Math.max(0, available - quantities.slice(0, Math.max(0, index)).reduce((sum, quantity) => sum + quantity, 0))
}

// ---- what this tablet made in this visit -----------------------------------------------------------------------------

export interface MadeTicket {
  /** The queue's id of the make (one bundle). */
  readonly clientEventId: string
  readonly workOrderId: string
  readonly workOrderSizeId: string
  readonly quantity: number
}

/**
 * Garments this tablet bundled that the work order's last read does not count yet, per cell: made and not recorded
 * (waiting, or refused but sent again by itself), or recorded but not yet in a read (`counted`: the makes that were
 * recorded when the work order was last read; tablet and server clocks are never compared). A final refusal or a
 * discard made nothing.
 */
export function pendingByCell(made: readonly MadeTicket[], items: readonly Pick<QueueItem, 'clientEventId' | 'state' | 'refusal'>[], counted: ReadonlySet<string>): Map<string, number> {
  const byId = new Map(items.map((item) => [item.clientEventId, item]))
  const pending = new Map<string, number>()
  for (const ticket of made) {
    const item = byId.get(ticket.clientEventId)
    if (!item) continue
    const counts =
      item.state === 'waiting' || (item.state === 'refused' && item.refusal !== null && !item.refusal.final) || (item.state === 'recorded' && !counted.has(ticket.clientEventId))
    if (counts) pending.set(ticket.workOrderSizeId, (pending.get(ticket.workOrderSizeId) ?? 0) + ticket.quantity)
  }
  return pending
}

/** The makes recorded by the office that the last read does not count: time to read the work order again. */
export function uncounted(made: readonly MadeTicket[], items: readonly Pick<QueueItem, 'clientEventId' | 'state'>[], counted: ReadonlySet<string>): string[] {
  const ids = new Set(made.map((ticket) => ticket.clientEventId))
  return items.filter((item) => ids.has(item.clientEventId) && item.state === 'recorded' && !counted.has(item.clientEventId)).map((item) => item.clientEventId)
}

// ---- print jobs -------------------------------------------------------------------------------------------------------

export type JobStatus = 'QUEUED' | 'SENT' | 'PRINTED' | 'FAILED'

export interface JobState {
  readonly id: string
  readonly status: JobStatus
  readonly version: number
  readonly scanId: string | null
  readonly lastError: string | null
  readonly createdAt: string
}

/** The job of a ticket's code: the newest job that printed this code (a reprint has a new code, so a new job). */
export function jobOfCode(jobs: readonly JobState[], code: string | null): JobState | null {
  const own = jobs.filter((job) => code === null || job.scanId === null || job.scanId === code)
  return [...own].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0] ?? null
}

/** A job still moving: the screen asks again in a moment. */
export const jobMoving = (job: JobState | null | undefined): boolean => !job || job.status === 'QUEUED' || job.status === 'SENT'

/**
 * Where a ticket's print stands, in the screen's terms: not sent to the office yet, no printer at the site, the
 * person may not see print jobs, being looked for (recorded, no job read yet), or the job's own state.
 */
export type TicketPrint =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'none' }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'looking' }
  | { readonly kind: 'job'; readonly job: JobState }

export function ticketPrint(input: { readonly recorded: boolean; readonly printer: 'some' | 'none'; readonly seesJobs: boolean; readonly job: JobState | null }): TicketPrint {
  if (!input.recorded) return input.printer === 'none' ? { kind: 'none' } : { kind: 'waiting' }
  if (input.printer === 'none') return { kind: 'none' }
  if (!input.seesJobs) return { kind: 'hidden' }
  return input.job ? { kind: 'job', job: input.job } : { kind: 'looking' }
}

// ---- the ticket as a label ----------------------------------------------------------------------------------------------

export interface TicketContent {
  /** The ticket's code; null while the office numbers it. */
  readonly code: string | null
  readonly workOrder: { readonly number: string; readonly batchNumber: string | null }
  readonly style: { readonly code: string; readonly name: string }
  readonly colourway: string
  readonly size: string
  readonly quantity: number
  readonly part: string | null
  readonly operations: readonly { readonly seq: number; readonly code: string; readonly name: string }[]
}

export interface TicketWords {
  readonly name: (code: string) => string
  readonly workOrder: string
  readonly style: string
  readonly colour: string
  readonly size: string
  readonly pieces: string
  readonly operations: string
  /** Said on the label while the office numbers it. */
  readonly numbering: string
}

/** The BUNDLE ticket as LabelPreview data (100 × 50 mm, as factory-domain labels lays it out): code as QR and Code 128. */
export function ticketLayout(ticket: TicketContent, words: TicketWords): LabelLayout {
  const fields = [
    { label: words.workOrder, value: ticket.workOrder.batchNumber ? `${ticket.workOrder.number} · ${ticket.workOrder.batchNumber}` : ticket.workOrder.number },
    { label: words.size, value: ticket.size, size: 'xl' as const },
    { label: words.colour, value: ticket.colourway },
    { label: words.pieces, value: ticket.part ? `${ticket.quantity} · ${ticket.part}` : String(ticket.quantity), size: 'xl' as const },
  ]
  const head: LabelBlock[] = [{ kind: 'title', text: [ticket.style.code, ticket.style.name].filter(Boolean).join(' · '), size: 'md' }]
  const middle: LabelBlock = ticket.code
    ? { kind: 'row', blocks: [{ kind: 'fields', columns: 2, fields }, { kind: 'qr', value: ticket.code, sizeMm: 16 }] }
    : { kind: 'fields', columns: 2, fields }
  const operations = ticket.operations.length > 0 ? [{ kind: 'text' as const, text: `${words.operations}: ${ticket.operations.map((operation) => operation.seq).join(' · ')}`, size: 'sm' as const }] : []
  const code: LabelBlock[] = ticket.code ? [{ kind: 'fill' }, { kind: 'barcode', value: ticket.code, heightMm: 9 }] : [{ kind: 'fill' }, { kind: 'text', text: words.numbering, size: 'sm', bold: true, align: 'center' }]
  return { name: words.name(ticket.code ?? '—'), widthMm: 100, heightMm: 50, blocks: [...head, middle, ...operations, ...code] }
}

// ---- reasons ------------------------------------------------------------------------------------------------------------

/** Why a ticket is printed again (design floor.bundles "reprint"): the reason kept on the reprint, in plain English. */
export const REPRINT_REASONS = { lost: 'Ticket lost', damaged: 'Ticket damaged', unreadable: 'Ticket unreadable' } as const
export type ReprintReason = keyof typeof REPRINT_REASONS

/** Why a bundle is voided (design bundles.void "a reason tile"). */
export const VOID_REASONS = { mistake: 'Made by mistake', wrongSize: 'Wrong size', wrongQuantity: 'Wrong quantity' } as const
export type VoidReason = keyof typeof VOID_REASONS
