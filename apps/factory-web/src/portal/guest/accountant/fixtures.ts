import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { Overview, PeriodRead } from './api'
import { accountantBandOf } from './band'
import { at, FIRM_ID, INVOICES, NO_ROOM, NOW, overviewOf, periodOf, shellOf, threadOf, words } from './design-data'
import { choicesOf, dayWords, exportRowsOf, invoiceRowsOf, kindOf, periodWords, periodZipHeld, registerRowsOf } from './model'
import { AccountantCase, type AccountantCaseBuilder } from './view/AccountantCase'
import type { AccountantViewModel } from './view/AccountantView'
import type { ListSection } from './view/Lists'

/**
 * SCR-268 — the accountant's room (design portal.guest.accountant; FIN-158, PLT-022; B-W2b-201), every state with MADE-UP
 * data only (design-data.ts): October 2026 with a re-export, every kind of e-invoice (a rejected sale, one not deliverable,
 * a credit note, a purchase typed in with no file) and an Intrastat file replaced by the re-export; a quarter with months not
 * handed over yet; a year; a month with nothing in it; files chosen; a download on its way, done, refused; access that ends
 * soon; nothing handed over yet; a period not handed over; loading, still loading, the overview failed, the period failed;
 * an office preview; offline; the keys; a person whose role does not open the room.
 */

interface CaseInput {
  period?: string | null
  overview?: Overview
  read?: PeriodRead | null
  state?: AccountantViewModel['state']
  slow?: boolean
  readState?: AccountantViewModel['read']['state']
  refusal?: string | null
  listState?: AccountantViewModel['lists']['state']
  selected?: Partial<Record<ListSection, string[]>>
  busy?: string | null
  notice?: AccountantViewModel['notice']
  offline?: boolean
  keysOpen?: boolean
  closed?: boolean
  shell?: Partial<PortalShellViewModel>
}

function caseOf(input: CaseInput = {}): AccountantCaseBuilder {
  return (locale: Locale) => {
    const t = words(locale)
    if (input.closed) return { shell: shellOf(locale, { band: { title: t('title'), back: { href: shellOf(locale).prefix, label: t('noAccess.home') } } }, NO_ROOM), page: { kind: 'closed' } }
    const overview = input.overview ?? overviewOf()
    const state = input.state ?? 'ready'
    const shown = input.period === undefined ? overview.latest : input.period
    const read = input.read === undefined ? (shown && state === 'ready' ? periodOf(shown) : null) : input.read
    const readState = input.readState ?? (read ? 'ready' : 'loading')
    const preview = overview.access.preview
    const offline = input.offline ?? false
    const facts = { preview, offline, busy: (input.busy ?? null) !== null }
    const files = readState === 'ready' && read ? read.counts.files : readState === 'refused' ? 0 : null
    const zipHeld = periodZipHeld({ ...facts, files })
    const until = overview.access.accessUntil && !preview && state === 'ready' ? dayWords(overview.access.accessUntil, locale) : null
    const kind = kindOf(shown)
    const model: AccountantViewModel = {
      state,
      slow: input.slow ?? false,
      access: state === 'ready' ? { firm: overview.access.firm.name, company: overview.access.company.name, givenBy: overview.access.givenBy, accessUntil: overview.access.accessUntil, endsSoon: overview.access.endsSoon, preview, now: NOW } : null,
      period:
        state === 'ready' && shown
          ? {
              kind,
              value: shown,
              options: choicesOf(overview.choices, kind, locale, shown),
              kinds: (['MONTH', 'QUARTER', 'YEAR'] as const).filter((entry) => (entry === 'MONTH' ? overview.choices.months : entry === 'QUARTER' ? overview.choices.quarters : overview.choices.years).length > 0),
              months: read ? read.period.months.map((entry) => ({ month: entry.month, label: periodWords(entry.month, locale), shared: entry.shared, lock: entry.lock })) : null,
            }
          : null,
      read: { state: readState, refusal: input.refusal ?? null },
      lists: {
        state: input.listState ?? (readState === 'error' ? 'error' : readState === 'ready' ? 'ready' : 'loading'),
        exports: read ? exportRowsOf(read) : null,
        invoices: read ? invoiceRowsOf(read) : null,
        registers: read ? registerRowsOf(read) : null,
        later: read?.later ?? [],
        selected: { exports: [], invoices: [], registers: [], ...input.selected },
        busy: input.busy ?? null,
        held: preview ? 'held.preview' : offline ? 'held.offline' : null,
        keysOpen: input.keysOpen,
      },
      notice: input.notice ?? null,
    }
    return {
      shell: shellOf(locale, { band: accountantBandOf({ t, until, firmId: state === 'ready' ? FIRM_ID : null, zipHeld: zipHeld ? t(zipHeld) : null, onZip: () => undefined }), preview, ...input.shell }),
      page: { kind: 'page', model, thread: state === 'ready' ? threadOf(locale) : null },
    }
  }
}

