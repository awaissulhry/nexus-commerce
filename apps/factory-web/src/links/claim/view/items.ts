import { formatDate } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import type { ClaimItem } from '../api'

/**
 * An item of the shipment or order in this page's words: the style's name (the order line's own words when it has no
 * style), then its colour, size, order and delivery day. The API's `description` speaks English ("size M"), so it is
 * shown only for a line without a style. Never a price.
 */
export function itemTitle(item: ClaimItem | null, t: Translate): string {
  if (!item) return t('item.unknown')
  return item.style?.name ?? item.description
}

export function itemFacts(item: ClaimItem, t: Translate, place: { locale: Locale; timeZone?: string }): string {
  return [
    item.style ? item.colourway?.name : null,
    item.style && item.size ? t('item.size', { size: item.size }) : null,
    // follow-up (th9-web-b; plan §0.5): their own order number, else their PO — never the office series.
    item.order?.yourNumber ? t('item.order', { seq: item.order.yourNumber.seq }) : item.order?.yourRef ? t('item.orderRef', { ref: item.order.yourRef }) : null,
    item.deliveredOn ? t('item.delivered', { day: formatDate(item.deliveredOn, place) }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
