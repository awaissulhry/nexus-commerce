import { formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { PortalBand } from '../../shell/frame'
import { templateHref, type NoticePage } from './api'
import { listHref, newHref, noticeHref, orderHref, stateTone, type Translate } from './model'

/**
 * The frame's band of each Ship notices page (design portal.supplier.asn h: title, AsOf, "Announce delivery" primary, ⋯
 * "Download packing list template" and the frame's "Ask a question"): one builder per page, used by the live page and its
 * design cases alike. At most two actions, the primary last.
 */

const template = (t: Translate, locale: Locale) => ({ id: 'template', label: t('band.template'), href: templateHref('xlsx', locale), target: '_blank' as const })
const stepKeys = (t: Translate) => [{ keys: ['←', '→'], words: t('keys.steps') }]

export function listBandOf(input: { t: Translate; locale: Locale; asOf: string | null; prefix: string; announceHeld: string | null }): PortalBand {
  const { t, locale } = input
  return {
    title: t('list.title'),
    status: input.asOf ? { label: t('band.updated', { time: formatTime(input.asOf, { locale }) }), tone: 'neutral' } : null,
    actions: [{ id: 'announce', label: t('band.announce'), variant: 'primary', href: newHref(input.prefix), heldReason: input.announceHeld }],
    more: [template(t, locale)],
    keys: [
      { keys: ['/'], words: t('keys.search') },
      { keys: ['↵'], words: t('keys.open') },
      { keys: ['j', 'k'], words: t('keys.rows') },
    ],
  }
}

/** A new notice (step 1 before the draft exists). */
export function newBandOf(input: { t: Translate; locale: Locale; prefix: string; order: { id: string; number: string } | null }): PortalBand {
  const { t, locale } = input
  return {
    title: t('announce.title'),
    back: { href: listHref(input.prefix), label: t('list.title') },
    refs: input.order ? { ours: input.order.number } : null,
    more: [template(t, locale), ...(input.order ? [{ id: 'order', label: t('band.order', { number: input.order.number }), href: orderHref(input.prefix, input.order.id) }] : [])],
    ...(input.order ? { ask: { type: 'PurchaseOrder', id: input.order.id, label: input.order.number } } : {}),
    keys: stepKeys(t),
  }
}

/** A notice: a draft on its steps, a sent one being changed, or any notice as it stands. */
export function noticeBandOf(input: {
  t: Translate
  locale: Locale
  prefix: string
  page: NoticePage
  /** The steps are open (a draft always; a sent notice while it is changed). */
  stepping: boolean
  /** Why "Change" and "Cancel" wait (a key's words), or null. */
  changeHeld: string | null
  onCancel?: () => void
}): PortalBand {
  const held = input.changeHeld
  const { t, locale, page, prefix } = input
  const notice = page.notice
  const draft = notice.status === 'DRAFT'
  const sent = notice.status === 'SENT'
  const title = draft ? t('announce.title') : input.stepping ? t('change.title', { number: notice.number ?? '' }) : t('notice.title', { number: notice.number ?? '' })
  const back = input.stepping && !draft ? { href: noticeHref(prefix, notice.id), label: t('notice.title', { number: notice.number ?? '' }) } : { href: listHref(prefix), label: t('list.title') }
  return {
    title,
    back,
    // Their reference first; ours is the order the delivery is for (the title names the notice).
    refs: { theirs: notice.supplierRef, ours: notice.purchaseOrder.number },
    status: { label: t(`state.${notice.state}`), tone: stateTone(notice.state) },
    actions: sent && !input.stepping ? [{ id: 'change', label: t('band.change'), variant: 'primary', href: noticeHref(prefix, notice.id, 'lines'), heldReason: held }] : [],
    more: [
      ...(draft || sent ? [{ id: 'cancel', label: draft ? t('band.discard') : t('band.cancel'), disabled: held !== null, description: held ?? undefined, onSelect: () => input.onCancel?.() }] : []),
      { id: 'order', label: t('band.order', { number: notice.purchaseOrder.number }), href: orderHref(prefix, notice.purchaseOrder.id) },
      template(t, locale),
    ],
    ask: { type: 'PurchaseOrder', id: notice.purchaseOrder.id, label: notice.purchaseOrder.number },
    keys: input.stepping ? stepKeys(t) : [],
  }
}
