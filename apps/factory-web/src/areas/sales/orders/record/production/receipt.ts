import { isApiError, issuePath } from '../../../../../lib/api/errors'
import type { SiteOption } from '../../../../_shared/buying/api'
import type { Order } from '../../api'
import { writeProblem, type Phrase } from '../../model'
import type { CustomerReceiptBody } from './api'
import type { CustomerGood } from './materials'
import type { Part } from '../record-model'

/**
 * F-PT-304 (order PRODUCTION tab, 10-design §9 D3; plan §1–§2 "Customer goods can be recorded from the web") — "Record what the
 * customer sent · SO-…", without a screen: the site and the place the goods go, the customer's delivery note (number and day) and one
 * line per material still to come, pre-filled with what is still to come, with their lot reference. Leather received hide by hide is
 * not a customer receipt (the server refuses it: a customer's material is received as lots): it is said in words BEFORE the receipt
 * is sent and left out of it. The command is the existing one (POST /inventory/receipts/customer, inventory.receive).
 */

export interface ReceiptLine {
  readonly key: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly label: string
  readonly uom: string
  readonly quantity: string
  readonly lot: string
  readonly take: boolean
}

export interface ReceiptDraft {
  readonly siteId: string | null
  readonly locationId: string | null
  readonly ddtNumber: string
  readonly ddtDate: string
  readonly lines: readonly ReceiptLine[]
}

/** The dialog as the page draws it (use-customer-receipt holds it): the draft, the sites read, each material's tracking. */
export interface ReceiptModel {
  readonly draft: ReceiptDraft
  readonly sites: Part<SiteOption[]>
  /** Each material's tracking as read (HIDE: leather by the hide — said, left out); a material not read: not known. */
  readonly tracking: ReadonlyMap<string, string>
  readonly busy: boolean
  readonly problem: Phrase | null
  readonly held: Phrase | null
}

export interface ReceiptActions {
  readonly onOpen: (only: string | null) => void
  readonly onDraft: (patch: Partial<Pick<ReceiptDraft, 'siteId' | 'locationId' | 'ddtNumber' | 'ddtDate'>>) => void
  readonly onLine: (key: string, patch: Partial<Pick<ReceiptLine, 'quantity' | 'lot' | 'take'>>) => void
  readonly onSubmit: () => void
  readonly onClose: () => void
}

/** The places goods are received into: the goods-in dock first, then the stores (never outside, transit, finished goods or quality). */
export const RECEIVE_KINDS = ['RECEIVING', 'WAREHOUSE', 'ZONE', 'BIN', 'BULK', 'PICK_FACE'] as const
export function receivePlacesOf(site: SiteOption | null | undefined): SiteOption['locations'] {
  const order = (kind: string) => (RECEIVE_KINDS as readonly string[]).indexOf(kind)
  return (site?.locations ?? []).filter((place) => place.status === 'ACTIVE' && order(place.kind) >= 0).sort((a, b) => order(a.kind) - order(b.kind) || a.code.localeCompare(b.code))
}

const qty = (value: number): string => (Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4))))

/**
 * The draft: every material still to come (pre-filled with what is still to come), or — opened from one material's row — that one;
 * nothing still to come (recorded in full): every material, empty, for an extra delivery. The first site and its goods-in dock.
 */
export function receiptDraftOf(goods: readonly CustomerGood[], only: string | null, sites: readonly SiteOption[] | null): ReceiptDraft {
  const toCome = goods.filter((good) => good.toCome > 0)
  const shown = only ? goods.filter((good) => good.id === only) : toCome.length > 0 ? toCome : goods
  const site = sites?.length === 1 ? sites[0]! : null
  return {
    siteId: site?.id ?? null,
    locationId: receivePlacesOf(site)[0]?.id ?? null,
    ddtNumber: '',
    ddtDate: '',
    lines: shown.map((good) => ({
      key: good.id,
      itemId: good.itemId,
      itemColourId: good.itemColourId,
      label: [good.item, good.colour].filter(Boolean).join(' · '),
      uom: good.uom,
      quantity: good.toCome > 0 ? qty(good.toCome) : '',
      lot: '',
      take: good.toCome > 0 || !!only,
    })),
  }
}

