import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Notice, NoticePage } from '../api'
import { noticeBandOf } from '../band'
import { at, HIDES, leatherLine, liningLine, noticePage, PREFIX, shellOf, words } from '../design-data'
import { DeliveriesCase, type DeliveriesCaseBuilder } from '../view/DeliveriesCase'
import type { CancelModel } from '../view/Dialogs'
import type { NoticeViewModel } from '../view/NoticeView'

/**
 * SCR-227 › one ship notice (design portal.supplier.asn sec:asn-grid "Row → ship notice view; editable until received", live
 * "Received / Received with differences with the lines that differ", pop:cancel-asn, pop:row-detail; B-W2b-186), MADE-UP
 * data only: in transit, announced, received, received with differences, cancelled, the cancel pop-up, a hide's detail, a
 * colleague who may only read, loading, error, a notice that is not here.
 */

function noticeCase(build: (locale: Locale) => { page?: NoticePage; over?: Partial<NoticeViewModel>; held?: string | null }): DeliveriesCaseBuilder {
  return (locale) => {
    const t = words(locale)
    const { page = noticePage(), over = {}, held = null } = build(locale)
    const view: NoticeViewModel = { state: 'ready', page, prefix: PREFIX, dialog: null, problem: null, ...over }
    return { shell: shellOf(locale, { band: noticeBandOf({ t, locale, prefix: PREFIX, page, stepping: false, changeHeld: held ? t(held) : null }) }), body: { kind: 'notice', model: view } }
  }
}

const received = (differs: boolean): Partial<Notice> => {
  const leather = leatherLine(HIDES.slice(0, 4), { receivedQuantity: differs ? '80.5000' : '84.1000', quantity: '84.1000', verdict: 'CHECK' })
  const lining = liningLine({ receivedQuantity: '150.0000' })
  return { status: 'RECEIVED', state: differs ? 'RECEIVED_WITH_DIFFERENCES' : 'RECEIVED', receivedAt: at(-2), lines: [leather, lining], differing: differs ? [leather.id] : [], verdict: 'CHECK' }
}

const cancelOf = (page: NoticePage, over: Partial<CancelModel> = {}): CancelModel => ({
  target: { id: page.notice.id, number: page.notice.number, status: page.notice.status, version: page.notice.version, orderNumber: page.notice.purchaseOrder.number },
  reason: '',
  busy: false,
  heldReason: 'cancel.held.reason',
  problem: null,
  ...over,
})

export const designScreen = defineDesignScreen<DeliveriesCaseBuilder>({
  screen: 'SCR-227-notice',
  title: 'Supplier Ship notices › one ship notice (portal.supplier.asn)',
  view: DeliveriesCase,
  cases: [
    { id: 'in-transit', label: 'In transit', model: noticeCase(() => ({})), note: 'The terms, the lines with their checks, the packing list per hide with its verdicts (Enter opens a hide’s detail). Band: Change (editable until received); ⋯ Cancel this ship notice…, the order, the template, Ask a question.' },
    { id: 'announced', label: 'Announced (ships later)', model: noticeCase(() => ({ page: noticePage({}, { state: 'ANNOUNCED' }) })) },
    { id: 'received', label: 'Received as announced', model: noticeCase(() => ({ page: noticePage({ canEdit: false, canCancel: false }, received(false)) })) },
    { id: 'received-differences', label: 'Received with differences', model: noticeCase(() => ({ page: noticePage({ canEdit: false, canCancel: false }, received(true)) })), note: 'The line that differs: announced and received side by side.' },
    { id: 'cancelled', label: 'Cancelled', model: noticeCase(() => ({ page: noticePage({ canEdit: false, canCancel: false }, { status: 'CANCELLED', state: 'CANCELLED', cancelledAt: at(-5), cancelReason: 'Il vettore ha annullato il ritiro.' }) })) },
    { id: 'cancel', label: 'Pop-up: Cancel this ship notice?', model: noticeCase(() => ({ over: { dialog: cancelOf(noticePage()) } })), note: '“The lines become open again.” The reason is asked (our dock reads it); Esc keeps it.' },
    { id: 'row-detail', label: 'Pop-up: Hide 2231-017', model: noticeCase(() => ({ over: { openHide: HIDES[4]!.id } })) },
    { id: 'viewer', label: 'A colleague who may only read', model: noticeCase(() => ({ page: noticePage({ mayWrite: false, canEdit: false, canCancel: false }), held: 'held.mayWrite' })), note: 'Change and Cancel are held with the reason.' },
    { id: 'refused', label: 'A change refused', model: noticeCase(() => ({ over: { problem: 'forbidden' } })) },
    { id: 'loading', label: 'Loading', model: noticeCase(() => ({ over: { state: 'loading', page: null } })) },
    { id: 'error', label: 'The notice could not be read', model: noticeCase(() => ({ over: { state: 'error', page: null } })) },
    { id: 'missing', label: 'Not here (discarded, or another organisation’s)', model: noticeCase(() => ({ over: { state: 'missing', page: null } })) },
  ],
})
