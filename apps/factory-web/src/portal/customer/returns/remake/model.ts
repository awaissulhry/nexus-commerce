import { REMAKE_LIMITS } from '@nexus/factory-domain/sales/returns-outcomes/rules'
import type { ReturnableItem, ReturnableRead } from '../api'
import type { StartDraft } from '../model'

/**
 * SCR-187 › "Start a return or claim" › A remake (B-W2b-346; SAL-298; design portal.customer.returns "the same forms as
 * links.claim", links.claim "Remake (made-to-measure fit): what is wrong with the fit + front and back photos"; follow-up
 * RX2:02). The start's third choice: ONE item of what we delivered that may come back (one piece), its serial, what is wrong
 * with the fit (needed), your reference; check and send to `POST /portal/returns/remake` (a return request the office
 * authorises). As every case of the portal, the photos (the front and the back) are added on the request's Request tab once
 * it exists; the end says so. Problems are keys of this step's catalogue `returns-remake` (portal.problem.*). Pure.
 */

export const REMAKE_START = 'REMAKE' as const

export const REMAKE_FIT_MAX = REMAKE_LIMITS.fit
const SERIAL_MAX = 60
const REF_MAX = 80

/** The items a remake may name: what may still come back. */
export const remakeChoices = (read: Pick<ReturnableRead, 'items'>): ReturnableItem[] => read.items.filter((item) => item.canReturn > 0)

/** The problems of a remake draft at its fields (`remakeItem`, `serial`, `fit`, `customerRef`), as `returns-remake` keys. */
export function remakeStartProblems(draft: Pick<StartDraft, 'remakeKey' | 'serial' | 'fit' | 'customerRef'>, read: Pick<ReturnableRead, 'items'> | null): Record<string, string> {
  const problems: Record<string, string> = {}
  const item = read?.items.find((entry) => entry.key === draft.remakeKey)
  if (!draft.remakeKey) problems.remakeItem = read && remakeChoices(read).length === 0 ? 'portal.problem.nothing' : 'portal.problem.item'
  else if (read && (!item || item.canReturn < 1)) problems.remakeItem = 'portal.problem.itemGone'
  if (draft.serial.trim().length > SERIAL_MAX) problems.serial = 'portal.problem.long'
  if (draft.fit.trim() === '') problems.fit = 'portal.problem.fit'
  else if (draft.fit.trim().length > REMAKE_FIT_MAX) problems.fit = 'portal.problem.long'
  if (draft.customerRef.trim().length > REF_MAX) problems.customerRef = 'portal.problem.long'
  return problems
}

export interface RemakeBody {
  lines: Array<{ invoiceLineId: string | null; salesOrderLineId: string | null; size: string | null; quantity: number; serial: string | null }>
  fit: string
  customerRef: string | null
}

const orNull = (text: string): string | null => (text.trim() === '' ? null : text.trim())

/** What `POST /portal/returns/remake` takes from the draft. */
export function remakeBodyOf(draft: Pick<StartDraft, 'remakeKey' | 'serial' | 'fit' | 'customerRef'>, read: Pick<ReturnableRead, 'items'>): RemakeBody {
  const item = read.items.find((entry) => entry.key === draft.remakeKey)
  return {
    lines: item ? [{ invoiceLineId: item.invoiceLineId, salesOrderLineId: item.salesOrderLineId, size: item.size, quantity: 1, serial: orNull(draft.serial) }] : [],
    fit: draft.fit.trim(),
    customerRef: orNull(draft.customerRef),
  }
}

/** The draft holds a remake's typed work. */
export const remakeDirty = (draft: Pick<StartDraft, 'remakeKey' | 'fit'>): boolean => draft.remakeKey !== '' || draft.fit.trim() !== ''
