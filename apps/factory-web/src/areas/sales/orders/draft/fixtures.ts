import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { headerDraftOf, productRowsOf } from '../../../../lib/order-draft/model'
import type { DraftRecord } from '../../../../lib/order-draft/schema'
import { DRAFT_NS, DraftDoorProvider, draftWordsFor } from '../../../../lib/order-draft/words'
import { WithMessages } from '../../../../record-panels/i18n'
import { describedLine, kindsRecord, mtmLine, TODAY } from '../../../../portal/customer/neworder/design-data'
import type { DraftRow } from '../../customers/record/drafts/api'
import { confirmRowsOf } from './confirm-model'
import { OfficeDraftView, type OfficeDraftModel } from './view/OfficeDraftView'

/**
 * SCR-038-draft › the office's draft order (THE SIMPLE ORDER START, od-tw t.3; R1, 10-design-r1 § 3.7 / § 4): the start (the customer
 * above the mail), the draft as Owner (prices) and as Sales (no prices, no styles right), a custom-size row making it a quote, the
 * Confirm window asking what the rows left open, a reader who may not change it. Made-up data (Brand Alpha, example names); nothing
 * is sent from the gallery.
 */

const CUSTOMER = { id: '0194f0e2-1940-7000-8000-00000000c001', code: 'BRAND-ALPHA', name: 'Brand Alpha' }
const words = (locale: Locale) => draftWordsFor(createTranslator(locale, CATALOGUE[locale][DRAFT_NS] ?? {}), locale, 'office')

const suit = mtmLine({ seq: 2, description: 'Custom race suit for the team', colourText: 'Black and white, as the sketch', choices: [{ topic: 'Leather', options: ['Cowhide', 'Kangaroo'], picked: null }, { topic: 'Protection class', options: ['AA', 'AAA'], picked: 'AAA' }] })
const gloves = describedLine({ seq: 3, description: 'Team gloves', colourText: null, quantity: null, pieces: 0 })

function recordOf(over: { seesPrices?: boolean; custom?: boolean } = {}): DraftRecord {
  return kindsRecord({
    seesPrices: over.seesPrices ?? true,
    custom: over.custom === false ? [gloves] : [suit, gloves],
    request: {
      subject: 'Race team kit for 2027',
      savedBy: { who: 'COLLEAGUE', name: 'Bea Esempio' },
      stillOpen: {
        openCount: 3,
        confirmHeld: true,
        items: [
          { kind: 'CHOICE', lineId: suit.id, seq: suit.seq, topic: 'Leather', state: 'NOT_DECIDED', confirmNeeds: false },
          { kind: 'PIECES', lineId: suit.id, seq: suit.seq, topic: null, state: 'NOT_DECIDED', confirmNeeds: true },
          { kind: 'DATE', lineId: null, seq: null, topic: null, state: 'NOT_DECIDED', confirmNeeds: false },
        ],
      },
    },
  })
}

const DRAFTS: DraftRow[] = []

function model(over: Partial<OfficeDraftModel> = {}): OfficeDraftModel {
  const record = over.record === undefined ? recordOf() : over.record
  return {
    prefix: '/w/DEMO',
    load: 'ready',
    today: TODAY,
    customer: record ? CUSTOMER : null,
    start: null,
    record,
    office: record ? { request: { id: record.request.id, party: CUSTOMER, styles: [{ id: '0194f0e2-1940-7000-8000-00000000c501', code: 'ALPHA-SUIT-01', name: 'Alpha race suit', status: 'DRAFT' }] }, may: { order: true, quote: true, confirm: true, styleDraft: true } } : null,
    header: headerDraftOf(record?.request ?? null),
    headerErrors: {},
    save: { kind: 'idle' },
    writeHeld: null,
    problem: null,
    stale: false,
    staleBy: null,
    notice: null,
    pending: false,
    styles: [{ id: '0194f0e2-1940-7000-8000-000000000001', code: 'JKT-100', name: 'Giacca Corsa Esempio' }],
    saving: [],
    uploads: [],
    piecesWin: null,
    optionsWin: null,
    filesRow: null,
    person: null,
    confirm: null,
    details: {},
    styleWin: null,
    done: null,
    mayStyles: true,
    mayConfirm: true,
    ...over,
  }
}

type Builder = (locale: Locale) => OfficeDraftModel

function OfficeDraftCase({ model: build }: { model: Builder }) {
  const locale = useLocale()
  return createElement(
    WithMessages,
    { namespaces: [DRAFT_NS, 'ds-words', 'lists', 'records', 'orders', 'sales-inquiries', 'request-compose'] },
    createElement(DraftDoorProvider, { door: 'office' as const }, createElement(OfficeDraftView, { model: build(locale) })),
  )
}

export const designScreen = defineDesignScreen<Builder>({
  screen: 'SCR-038-draft',
  title: 'Sales › Orders › the draft order (office)',
  view: OfficeDraftCase,
  cases: [
    { id: 'start', label: 'The start: the customer above the mail; every field waits for it', model: () => model({ record: null, start: { customers: { state: 'ready', rows: [{ id: CUSTOMER.id, label: `${CUSTOMER.code} · ${CUSTOMER.name}` }] }, partyId: null, drafts: { state: 'off', rows: [] } } }) },
    { id: 'start-customer', label: 'The start with the customer picked: its drafts to continue, the typed order link', model: () => model({ record: null, start: { customers: { state: 'ready', rows: [{ id: CUSTOMER.id, label: `${CUSTOMER.code} · ${CUSTOMER.name}` }] }, partyId: CUSTOMER.id, drafts: { state: 'ready', rows: DRAFTS } } }) },
    { id: 'draft-owner', label: 'The draft as the Owner: Confirm (a quote: a custom size), Design work, Price', model: () => model() },
    { id: 'draft-sales', label: 'The draft as Sales: no prices (no Price card), no styles right (Make style draft held)', model: () => model({ record: recordOf({ seesPrices: false }), mayStyles: false }) },
    { id: 'draft-order', label: 'A draft with no custom size: Confirm makes an order', model: () => model({ record: recordOf({ custom: false }) }) },
    {
      id: 'confirm-window',
      label: 'The Confirm window: each row, what the order still needs (Missing only here)',
      model: () => {
        const record = recordOf()
        return model({ record, confirm: { entries: Object.fromEntries(confirmRowsOf(productRowsOf(record.request)).map((entry) => [entry.rowId, entry])), promise: '2026-12-22', busy: false, failed: null } })
      },
    },
    { id: 'read-only', label: 'A reader who may not change it (orders.view only)', model: (locale) => model({ writeHeld: words(locale).t('save.readonly'), mayConfirm: false, mayStyles: false }) },
    // od-fx8 (walk W-06, W-08, W-10, W-28): the Production manager reads the order and makes the style draft; a reader's start.
    { id: 'reader-styles', label: 'The Production manager: reads the order (windows open to read), makes the style draft', model: (locale) => model({ writeHeld: words(locale).t('save.readonly'), mayConfirm: false, mayStyles: true }) },
    { id: 'start-reader', label: 'A reader’s start: said in words, no customer read, no typed order', model: (locale) => model({ record: null, writeHeld: words(locale).t('save.readonly'), start: { customers: { state: 'loading', rows: [] }, partyId: null, drafts: { state: 'off', rows: [] } } }) },
  ],
})
