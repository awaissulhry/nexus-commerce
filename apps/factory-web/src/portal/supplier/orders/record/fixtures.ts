import type { LineDraft } from '@nexus/ui/patterns/LineResponseList/index'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Locale } from '../../../../lib/i18n/locales'
import { orderBandOf } from '../band'
import { confirmedPage, LINES, NOTICES, orderPage, PREFIX, proposedPage, revisedPage, shellOf, threadOf, TODAY, words, dayAt } from '../design-data'
import type { OrderPage } from '../api'
import type { RecordTab } from '../model'
import { SupplierCase, type SupplierCaseBuilder } from '../view/SupplierCase'
import type { OrderRecordViewModel } from '../view/OrderRecordView'

/**
 * SCR-189 › one purchase order (design portal.supplier.orders rec "Purchase order"; B-W2b-179; B-TH-277 tabs 5 → 3), MADE-UP data
 * only: the three tabs (Lines with "What changed in version 2" and the order as sent, Confirm or propose with LineResponseList,
 * what we ask for and "Answers so far", Ship notices with each DDT), the PO's conversation docked beside every tab at 1440 (the
 * portal record frame; price talk lives there, C2) and on a phone behind "Messages (2 new)" or open full width, the pop-ups
 * (Answer line 20 is the DS part's own sheet, Decline, What changed, Confirm all as asked), every end and refusal, an office
 * preview and a colleague who may not approve. Never a customer's or a brand's name (WALL-G18).
 */

const NO_ANSWERS: Record<string, LineDraft> = {}
const ANSWERS: Record<string, LineDraft> = {
  [LINES[1]!.id]: { kind: 'OTHER', quantity: '', date: dayAt(17), reason: 'Il colore Grigio arriva dal fornitore la settimana prossima.' },
  [LINES[2]!.id]: { kind: 'SUBSTITUTE', quantity: '', date: '', substituteId: '0190f0e2-7777-7000-8000-000000000031', substitute: '', reason: '' },
}

function recordModel(page: OrderPage | null, over: Partial<OrderRecordViewModel> = {}): OrderRecordViewModel {
  return {
    state: 'ready',
    page,
    tab: 'lines',
    prefix: PREFIX,
    today: TODAY,
    highlight: null,
    draft: { answers: NO_ANSWERS, supplierRef: '', note: '' },
    facts: { preview: false, offline: false },
    busy: false,
    problem: null,
    done: null,
    changesOpen: false,
    notices: { state: 'ready', items: [...NOTICES] },
    requests: [],
    dialog: null,
    ...over,
  }
}

type Frame = { mode: 'docked' | 'stacked'; viewOpen?: boolean; newCount?: number }
function recordCase(page: OrderPage, tab: RecordTab, over: (locale: Locale) => Partial<OrderRecordViewModel> = () => ({}), shell: { preview?: boolean; frame?: Frame } = {}): SupplierCaseBuilder {
  return (locale) => {
    const t = words(locale)
    const model = recordModel(page, { tab, ...over(locale) })
    const held = shell.preview ? t('held.preview') : page.answer.mayAnswer ? null : t('held.mayAnswer')
    return {
      shell: shellOf(locale, { path: `/orders/${page.order.id}`, preview: shell.preview ?? false, band: orderBandOf({ t, locale, page, tab, prefix: PREFIX, done: model.done !== null, confirmHeld: held, notices: model.notices.state === 'ready' ? model.notices.items.length : null }) }),
      // B-TH-277: the PO's conversation docks beside every tab (no Messages tab).
      body: { kind: 'record', model, thread: threadOf(locale), ...(shell.frame ? { frame: shell.frame } : {}) },
    }
  }
}

const OPEN = orderPage()
const REVISED = revisedPage()

