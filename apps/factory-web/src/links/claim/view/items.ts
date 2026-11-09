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
    item.order ? t('item.order', { number: item.order.number }) : null,
    item.deliveredOn ? t('item.delivered', { day: formatDate(item.deliveredOn, place) }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