/** Leather received hide by hide (its material's tracking): not a customer receipt — said, and left out. */
export const isHide = (tracking: ReadonlyMap<string, string>, line: Pick<ReceiptLine, 'itemId'>): boolean => tracking.get(line.itemId) === 'HIDE'

/** A quantity above 0 with at most 4 decimals ("12", "12,5", "0.25"), as the server takes it. */
const QUANTITY = /^\d{1,12}(?:[.,]\d{1,4})?$/
export const quantityOk = (value: string): boolean => QUANTITY.test(value.trim()) && Number(value.trim().replace(',', '.')) > 0

/** The lines the receipt sends: taken, not leather by the hide. */
export const sentLinesOf = (draft: ReceiptDraft, tracking: ReadonlyMap<string, string>): ReceiptLine[] => draft.lines.filter((line) => line.take && !isHide(tracking, line))

/** Why Record the receipt waits, in words: the site, the place, a line to send, a quantity it can take; a write running. */
export function receiptHeldOf(draft: ReceiptDraft, tracking: ReadonlyMap<string, string>, busy: boolean): Phrase | null {
  if (busy) return { key: 'held.busy' }
  if (!draft.siteId) return { key: 'productionTab.receipt.held.site' }
  if (!draft.locationId) return { key: 'productionTab.receipt.held.place' }
  const sent = sentLinesOf(draft, tracking)
  if (sent.length === 0) return { key: 'productionTab.receipt.held.nothing' }
  if (sent.some((line) => !quantityOk(line.quantity))) return { key: 'productionTab.receipt.held.quantity' }
  return null
}

export function receiptBodyOf(order: Pick<Order, 'id' | 'partyId'>, draft: ReceiptDraft, tracking: ReadonlyMap<string, string>): CustomerReceiptBody | null {
  if (!draft.siteId || !draft.locationId) return null
  return {
    siteId: draft.siteId,
    partyId: order.partyId,
    orderId: order.id,
    locationId: draft.locationId,
    supplierDdtNumber: draft.ddtNumber.trim() || null,
    supplierDdtDate: draft.ddtDate || null,
    lines: sentLinesOf(draft, tracking).map((line) => ({ itemId: line.itemId, itemColourId: line.itemColourId, quantity: line.quantity.trim().replace(',', '.'), supplierLotRef: line.lot.trim() || null })),
  }
}

/**
 * A refused receipt in this app's words (never the API's English): a line's material tracked hide by hide or not by lot (the line
 * named), a quantity, a place that takes no stock, no right at the site; else the page's own write words.
 */
export function receiptRefusalOf(error: unknown, sent: readonly Pick<ReceiptLine, 'label'>[]): Phrase {
  if (isApiError(error)) {
    for (const issue of error.issues) {
      const path = issuePath(issue)
      const line = /^body[./]lines[./](\d+)[./](\w+)/.exec(path)
      const label = line ? (sent[Number(line[1])]?.label ?? '—') : null
      if (line && line[2] === 'itemId' && /hide/i.test(issue.message ?? '')) return { key: 'productionTab.receipt.refused.hide', params: { material: label! } }
      if (line && line[2] === 'itemId') return { key: 'productionTab.receipt.refused.lot', params: { material: label! } }
      if (line && line[2] === 'quantity') return { key: 'productionTab.receipt.refused.quantity', params: { material: label! } }
      if (/toLocationId|locationId/.test(path)) return { key: 'productionTab.receipt.refused.place' }
    }
    if (error.kind === 'forbidden') return { key: 'productionTab.receipt.refused.right' }
  }
  return { key: writeProblem(error).key }
}