export const designScreen = defineDesignScreen<SupplierCaseBuilder>({
  screen: 'SCR-189-record',
  title: 'Supplier purchase order (portal.supplier.orders › record)',
  view: SupplierCase,
  cases: [
    { id: 'lines', label: 'Lines', model: recordCase(OPEN, 'lines'), note: 'Every line in the supplier’s terms: their code first, our description, colour, the leather facts (grade, thickness, one dye batch, ± area, hides), the Cr VI report; no price.' },
    { id: 'lines-revised', label: 'Lines of version 2 (What changed open)', model: recordCase(REVISED, 'lines', () => ({ changesOpen: true })), note: 'Open by itself on the first visit after a revision; “was 1.200 ft²” beside a changed value.' },
    { id: 'lines-confirmed', label: 'Lines of a confirmed order, part received', model: recordCase(confirmedPage(), 'lines') },
    { id: 'confirm', label: 'Confirm or propose', model: recordCase(OPEN, 'confirm'), note: 'Confirm all as asked in one tap, or a line’s Change (the DS sheet: other date or quantity, two deliveries, cannot deliver, a substitute from the articles offered or in words, a change that needs the buyer’s yes).' },
    { id: 'confirm-answered', label: 'An answer line by line, ready to send', model: recordCase(OPEN, 'confirm', () => ({ draft: { answers: ANSWERS, supplierRef: 'CP-OC-401', note: '' } })), note: '“1 line as asked · 1 later date · 1 substitute”: the line as asked is confirmed at once, the changes wait for the buyer.' },
    { id: 'confirm-sending', label: 'Sending', model: recordCase(OPEN, 'confirm', () => ({ busy: true, draft: { answers: ANSWERS, supplierRef: '', note: '' } })) },
    { id: 'confirm-changed', label: 'Refused: the order changed meanwhile', model: recordCase(OPEN, 'confirm', () => ({ problem: 'changed', draft: { answers: ANSWERS, supplierRef: '', note: '' } })) },
    { id: 'confirm-no-approve', label: 'A colleague who may not approve', model: recordCase(orderPage({ answer: { mayAnswer: false } }), 'confirm'), note: 'Send and Decline held with “ask your admin”; the lines read only.' },
    { id: 'confirm-preview', label: 'An office preview', model: recordCase(OPEN, 'confirm', () => ({ facts: { preview: true, offline: false } }), { preview: true }) },
    { id: 'confirm-offline', label: 'Offline', model: recordCase(OPEN, 'confirm', () => ({ facts: { preview: false, offline: true }, draft: { answers: ANSWERS, supplierRef: '', note: '' } })), note: 'Send held with “No connection”; what was typed stays.' },
    { id: 'done-confirmed', label: 'Confirmed — the end', model: recordCase(confirmedPage(), 'confirm', () => ({ done: { outcome: 'CONFIRMED', summary: null, supplierRef: 'CP-OC-401' } })) },
    { id: 'done-proposed', label: 'Sent to the buyer — the end', model: recordCase(proposedPage(), 'confirm', (locale) => ({ done: { outcome: 'PROPOSED', summary: locale === 'it' ? '1 riga come richiesto · 1 data più tardi · 1 sostituto' : '1 line as asked · 1 later date · 1 substitute', supplierRef: 'CP-OC-401' } })) },
    { id: 'proposed', label: 'Change proposed, waiting for the buyer', model: recordCase(proposedPage(), 'confirm'), note: 'What was proposed, read only; Answers so far.' },
    { id: 'proposed-refused', label: 'The buyer refused the changes', model: recordCase(proposedPage('REFUSED'), 'confirm') },
    { id: 'confirmed', label: 'A confirmed order', model: recordCase(confirmedPage(), 'confirm'), note: 'The lines are locked: to ask for a change, write in the docked conversation (the API takes no new proposal on a confirmed order: named in the notes).' },
    // B-W2b-186: "Announce delivery" opens the new ship notice from this order.
    { id: 'asn', label: 'Ship notices', model: recordCase(confirmedPage(), 'asn', () => ({ announce: { href: `${PREFIX}/deliveries/new?po=${confirmedPage().order.id}`, heldReason: null } })) },
    { id: 'asn-empty', label: 'No delivery announced yet', model: recordCase(confirmedPage(), 'asn', () => ({ notices: { state: 'ready', items: [] }, announce: { href: `${PREFIX}/deliveries/new?po=${confirmedPage().order.id}`, heldReason: null } })) },
    { id: 'asn-no-access', label: 'Ship notices not part of the access', model: recordCase(confirmedPage(), 'asn', () => ({ notices: { state: 'noAccess', items: [] } })) },
    { id: 'asn-error', label: 'Ship notices could not be read', model: recordCase(confirmedPage(), 'asn', () => ({ notices: { state: 'error', items: [] } })) },
    // B-TH-277: what the Documents tab held — what we ask for now on Confirm or propose; the order as sent on Lines and in ⋯.
    { id: 'confirmed-asks', label: 'A confirmed order with what we ask for', model: recordCase(confirmedPage(), 'confirm', (locale) => ({ requests: [{ id: 's3', title: locale === 'it' ? 'Carica il rapporto Cr VI del bagno 2231' : 'Upload the Cr VI report of batch 2231', verb: locale === 'it' ? 'Carica' : 'Upload', href: `${PREFIX}/open/PurchaseOrder/x#task:s3` }] })), note: 'What the old Documents tab listed: our asks here; the order as sent (price-free PDF) under Lines’ facts and in ⋯; each DDT on its ship notice’s row. The mailed PDF with prices is only in the conversation (C2).' },
    { id: 'phone', label: 'Phone: Confirm or propose, Messages (2 new)', model: recordCase(OPEN, 'confirm', () => ({}), { frame: { mode: 'stacked', newCount: 2 } }), note: 'Under 1280 px the body leads; “Messages (2 new)” opens the PO’s conversation full width (Back returns to the same tab and scroll).' },
    { id: 'phone-messages', label: 'Phone: the conversation open', model: recordCase(OPEN, 'lines', () => ({}), { frame: { mode: 'stacked', viewOpen: true } }), note: 'The conversation full width with Back; the price-talk line above it.' },
    {
      id: 'confirm-all',
      label: 'Pop-up: Confirm all as asked',
      model: recordCase(OPEN, 'confirm', () => ({ dialog: { kind: 'confirmAll', model: { orders: [{ id: OPEN.order.id, documentNumber: OPEN.order.documentNumber, lines: OPEN.lines, lineCount: 3 }], supplierRef: '', person: 'Luca Prova', busy: false, heldReason: null, problem: null } } })),
    },
    { id: 'decline', label: 'Pop-up: Decline', model: recordCase(OPEN, 'confirm', () => ({ dialog: { kind: 'decline', model: { documentNumber: OPEN.order.documentNumber, reasons: OPEN.answer.declineReasons, draft: { reason: 'NO_CAPACITY', note: '', tried: false }, busy: false, heldReason: null, problem: null } } })) },
    { id: 'decline-held', label: 'Pop-up: Decline for another reason, no words yet', model: recordCase(OPEN, 'confirm', () => ({ dialog: { kind: 'decline', model: { documentNumber: OPEN.order.documentNumber, reasons: OPEN.answer.declineReasons, draft: { reason: 'OTHER', note: '', tried: true }, busy: false, heldReason: 'decline.held.note', problem: null } } })) },
    { id: 'decline-price', label: 'Pop-up: Decline for the price', model: recordCase(OPEN, 'confirm', () => ({ dialog: { kind: 'decline', model: { documentNumber: OPEN.order.documentNumber, reasons: OPEN.answer.declineReasons, draft: { reason: 'PRICE', note: '', tried: false }, busy: false, heldReason: null, problem: null } } })), note: 'Price talk goes to Messages, never on this page.' },
    { id: 'version', label: 'Pop-up: What changed in version 2', model: recordCase(REVISED, 'lines', () => ({ dialog: { kind: 'version', model: { revision: 2, state: 'ready', changes: REVISED.changes } } })) },
    { id: 'loading', label: 'Loading', model: (locale) => ({ shell: shellOf(locale, { path: '/orders/x', band: { title: words(locale)('list.title') } }), body: { kind: 'record', model: recordModel(null, { state: 'loading' }), thread: null } }) },
    { id: 'error', label: 'The order could not be read', model: (locale) => ({ shell: shellOf(locale, { path: '/orders/x', band: { title: words(locale)('list.title') } }), body: { kind: 'record', model: recordModel(null, { state: 'error' }), thread: null } }) },
    { id: 'missing', label: 'Not one of theirs', model: (locale) => ({ shell: shellOf(locale, { path: '/orders/x', band: { title: words(locale)('record.missing') } }), body: { kind: 'record', model: recordModel(null, { state: 'missing' }), thread: null } }), note: 'Another party’s order answers like one that does not exist.' },
  ],
})
