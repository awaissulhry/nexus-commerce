import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import { addressProblems, EMPTY_ADDRESS } from '../account/model'
import { templateHref } from './api'
import { newOrderBandOf, type NewOrderPhase } from './band'
import { ADDRESSES, at, catalogueRead, DRAFTS, draftRecord, LINE_TROUSERS, lineOf, orderingWords, PAST_ORDERS, pastOrder, PREFIX, shellOf, styleDetail, TODAY, uploadAnswer } from './design-data'
import { headerDraftOf, sendHeld } from './model'
import type { NewOrderViewModel } from './view/NewOrderView'
import { OrderingCase, type OrderingCaseBuilder } from './view/OrderingCase'

/**
 * SCR-185 › New order & reorder (design portal.customer.neworder: sec:start, sec:order-head, sec:lines, sec:reorder,
 * sec:upload, sec:summary, sec:sent; pop:style-picker, pop:new-address, pop:discard; tab:template (the band's ⋯ and the
 * upload's link), tab:style-sheet (case `style-sheet`); B-W2b-194), MADE-UP data only: the three ways in with and without
 * drafts, a draft with its lines and summary, its problems, prices that changed, a role without prices, the reorder of a
 * past order with every difference, the sheet's dry run, the pop-ups, the request sent, a request no longer a draft, a
 * draft gone, loading, a failed read, no connection, an office preview, and the page for a person without it.
 */

type Over = Partial<NewOrderViewModel>

function model(over: Over = {}): NewOrderViewModel {
  const record = over.record === undefined ? draftRecord() : over.record
  return {
    state: 'ready',
    phase: 'draft',
    prefix: PREFIX,
    today: TODAY,
    start: { state: 'ready', drafts: [], choosing: null, held: null },
    way: null,
    record,
    header: headerDraftOf(record?.request ?? null),
    headerErrors: {},
    save: { kind: 'saved', at: at(-1) },
    cells: {},
    notes: {},
    saving: [],
    writeHeld: null,
    addAddressHeld: null,
    reorder: null,
    upload: null,
    problem: null,
    stale: false,
    notice: null,
    sendHeld: null,
    showProblems: false,
    sent: null,
    closed: null,
    offlineSince: null,
    dialogs: { picker: null, address: null, discard: null },
    ...over,
  }
}

function held(locale: Locale, view: NewOrderViewModel): string | null {
  if (!view.record) return null
  const t = orderingWords(locale).t
  const reason = sendHeld(view.record.request, { preview: false, offline: view.offlineSince !== null, busy: false, emptyLine: false })
  return reason ? t(reason.key, reason.count !== undefined ? { count: reason.count } : undefined) : null
}

function page(build: (locale: Locale) => Over = () => ({}), phase: NewOrderPhase = 'draft'): OrderingCaseBuilder {
  return (locale) => {
    const words = orderingWords(locale)
    const over = build(locale)
    const base = model({ phase, ...over })
    const view = { ...base, sendHeld: over.sendHeld !== undefined ? over.sendHeld : held(locale, base) }
    const band = newOrderBandOf({
      words,
      phase: view.phase,
      prefix: PREFIX,
      template: templateHref(locale),
      customerRef: view.sent?.customerRef ?? view.record?.request.customerRef ?? null,
      number: view.sent?.number ?? null,
      sendHeld: view.sendHeld,
      discardHeld: view.writeHeld,
    })
    return { shell: shellOf(locale, band, '/orders/new'), body: { kind: 'neworder', model: view } }
  }
}

const start = (over: (locale: Locale) => Partial<NewOrderViewModel['start']> = () => ({})) => page((locale) => ({ record: null, start: { state: 'ready', drafts: [], choosing: null, held: null, ...over(locale) } }), 'start')

