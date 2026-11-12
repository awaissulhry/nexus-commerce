import { REMAKE_LIMITS, REMAKE_PHOTOS } from '@nexus/factory-domain/sales/returns-outcomes/rules'
import type { ClaimItem, ClaimPage, ClaimType } from '../../api'
import type { ClaimForm, Problem } from '../../model'

/**
 * SCR-197 › Remake (B-W2b-346; SAL-298 "Remake request with photos"; design links.claim sec:type "Remake (made-to-measure
 * fit)", sec:details "Remake: what is wrong with the fit + front and back photos"; follow-up RX2:01). The remake rides the
 * claim page's five steps and its draft: ONE item of the shipment or order (one piece; the serial scanned or typed), what
 * is wrong with the fit (needed), the front and back photos (both needed: the send is held until they are there), check
 * and send to `POST /link/claim/remake`. It makes a return request (an RMA the office authorises) of that item; the
 * photos go onto its line after the send, as a return's do. Its words live in this step's catalogue `returns-remake`
 * (`returns-remake:claim.*`, through the page's scoped translator); the page's own keys stay `link-claim`'s. Pure.
 */

export const REMAKE: ClaimType = 'REMAKE'

/** The photos a remake needs on its item: the front and the back, in this order. */
export const REMAKE_PHOTOS_NEEDED = REMAKE_PHOTOS.length

export const REMAKE_FIT_MAX = REMAKE_LIMITS.fit

/** The words of this step on the claim page (namespaced keys for the page's scoped translator). */
export const REMAKE_KEYS = Object.freeze({
  typeTitle: 'returns-remake:claim.type.title',
  typeBody: 'returns-remake:claim.type.body',
  typeNone: 'returns-remake:claim.type.none',
  later: 'returns-remake:claim.type.later',
  legend: 'returns-remake:claim.item.legend',
  send: 'returns-remake:claim.send',
  doneTitle: 'returns-remake:claim.done.title',
  doneNext: 'returns-remake:claim.done.next',
  checkItem: 'returns-remake:claim.check.item',
  checkFit: 'returns-remake:claim.check.fit',
  checkPhotos: 'returns-remake:claim.check.photos',
})

/** The page's word for a type's part (`type.<TYPE>.title` …), a remake's from this step's catalogue. */
export function typeKey(type: ClaimType | null, part: 'typeTitle' | 'typeBody' | 'send' | 'doneTitle' | 'doneNext'): string {
  const own = type ?? 'RETURN'
  if (own === 'REMAKE') return REMAKE_KEYS[part]
  switch (part) {
    case 'typeTitle':
      return `type.${own}.title`
    case 'typeBody':
      return `type.${own}.body`
    case 'send':
      return `send.button.${own}`
    case 'doneTitle':
      return `done.title.${own}`
    case 'doneNext':
      return `done.next.${own}`
  }
}

/** What the page offers: the API's types and, beside a return, a remake (a return of one item made again to fit). */
export const offeredTypes = (page: Pick<ClaimPage, 'types'>): ClaimType[] => [...page.types, ...(page.types.includes('RETURN') ? (['REMAKE'] as const) : [])]

/** The items a remake may name: what may still come back (one piece). */
export const remakeItems = (page: Pick<ClaimPage, 'items'>): ClaimItem[] => page.items.filter((item) => item.canReturn >= 1)

/** Choosing the item of a remake: the one pick (one piece), its serial kept when it is the same item. */
export function pickRemakeItem(form: ClaimForm, item: ClaimItem): ClaimForm {
  if (item.canReturn < 1) return form
  const same = form.picks.find((pick) => pick.key === item.key)
  return { ...form, picks: [{ key: item.key, quantity: 1, reasonCode: null, reasonNote: '', serial: same?.serial ?? '' }] }
}

const tooLong = (value: string, max: number): boolean => value.trim().length > max

/** A remake's own problems (the item, the serial's length, the fit), step by step; the photos are the page's check. */
export function remakeProblems(form: ClaimForm, page: Pick<ClaimPage, 'items'>, serialMax: number): Problem[] {
  const problems: Problem[] = []
  const pick = form.picks[0]
  const item = pick ? page.items.find((entry) => entry.key === pick.key) : undefined
  if (!pick || form.picks.length !== 1) problems.push({ step: 'item', field: 'items', key: remakeItems(page).length === 0 ? 'check.nothingBack' : REMAKE_KEYS.checkItem })
  else if (!item || item.canReturn < 1) problems.push({ step: 'item', field: 'items', key: 'check.itemGone' })
  else if (tooLong(pick.serial, serialMax)) problems.push({ step: 'item', field: `pick.${pick.key}.serial`, key: 'check.long', params: { max: serialMax } })
  if (form.fit.trim() === '') problems.push({ step: 'details', field: 'fit', key: REMAKE_KEYS.checkFit })
  else if (tooLong(form.fit, REMAKE_FIT_MAX)) problems.push({ step: 'details', field: 'fit', key: 'check.long', params: { max: REMAKE_FIT_MAX } })
  return problems
}

/** The body of `POST /link/claim/remake` (call it once the page's checks are empty). */
export function remakeBodyOf(form: ClaimForm, page: Pick<ClaimPage, 'items'>) {
  const trimmed = (value: string): string | null => (value.trim() === '' ? null : value.trim())
  return {
    type: 'REMAKE' as const,
    typedName: trimmed(form.typedName),
    lines: form.picks.flatMap((pick) => {
      const item = page.items.find((entry) => entry.key === pick.key)
      return item ? [{ invoiceLineId: item.invoiceLineId, salesOrderLineId: item.salesOrderLineId, size: item.size, quantity: 1, serial: trimmed(pick.serial) }] : []
    }),
    fit: form.fit.trim(),
    customerRef: trimmed(form.customerRef),
  }
}

/** The label of a remake's photo by its place: the first the front, the second the back, then plain numbers. */
export const remakePhotoKey = (index: number): string | null => (index === 0 ? 'returns-remake:claim.photos.front' : index === 1 ? 'returns-remake:claim.photos.back' : null)

/** The file name a remake's photo goes with ("RMA-…-front.jpg"). */
export const remakePhotoName = (number: string, index: number): string => `${number}-${index === 0 ? 'front' : index === 1 ? 'back' : String(index + 1)}.jpg`
