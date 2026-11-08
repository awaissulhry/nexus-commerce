import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import { listBandOf } from './band'
import { ordersRead, PREFIX, ROWS, shellOf, words } from './design-data'
import { SupplierCase, type SupplierCaseBuilder } from './view/SupplierCase'
import type { OrdersListViewModel } from './view/OrdersListView'

/**
 * SCR-189 › Purchase orders (design portal.supplier.orders: sec:chips, sec:po-grid; B-W2b-179), MADE-UP data only: the
 * orders waiting for an answer (the default chip), every order, selected orders with the bulk actions, the bulk confirm
 * pop-up and its result, nothing yet, nothing matching, loading, an error, a list cut at its limit, an office preview, and
 * the page for a person without it (a typed address).
 */

function listModel(over: Partial<OrdersListViewModel> = {}): OrdersListViewModel {
  return { state: 'ready', read: ordersRead(), chip: null, q: '', prefix: PREFIX, selected: [], facts: { mayAnswer: true, preview: false, offline: false }, busy: false, dialog: null, updates: 0, ...over }
}

function listCase(build: (locale: Locale) => { model?: Partial<OrdersListViewModel>; preview?: boolean }): SupplierCaseBuilder {
  return (locale) => {
    const t = words(locale)
    const { model = {}, preview = false } = build(locale)
    const list = listModel(model)
    const read = list.read
    return {
      shell: shellOf(locale, {
        path: '/orders',
        preview,
        band: listBandOf({ t, locale, asOf: read?.asOf ?? null, waiting: read?.counts.toConfirm ?? 0, onWaitingChip: read?.chip === 'TO_CONFIRM', confirmHeld: preview ? t('held.preview') : null, rows: read?.items.length ?? 0 }),
      }),
      body: { kind: 'list', model: list },
    }
  }
}

const many = () => ({
  orders: ROWS.filter((row) => row.canAnswer).map((row) => ({ id: row.id, documentNumber: row.documentNumber, lines: null, lineCount: row.lines })),
  supplierRef: '',
  person: 'Luca Prova',
  busy: false,
  heldReason: null as string | null,
  problem: null,
})

export const designScreen = defineDesignScreen<SupplierCaseBuilder>({
  screen: 'SCR-189-orders',
  title: 'Supplier Purchase orders (portal.supplier.orders)',
  view: SupplierCase,
  cases: [
    { id: 'normal', label: 'Orders to confirm (the default chip)', model: listCase(() => ({})), note: 'Chips with counts; their reference first, ours second; the row opens the order (⌘-click a new tab); the band confirms the waiting orders; ⋯ exports this view as CSV. No price anywhere.' },
    { id: 'all', label: 'Every order', model: listCase(() => ({ model: { chip: 'ALL', read: ordersRead('ALL', ROWS) } })), note: 'Late in red with its date; delivered; being changed by us; the next date expected.' },
    { id: 'selected', label: 'Two orders selected', model: listCase(() => ({ model: { chip: 'ALL', read: ordersRead('ALL', ROWS), selected: [ROWS[0]!.id, ROWS[2]!.id] } })), note: 'The bulk actions take the search’s place: “Confirm 1 of 2 as asked” (only orders that wait for you) and Export 2.' },
    { id: 'confirm-many', label: 'Pop-up: confirm the waiting orders', model: listCase(() => ({ model: { dialog: many() } })) },
    { id: 'confirm-result', label: 'Pop-up: the result of a bulk confirm', model: listCase(() => ({ model: { dialog: { ...many(), result: { confirmed: 1, refused: 1 } } } })), note: 'One command per order; a refused one is named, nothing is hidden.' },
    { id: 'empty', label: 'No purchase orders yet', model: listCase(() => ({ model: { chip: 'ALL', read: { ...ordersRead('ALL', []), chips: ordersRead('ALL', []).chips.map((chip) => ({ ...chip, count: 0 })), counts: { toConfirm: 0, late: 0 } } } })) },
    { id: 'no-match', label: 'Nothing matches the search', model: listCase(() => ({ model: { chip: 'ALL', q: 'CP-9999', read: ordersRead('ALL', []) } })) },
    { id: 'chip-empty', label: 'Nothing in a chip', model: listCase(() => ({ model: { chip: 'CLOSED', read: ordersRead('CLOSED', []) } })) },
    { id: 'loading', label: 'Loading', model: listCase(() => ({ model: { state: 'loading', read: null } })) },
    { id: 'error', label: 'The list could not be read', model: listCase(() => ({ model: { state: 'error', read: null } })), note: 'A failed read is never drawn as an empty list.' },
    { id: 'capped', label: 'Only the latest 500', model: listCase(() => ({ model: { chip: 'ALL', read: { ...ordersRead('ALL', ROWS), complete: false } } })) },
    { id: 'updates', label: 'Changes waiting', model: listCase(() => ({ model: { updates: 2 } })), note: 'Rows never move under the cursor: “2 updates · Show”.' },
    { id: 'preview', label: 'An office preview', model: listCase(() => ({ preview: true, model: { facts: { mayAnswer: true, preview: true, offline: false }, selected: [ROWS[0]!.id] } })), note: 'Confirm is held with the reason.' },
    { id: 'no-approve', label: 'A colleague who may not approve', model: listCase(() => ({ model: { facts: { mayAnswer: false, preview: false, offline: false }, selected: [ROWS[0]!.id] } })), note: '“Only colleagues allowed to approve can answer an order: ask your admin.”' },
    {
      id: 'no-access',
      label: 'Not part of the person’s access',
      model: (locale) => ({ shell: shellOf(locale, { path: '/orders', band: { title: words(locale)('list.title') } }), body: { kind: 'noAccess', admins: ['Anna Esempio'] } }),
      note: 'A typed or old address: who to ask, and Home. Not in the navigation (fails closed).',
    },
  ],
})