const problems = () => {
  const jacket = lineOf(1, {
    sizes: [
      { size: '48', quantity: 4, offered: true },
      { size: '50', quantity: 8, offered: true },
      { size: '62', quantity: 2, offered: false },
    ],
    problems: [
      { code: 'SIZE_NOT_OFFERED', lineId: '0194f0e2-1940-7000-8000-000000000301', size: '62' },
      { code: 'PRICE_CHANGED', lineId: '0194f0e2-1940-7000-8000-000000000301', size: null },
    ],
    unitPriceShown: '400.00',
    priceNow: '410.00',
    amount: '5600.00',
  })
  const trousers = LINE_TROUSERS()
  return draftRecord({ lines: [jacket, { ...trousers, colourway: { id: '0194f0e2-1940-7000-8000-000000000104', code: 'BRN', name: 'Marrone Esempio' }, problems: [{ code: 'COLOUR_DISCONTINUED', lineId: trousers.id, size: null }] }], request: { requestedDate: null } })
}

const reorderModel = (over: Partial<NonNullable<NewOrderViewModel['reorder']>> = {}): NonNullable<NewOrderViewModel['reorder']> => ({
  q: '',
  currency: 'EUR',
  orders: { state: 'ready', rows: PAST_ORDERS },
  order: null,
  selected: [],
  colours: {},
  busy: false,
  writeHeld: null,
  ...over,
})

const pickerModel = (over: Partial<NonNullable<NewOrderViewModel['dialogs']['picker']>> = {}): NonNullable<NewOrderViewModel['dialogs']['picker']> => ({
  step: 'styles',
  q: '',
  category: null,
  ppe: null,
  catalogue: { state: 'ready', read: catalogueRead() },
  selected: [],
  details: {},
  cells: {},
  onDraft: {},
  prefix: PREFIX,
  busy: false,
  problem: null,
  writeHeld: null,
  ...over,
})

const STYLE = '0194f0e2-1940-7000-8000-000000000001'

