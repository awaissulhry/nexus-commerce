import { useT } from '../../../lib/i18n/provider'

/**
 * owb-po5 — the order page's own new words (`messages/{en,it}/portal-order-page.json`: the request's frame, the quiet lines before
 * Confirm, Asks & changes, All changes, the notice, the factory designer's card, Take it back, the picture). The portal reads "voi"
 * in Italian; the customer reads "The factory", never a worker. Pages that draw them load the namespace (WithMessages).
 */
export const ORDER_PAGE_NS = 'portal-order-page'

export const usePageWords = () => useT(ORDER_PAGE_NS)