const OCTOBER = INVOICES['2026-10']!
const sale = OCTOBER[0]!
const purchase = OCTOBER[5]!

export const designScreen = defineDesignScreen<AccountantCaseBuilder>({
  screen: 'SCR-268',
  title: 'Accountant (portal.guest.accountant)',
  view: AccountantCase,
  cases: [
    {
      id: 'normal',
      label: 'October 2026, handed over',
      model: caseOf(),
      note: 'Your access at rest (whose books, given by whom, until when, every download recorded). Period: Month / Quarter / Year and the month, its lock marked. Exports: EXP-2026-0012 amended by EXP-2026-0014 (a re-export carries only the changes). E-invoices: sales and purchases, XML and PDF, a rejected sale and one not deliverable; a purchase typed in has no file and cannot be chosen. Registers: the Intrastat file, the older one replaced; the VAT registers are said to come later. Ask finance at the foot. Band: Download period (zip). No amount anywhere.',
    },
    { id: 'quarter', label: 'A quarter: two months not handed over yet', model: caseOf({ period: '2026-Q4' }), note: 'Q4 2026 covers October only; November and December say “Not handed over yet” and the line under the picker says to ask finance.' },
    { id: 'quarter-locked', label: 'A quarter closed for good', model: caseOf({ period: '2026-Q3' }), note: 'July, August, September: each “Closed for good on …” (a HARD lock).' },
    { id: 'year', label: 'A year', model: caseOf({ period: '2026' }) },
    { id: 'month-empty', label: 'A month with nothing in it', model: caseOf({ period: '2026-07' }), note: 'July’s export has empty journals; no invoice and no register file: each list says so in its own words.' },
    {
      id: 'selected',
      label: 'Invoices chosen',
      model: caseOf({ selected: { invoices: [sale.id, purchase.id] } }),
      note: 'Download 2 (zip) takes the list’s place: their XML and PDF in one zip, written now, logged.',
    },
    { id: 'downloading', label: 'A download on its way', model: caseOf({ busy: sale.xml!.id }), note: 'The file’s button says “Downloading…”; every other download waits with the reason.' },
    { id: 'done', label: 'Downloaded', model: caseOf({ notice: { key: 'done.zip', params: { name: 'DEMO_2026-10_xml.zip' }, tone: 'success' } }) },
    { id: 'refused', label: 'A zip refused (too large)', model: caseOf({ period: '2026', notice: { key: 'refusal.TOO_LARGE', tone: 'danger' } }), note: 'The refusal in our words, from its code: choose a shorter period or fewer files.' },
    { id: 'ends-soon', label: 'Access ends soon', model: caseOf({ overview: overviewOf({ accessUntil: at(24 * 4 + 6), endsSoon: true }) }), note: 'The panel turns to a warning with the time left (Countdown).' },
    { id: 'none-yet', label: 'Nothing handed over yet', model: caseOf({ overview: overviewOf({ months: [] }), period: null, read: null }), note: 'No period to choose: “A month appears here once finance has made its accounting export.” Ask finance stays.' },
    { id: 'not-handed-over', label: 'A period not handed over (a typed address)', model: caseOf({ period: '2026-11', read: null, readState: 'refused', refusal: 'refusal.PERIOD_NOT_SHARED' }), note: 'Nothing is read: the API refuses a month with no accounting export.' },
    { id: 'loading', label: 'Loading', model: caseOf({ state: 'loading', read: null }) },
    { id: 'loading-slow', label: 'Still loading', model: caseOf({ state: 'loading', slow: true, read: null }) },
    { id: 'error', label: 'The room could not be read', model: caseOf({ state: 'error', read: null }), note: 'A failed read is never drawn as an empty room: Try again.' },
    { id: 'period-error', label: 'The period could not be read', model: caseOf({ read: null, readState: 'error' }), note: 'Each list says the problem and Try again.' },
    {
      id: 'preview',
      label: 'An office preview',
      model: caseOf({ overview: overviewOf({ preview: true, accessUntil: null, givenBy: null }) }),
      note: 'The office sees the room as the accountant does; every download waits with the reason (the API refuses a preview’s downloads too).',
    },
    { id: 'offline', label: 'Offline', model: caseOf({ offline: true }), note: 'Downloads wait until the connection is back.' },
    { id: 'keys', label: 'The keys (the footer’s icon)', model: caseOf({ keysOpen: true }) },
    { id: 'no-permission', label: 'A role the room does not open', model: caseOf({ closed: true }), note: 'Not in the navigation (fails closed); a typed or old address says it is not part of the access, with Home.' },
  ],
})