export const designScreen = defineDesignScreen<OrderingCaseBuilder>({
  screen: 'SCR-185',
  title: 'New order & reorder (portal.customer.neworder)',
  view: OrderingCase,
  cases: [
    { id: 'start', label: 'How do you want to order? (no drafts)', model: start(), note: 'Three ways in, one draft. A way makes the draft on the server; the address keeps it (?draft=).' },
    { id: 'start-drafts', label: 'Drafts to continue', model: start(() => ({ drafts: DRAFTS })), note: '“Continue your draft from … · 3 lines” (PressableRow).' },
    { id: 'start-loading', label: 'The drafts loading', model: start(() => ({ state: 'loading' })) },
    { id: 'start-error', label: 'The drafts could not be read', model: start(() => ({ state: 'error' })), note: 'Never drawn as no drafts: the problem in our words + Try again.' },
    { id: 'draft', label: 'A draft: order details, lines with the size grid, the summary', model: page(), note: 'Saved on leaving a field (SaveStatus); one size grid per line (stacked on a phone); the summary always in view.' },
    { id: 'draft-typed', label: 'Sizes typed, not saved yet', model: page(() => ({ cells: { '0194f0e2-1940-7000-8000-000000000301': { '48': 4, '50': 10, '52': 6, '54': 2 } }, save: { kind: 'saving' }, saving: ['0194f0e2-1940-7000-8000-000000000301'] })), note: 'Leaving the line saves it (PUT with the version).' },
    { id: 'draft-problems', label: 'Send held: problems — Show me', model: page(() => ({ record: problems(), showProblems: true })), note: 'A size not offered (on its cell), a discontinued colour (choose another), a price that changed; Send held with the count; Show me lists them.' },
    { id: 'draft-prices', label: 'Prices changed since you started', model: page(() => ({ record: draftRecord({ lines: [lineOf(1, { unitPriceShown: '400.00', priceNow: '410.00', problems: [{ code: 'PRICE_CHANGED', lineId: '0194f0e2-1940-7000-8000-000000000301', size: null }] }), LINE_TROUSERS()] }) })), note: 'Banner with “Take today’s prices”; the line says “Price now … (was …)”.' },
    { id: 'draft-empty', label: 'No lines yet', model: page(() => ({ record: draftRecord({ lines: [], request: { problems: [{ code: 'NO_LINES', lineId: null, size: null }] } }) })) },
    { id: 'draft-no-prices', label: 'A colleague without prices', model: page(() => ({ record: draftRecord({ seesPrices: false }) })), note: 'No unit price, amount or net anywhere; one quiet line “Prices are not part of your access”.' },
    { id: 'draft-waiting-address', label: 'Ship to a new address (waits for our check)', model: page(() => { const record = draftRecord({ request: { shipToAddressId: ADDRESSES[2]!.id } }); return { record, header: headerDraftOf(record.request) } }), note: 'The request can still be sent; we check the address when we confirm.' },
    { id: 'draft-not-admin', label: 'Add a new address held: only the admin adds addresses', model: page((locale) => ({ addAddressHeld: orderingWords(locale).t('head.addAddressAdmin', { names: 'Paolo Esempio' }) })) },
    { id: 'draft-head-problem', label: 'A requested date in the past', model: page(() => ({ header: { ...headerDraftOf(draftRecord().request), requestedDate: '2020-01-10' }, headerErrors: { requestedDate: 'head.problem.datePast' }, save: { kind: 'failed', reason: null } })) },
    { id: 'draft-removed', label: 'A line removed, with Undo', model: page((locale) => ({ record: draftRecord({ lines: [LINE_TROUSERS()] }), notice: { lines: [orderingWords(locale).t('notice.removed', { seq: 1, style: 'JKT-100', colour: 'Nero Esempio' })], undo: true } })) },
    { id: 'draft-stale', label: 'Changed elsewhere while typing', model: page(() => ({ stale: true, problem: 'refusal.conflict' })), note: 'What was typed stays; “Read it again”.' },
    { id: 'reorder', label: 'Reorder: the past orders', model: page(() => ({ way: 'reorder', reorder: reorderModel() })), note: 'Their PO first, ours second (RefPair), date, lines, pieces. Enter or a click opens one.' },
    {
      id: 'reorder-order',
      label: 'Reorder: one order’s lines with every difference',
      model: page(() => ({ way: 'reorder', reorder: reorderModel({ order: { id: PAST_ORDERS[0]!.id, state: 'ready', read: pastOrder() }, selected: ['0194f0e2-1940-7000-8000-000000000601'] }) })),
      note: '“Price now … (was …)”, sizes left out, a discontinued colour to replace (the row is selectable once chosen), a style no longer sold (not selectable, with the reason). Bulk action: Add N lines to the draft.',
    },
    { id: 'reorder-empty', label: 'Reorder: no past orders', model: page(() => ({ way: 'reorder', reorder: reorderModel({ orders: { state: 'ready', rows: [] } }) })) },
    { id: 'reorder-error', label: 'Reorder: the past orders could not be read', model: page(() => ({ way: 'reorder', reorder: reorderModel({ orders: { state: 'error', rows: [] } }) })) },
    { id: 'upload', label: 'Upload a sheet: the template and the file', model: page(() => ({ way: 'upload', upload: { sheet: { state: 'idle' }, templateHref: templateHref('it'), writeHeld: null } })), note: 'tab:template: the XLSX opens in a new tab (the browser saves it).' },
    { id: 'upload-reading', label: 'Upload: reading the file', model: page(() => ({ way: 'upload', upload: { sheet: { state: 'reading', fileName: 'ordine-esempio.xlsx' }, templateHref: templateHref('it'), writeHeld: null } })) },
    { id: 'upload-read', label: 'Upload: the dry run, a verdict per row', model: page(() => ({ way: 'upload', upload: { sheet: { state: 'read', fileName: 'ordine-esempio.xlsx', answer: uploadAnswer(), applying: false }, templateHref: templateHref('it'), writeHeld: null } })), note: 'Nothing is added until “Add 4 rows to the order”; refused rows can be downloaded to fix them.' },
    { id: 'upload-failed', label: 'Upload: a file we could not read', model: page(() => ({ way: 'upload', upload: { sheet: { state: 'failed', fileName: 'vecchio-ordine.xlsx', problem: 'upload.unreadable' }, templateHref: templateHref('it'), writeHeld: null } })) },
    { id: 'picker', label: 'pop:style-picker — choose styles', model: page(() => ({ way: 'pick', dialogs: { picker: pickerModel({ selected: [STYLE] }), address: null, discard: null } })), note: 'Search (/), chips, cards with colours, sizes and “from” price; Space chooses a card; the style sheet opens in a new tab.' },
    {
      id: 'picker-sizes',
      label: 'pop:style-picker — the sizes per colour',
      model: page(() => ({
        way: 'pick',
        dialogs: {
          picker: pickerModel({ step: 'sizes', selected: [STYLE], details: { [STYLE]: { state: 'ready', detail: styleDetail() } }, cells: { [STYLE]: { '0194f0e2-1940-7000-8000-000000000102': { '48': 2, '50': 4 } } }, onDraft: { [`${STYLE}|0194f0e2-1940-7000-8000-000000000101`]: 1 } }),
          address: null,
          discard: null,
        },
      })),
      note: 'One line per colour; a colour already on the draft says where to change it.',
    },
    { id: 'picker-loading', label: 'pop:style-picker — loading', model: page(() => ({ way: 'pick', dialogs: { picker: pickerModel({ catalogue: { state: 'loading', read: null } }), address: null, discard: null } })) },
    { id: 'address', label: 'pop:new-address', model: page(() => ({ dialogs: { picker: null, address: { draft: EMPTY_ADDRESS, problems: addressProblems(EMPTY_ADDRESS), showProblems: false, busy: false, failed: null, refused: {} }, discard: null } })), note: 'The account’s own field words; the check of a new address said first.' },
    { id: 'address-problems', label: 'pop:new-address — held at the fields', model: page(() => ({ dialogs: { picker: null, address: { draft: { ...EMPTY_ADDRESS, postalCode: '401' }, problems: addressProblems({ ...EMPTY_ADDRESS, postalCode: '401' }), showProblems: true, busy: false, failed: null, refused: { province: 'address.refused.province' } }, discard: null } })) },
    { id: 'discard', label: 'pop:discard — Discard this draft?', model: page(() => ({ dialogs: { picker: null, address: null, discard: { lines: 2, busy: false, failed: null } } })) },
    {
      id: 'sent',
      label: 'sec:sent — Request sent',
      model: page(() => ({ sent: { number: 'RQ-2026-0087', customerRef: 'BA-PO-4521', confirmBy: TODAY, lines: 2, pieces: 26, net: '9500.00', currency: 'EUR', seesPrices: true } }), 'sent'),
      note: '“Order request sent — your PO …, our request RQ-… We confirm by …” · Open the order (status Requested) · New order.',
    },
    { id: 'closed', label: 'A request no longer a draft', model: page(() => ({ record: draftRecord({ request: { status: 'SENT', number: 'RQ-2026-0081' } }), closed: { status: 'SENT', number: 'RQ-2026-0081', salesOrder: null } }), 'closed') },
    { id: 'missing', label: 'A draft that no longer exists', model: page(() => ({ state: 'missing', record: null })) },
    { id: 'loading', label: 'Loading the draft', model: page(() => ({ state: 'loading', record: null })) },
    { id: 'error', label: 'The draft could not be read', model: page(() => ({ state: 'error', record: null })) },
    { id: 'offline', label: 'No connection', model: page((locale) => ({ offlineSince: at(-1), writeHeld: orderingWords(locale).t('held.offline'), sendHeld: orderingWords(locale).t('held.offline') })), note: 'Every action that sends is held with “No connection”; typed text stays.' },
    { id: 'preview', label: 'An office preview (read only)', model: page((locale) => ({ writeHeld: orderingWords(locale).t('held.preview'), sendHeld: orderingWords(locale).t('held.preview'), addAddressHeld: orderingWords(locale).t('held.preview') })) },
    {
      id: 'style-sheet',
      label: 'tab:style-sheet — the style sheet in its own tab',
      model: (locale) => ({ shell: shellOf(locale, { title: orderingWords(locale).t('sheet.title', { code: 'JKT-100' }) }, '/catalogue'), body: { kind: 'sheet', model: { state: 'ready', detail: styleDetail(), partyName: 'Brand Alpha S.r.l.', printedAt: at(0) } } }),
      note: 'To read beside the draft, or Print or save as PDF.',
    },
    {
      id: 'no-access',
      label: 'Not part of the person’s access',
      model: (locale) => ({ shell: shellOf(locale, { title: orderingWords(locale).t('band.title') }, '/orders/new'), body: { kind: 'noAccess', admins: ['Paolo Esempio'] } }),
      note: 'A colleague who may not order (a typed or old address): who to ask, and Home. Not in the navigation (fails closed).',
    },
  ],
})
