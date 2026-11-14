import { isApiError, issuePath } from '../../../../../lib/api/errors'
import { RETURN_LABEL_REFUSALS, type ReturnLabelRefusal, type ReturnLabelStatus } from '@nexus/factory-domain/shipping/return-labels/rules'
import type { ReturnLabelRow, ReturnLabels } from './api'

/**
 * The return label section's rules (B-W2b-398; design sales.returns RMA › Shipments "Return label or link", "Make return
 * label"), pure: what the section shows, which button is held and why (in the catalogue `shipping-delivery`, keys
 * `rl.held.*`), the dialog's draft, a refusal's words from its code, the Return label PDF window's address.
 */

export type Busy = null | 'make' | `cancel:${string}`

/** What a write came to. */
export type Outcome =
  | null
  | { readonly kind: 'booked' }
  | { readonly kind: 'offered'; readonly mailed: number }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly key: string }

export interface MakeDraft {
  readonly mode: 'LABEL' | 'LINK'
  readonly shipmentId: string | null
  /** LINK: mail it to the orders contacts (true) or one link to pass on (false). */
  readonly send: boolean
}

export interface ReturnLabelsModel {
  readonly state: 'loading' | 'ready' | 'error'
  readonly read: ReturnLabels | null
  /** The browser is offline: every write is held (the office keeps no queue). */
  readonly offline: boolean
  readonly busy: Busy
  readonly dialog: MakeDraft | null
  /** A label whose withdrawal waits for the person's yes. */
  readonly cancel: string | null
  readonly passOn: { readonly url: string; readonly copied: boolean } | null
  readonly outcome: Outcome
  /** The company's address prefix (`/w/<code>`): the PDF window's link. */
  readonly prefix: string
}

export interface ReturnLabelsActions {
  readonly onRetry?: () => void
  readonly onMake?: () => void
  readonly onDraft?: (draft: MakeDraft) => void
  readonly onCloseDialog?: () => void
  readonly onConfirmMake?: () => void
  readonly onCancel?: (labelId: string | null) => void
  readonly onConfirmCancel?: () => void
  readonly onCopyAgain?: () => void
  readonly onDismiss?: () => void
}

export const initialModel = (prefix: string): ReturnLabelsModel => ({ state: 'loading', read: null, offline: false, busy: null, dialog: null, cancel: null, passOn: null, outcome: null, prefix })

export const STATUS_TONE: Readonly<Record<ReturnLabelStatus, 'info' | 'success' | 'neutral' | 'warning'>> = Object.freeze({ OFFERED: 'info', BOOKED: 'success', USED: 'neutral', CANCELLED: 'neutral' })

/** Why "Make return label" is held (a key of `rl.held`), or null. */
export function makeHeldKey(model: Pick<ReturnLabelsModel, 'read' | 'busy' | 'offline'>): string | null {
  const read = model.read
  if (!read) return 'rl.held.loading'
  if (!read.mayManage) return 'rl.held.right'
  if (model.offline) return 'rl.held.offline'
  if (model.busy !== null) return 'rl.held.busy'
  if (read.make.held) return `rl.held.code.${read.make.held}`
  return null
}

/** Why a label's Withdraw is held, or null. */
export function cancelHeldKey(model: Pick<ReturnLabelsModel, 'read' | 'busy' | 'offline'>, row: ReturnLabelRow): string | null {
  if (!model.read?.mayManage) return 'rl.held.right'
  if (row.status === 'USED' || row.status === 'CANCELLED') return 'rl.held.final'
  if (model.offline) return 'rl.held.offline'
  if (model.busy !== null) return 'rl.held.busy'
  return null
}

/** Why the dialog's confirm is held: a link to mail needs someone to mail it to. */
export function confirmHeldKey(read: ReturnLabels, draft: MakeDraft, busy: Busy): string | null {
  if (busy !== null) return 'rl.held.busy'
  if (draft.mode === 'LINK' && draft.send && read.recipients.length === 0) return 'rl.held.code.NO_RECIPIENT'
  return null
}

/** The dialog's first draft: a label now, from the newest shipment, mailed when there is someone to mail. */
export const firstDraft = (read: ReturnLabels): MakeDraft => ({ mode: 'LABEL', shipmentId: read.make.shipment?.id ?? null, send: read.recipients.length > 0 })

/** The body of a make from the draft (the shipment only when the person picked another one than the newest). */
export function makeBodyOf(read: ReturnLabels, draft: MakeDraft): { mode: 'LABEL' | 'LINK'; shipmentId?: string; send?: boolean } {
  return {
    mode: draft.mode,
    ...(draft.shipmentId && draft.shipmentId !== read.make.shipment?.id ? { shipmentId: draft.shipmentId } : {}),
    ...(draft.mode === 'LINK' ? { send: draft.send } : {}),
  }
}

const isRefusal = (value: string): value is ReturnLabelRefusal => (RETURN_LABEL_REFUSALS as readonly string[]).includes(value)

/** A refused write's words (a key of the catalogue): the refusal's code, else the kind of error. */
export function outcomeOfError(error: unknown): Outcome {
  if (isApiError(error)) {
    const code = error.issues.map(issuePath).find((path) => path.startsWith('refusal/'))?.slice('refusal/'.length)
    if (code && isRefusal(code)) return { kind: 'failed', key: `rl.held.code.${code}` }
    if (error.kind === 'forbidden') return { kind: 'failed', key: 'rl.failed.forbidden' }
    if (error.kind === 'conflict' || error.kind === 'invalid') return { kind: 'failed', key: 'rl.failed.refused' }
    if (error.kind === 'unavailable') return { kind: 'failed', key: 'rl.failed.offline' }
  }
  return { kind: 'failed', key: 'rl.failed.error' }
}

/** The Return label PDF window (a window page, a new tab): `<prefix>/sales/returns/label?return=<id>&label=<id>`. */
export const labelWindowHref = (prefix: string, returnId: string, labelId: string): string => `${prefix}/sales/returns/label?return=${encodeURIComponent(returnId)}&label=${encodeURIComponent(labelId)}`

/** The labels still waiting for the goods (offered or booked), first; then the used and withdrawn ones. */
export function sortedLabels(rows: readonly ReturnLabelRow[]): ReturnLabelRow[] {
  const live = (row: ReturnLabelRow) => (row.status === 'OFFERED' || row.status === 'BOOKED' ? 0 : 1)
  return [...rows].sort((a, b) => live(a) - live(b) || b.createdAt.localeCompare(a.createdAt))
}
