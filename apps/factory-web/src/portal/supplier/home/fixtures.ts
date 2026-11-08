import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import { formatTime } from '../../../lib/i18n/format'
import { noticesOf } from '../../shell/model'
import { portalNavFor } from '../../shell/nav/portal-nav'
import { homeBandOf } from '../orders/band'
import { at, conversations, HOME, LINES, PO_ID, PREFIX, SHIPPABLE, shellOf, SUPPLIER_TASKS, tasksOf, TODAY, words } from '../orders/design-data'
import { SupplierCase, type SupplierCaseBuilder, type SupplierCaseModel } from '../orders/view/SupplierCase'
import type { ConfirmAllModel } from '../orders/view/Dialogs'
import { tilesFor, tilesOf, upcomingOf } from './model'
import type { SupplierHomeViewModel } from './view/SupplierHomeView'

/**
 * SCR-189 — the supplier's Home (design portal.supplier.home; B-W2b-179), every state with MADE-UP data only: To do with
 * "Confirm" on a PO (its pop-up), the five counts, the next deliveries, our last messages, "Free for suppliers"; a workshop's
 * Home; loading, error, empty, an office preview (verbs held with the reason), offline, a confirmation just made.
 */

const ALL = (permission: string) => permission.startsWith('portal.') || permission === 'threads.read'
const BUILT = { orders: true, deliveries: false, documents: false, jobs: false }

function homeModel(locale: Locale, over: Partial<SupplierHomeViewModel> = {}): SupplierHomeViewModel {
  return {
    prefix: PREFIX,
    tiles: { state: 'ready', items: tilesOf(tilesFor('SUPPLIER', BUILT), HOME, ALL) },
    upcoming: { state: 'ready', items: upcomingOf(SHIPPABLE, TODAY) },
    messages: { state: 'ready', items: conversations(locale) },
    freeNote: true,
    confirmed: null,
    dialog: null,
    ...over,
  }
}

const confirmDialog = (over: Partial<ConfirmAllModel> = {}): ConfirmAllModel => ({
  orders: [{ id: PO_ID, documentNumber: 'PO-2026-0101 rev. 2', lines: [...LINES], lineCount: 3 }],
  supplierRef: '',
  person: 'Luca Prova',
  busy: false,
  heldReason: null,
  problem: null,
  ...over,
})

interface HomeCase {
  shell?: Partial<SupplierCaseModel['shell']>
  home?: Partial<SupplierHomeViewModel>
  tasks?: ReturnType<typeof tasksOf>
}

function homeCase(build: (locale: Locale) => HomeCase): SupplierCaseBuilder {
  return (locale) => {
    const t = words(locale)
    const { home, tasks, shell = {} } = build(locale)
    return {
      shell: shellOf(locale, { band: homeBandOf({ t, locale, asOf: HOME.asOf, prefix: PREFIX, firstToConfirm: PO_ID, preview: shell.preview ?? false }), ...shell }),
      body: { kind: 'home', model: homeModel(locale, home), tasks: tasks ?? tasksOf(locale), confirmVerb: t('home.confirmVerb') },
    }
  }
}

export const designScreen = defineDesignScreen<SupplierCaseBuilder>({
  screen: 'SCR-189',
  title: 'Supplier Home (portal.supplier.home)',
  view: SupplierCase,
  cases: [
    { id: 'normal', label: 'A tannery’s Home', model: homeCase(() => ({})), note: 'To do with Confirm on each PO (a pop-up, the record a link for ⌘-click), five counts (a tile per list; a page not built yet is a count without a link), the next deliveries, our last messages, Free for suppliers once.' },
    {
      id: 'confirm-all',
      label: 'Pop-up: Confirm PO-2026-0101 as asked?',
      model: homeCase(() => ({ home: { dialog: confirmDialog() } })),
      note: 'Every open line with its quantity and date (no prices), your order number (optional), who confirms; Enter confirms, Esc cancels.',
    },
    { id: 'confirm-reading', label: 'Pop-up: the order still being read', model: homeCase((locale) => ({ home: { dialog: confirmDialog({ orders: [{ id: PO_ID, documentNumber: '…', lines: null, lineCount: 0 }], loading: true, heldReason: words(locale)('held.reading') }) } })) },
    { id: 'confirm-refused', label: 'Pop-up: the order changed meanwhile', model: homeCase(() => ({ home: { dialog: confirmDialog({ problem: 'changed' }) } })) },
    {
      id: 'confirmed',
      label: 'Just confirmed from To do',
      model: homeCase((locale) => ({ home: { confirmed: { documentNumber: 'PO-2026-0101 rev. 2', count: 3 } }, tasks: tasksOf(locale, SUPPLIER_TASKS.slice(1)) })),
      note: 'The request leaves To do (the task closes); the banner says what was confirmed. No Undo: a confirmation cannot be taken back by the API (named in the notes).',
    },
    {
      id: 'workshop',
      label: 'A workshop’s Home',
      model: (locale) => {
        const t = words(locale)
        return {
          shell: shellOf(locale, { partyName: 'Laboratorio Esempio', nav: portalNavFor({ can: ALL, kinds: ['SUBCONTRACTOR'] }), badges: null, band: homeBandOf({ t, locale, asOf: HOME.asOf, prefix: PREFIX, firstToConfirm: null, preview: false }) }),
          body: { kind: 'home', model: homeModel(locale, { tiles: { state: 'ready', items: tilesOf(tilesFor('SUBCONTRACTOR', BUILT), HOME, ALL) }, upcoming: null }), tasks: tasksOf(locale, []) },
        }
      },
      note: 'Its jobs counted instead of POs; no next deliveries of POs.',
    },
    { id: 'loading', label: 'Loading', model: homeCase((locale) => ({ home: { tiles: { state: 'loading', items: tilesOf(tilesFor('SUPPLIER', BUILT), null, ALL) }, upcoming: { state: 'loading', items: [] }, messages: { state: 'loading', items: [] } }, tasks: tasksOf(locale, [], 'loading') })) },
    { id: 'error', label: 'Nothing could be read', model: homeCase((locale) => ({ home: { tiles: { state: 'error', items: [] }, upcoming: { state: 'error', items: [] }, messages: { state: 'error', items: [] } }, tasks: tasksOf(locale, [], 'error') })), note: 'A failed read is never drawn as an empty list: the problem in our words and Try again.' },
    { id: 'empty', label: 'Nothing to do', model: homeCase((locale) => ({ home: { upcoming: { state: 'ready', items: [] }, messages: { state: 'ready', items: [] }, freeNote: false }, tasks: tasksOf(locale, []) })) },
    { id: 'preview', label: 'An office preview', model: homeCase((locale) => ({ shell: { preview: true, notice: noticesOf({ preview: { viewer: 'Marco Prova', company: 'Officina Demo', party: 'Conceria Prova S.p.A.' } })[0] ?? null }, tasks: tasksOf(locale, SUPPLIER_TASKS, 'ready', words(locale, 'portal')('preview.held')) })), note: 'Read only: every verb held with the reason; no E-mail settings in ⋯.' },
    { id: 'offline', label: 'Offline', model: homeCase((locale) => ({ shell: { live: 'offline', notice: noticesOf({ offlineSince: formatTime(at(-1), { locale }) })[0] ?? null } })) },
  ],
})
