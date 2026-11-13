import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { EMPTY_INTAKE } from '../../../../../lib/safety-reports/intake'
import { AS_OF, canOf, COUNTS, PEOPLE, PREFIX, ROWS, TODAY } from '../demo/fixtures'
import { EMPTY_NEW, newReportProblems, type NewReportDraft, type ReportsAddress } from '../model'
import type { NewReportModel } from './view/NewReportDialog'
import { ReportsListView, type ReportsListModel } from './view/ReportsListView'

/**
 * SCR-421 (B-W2b-357; the office's place for B-W2b-351's product-safety reports, RECORD_PAGES.ProductSafetyReport) — the list:
 * the doors from outside closed (the office types reports meanwhile) or open, each tile pressed, Rows ▾ and Source ▾ as chips,
 * the selection with Copy and Export, live updates, the keys panel, New report (empty, a mail with an accident and an injury
 * with the consent, its problems, refused, sending), sales, quality, read-only (New report held), no permission, loading,
 * error, empty and filtered empty. Made-up data only.
 */

const OPEN: ReportsAddress = { view: 'open', source: null, q: '', isNew: false }
const base = (over: Partial<ReportsListModel> = {}): ReportsListModel => ({
  prefix: PREFIX,
  today: TODAY,
  can: canOf('inspector'),
  address: OPEN,
  rows: { items: ROWS.filter((row) => row.status !== 'CLOSED'), more: false, problem: null },
  counts: COUNTS,
  people: PEOPLE,
  outside: 'closed',
  asOf: AS_OF,
  live: 'live',
  updates: 0,
  loadingMore: false,
  newReport: null,
  ...over,
})

const MAIL: NewReportDraft = {
  ...EMPTY_NEW,
  ...EMPTY_INTAKE,
  source: 'MAIL',
  receivedAt: '2026-11-12T08:05:00Z',
  partyId: '',
  styleId: '',
  serial: 'SN-DEMO-000789',
  whatHappened: 'Il cliente scrive che la protezione della schiena si è spostata in una caduta (dati inventati).',
  accident: true,
  injured: true,
  consent: true,
  injuryWords: 'Dolore alla schiena, visita al pronto soccorso (inventato).',
  occurredOn: '2026-11-10',
  place: 'Autostrada, uscita di servizio (inventato)',
  name: 'Cliente Demo',
  email: 'cliente@example.com',
}

const newModel = (draft: NewReportDraft, over: Partial<NewReportModel> = {}): NewReportModel => ({
  draft,
  problems: {},
  parties: [{ id: 'p1', code: 'C-DEMO-01', legalName: 'Moto Demo S.r.l.', tradeName: null }],
  styles: [{ id: 's1', companyId: null, code: 'GIA-DEMO-01', name: 'Giacca Demo Touring', status: 'RELEASED' }],
  busy: false,
  refusal: null,
  scanning: false,
  today: TODAY,
  camera: false,
  ...over,
})

export const designScreen = defineDesignScreen<ReportsListModel>({
  screen: 'SCR-421',
  title: 'Compliance › Product-safety reports (the office’s list)',
  view: ReportsListView,
  cases: [
    { id: 'normal', label: 'Open reports; the doors from outside closed (type reports from mails here)', model: base(), note: 'GATE-PRIVACY said at rest; a new public report not seen yet; serious harm not told.' },
    { id: 'outside-open', label: 'The doors from outside are open (no banner)', model: base({ outside: 'open' }) },
    { id: 'tile-not-seen', label: 'Tile pressed: not seen', model: base({ address: { ...OPEN, view: 'new' }, rows: { items: ROWS.filter((row) => row.status === 'NEW'), more: false, problem: null } }) },
    { id: 'tile-assessing', label: 'Tile pressed: being assessed', model: base({ address: { ...OPEN, view: 'assessing' }, rows: { items: ROWS.filter((row) => row.status === 'ASSESSING'), more: false, problem: null } }) },
    { id: 'all-source', label: 'All rows, source: the public DoC page, search', model: base({ address: { ...OPEN, view: 'all', source: 'PUBLIC_LINK', q: 'L-2231' }, rows: { items: ROWS.filter((row) => row.source === 'PUBLIC_LINK'), more: false, problem: null } }) },
    { id: 'selection', label: 'Two rows selected: Copy 2 numbers, Export 2', model: base({ selected: [ROWS[0]!.id, ROWS[1]!.id] }) },
    { id: 'more', label: 'More rows: Show more', model: base({ rows: { items: ROWS, more: true, problem: null } }) },
    { id: 'updates', label: 'Changes arrived: 1 update · Show', model: base({ updates: 1 }) },
    { id: 'keys', label: 'The keys panel (footer icon)', model: base({ keysOpen: true }) },
    { id: 'new', label: 'New report: empty (a mail)', model: base({ newReport: newModel(EMPTY_NEW) }), note: 'How it came (a mail: when), the customer and the style when known, then the shared form; the office may leave “hurt” unsaid.' },
    { id: 'new-filled', label: 'New report: an accident, someone hurt, the consent and the words', model: base({ newReport: newModel(MAIL) }) },
    { id: 'new-problems', label: 'New report: Create with nothing typed', model: base({ newReport: newModel(EMPTY_NEW, { problems: newReportProblems(EMPTY_NEW, TODAY) }) }) },
    { id: 'new-refused', label: 'New report: refused (the service case’s right missing)', model: base({ newReport: newModel(MAIL, { refusal: 'refused.forbiddenOffice' }) }) },
    { id: 'new-sending', label: 'New report: creating', model: base({ newReport: newModel(MAIL, { busy: true }) }) },
    { id: 'sales', label: 'Sales: records and manages, no injury', model: base({ can: canOf('sales') }) },
    { id: 'read-only', label: 'Read-only: New report held with why', model: base({ can: canOf('readOnly') }) },
    { id: 'no-permission', label: 'No permission (warehouse)', model: base({ can: canOf('warehouse') }) },
    { id: 'loading', label: 'Loading', model: base({ rows: { items: null, more: false, problem: null }, counts: null, outside: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'The read failed: in words, with Try again', model: base({ rows: { items: null, more: false, problem: 'read.failed' } }) },
    { id: 'empty', label: 'Empty: no report yet', model: base({ rows: { items: [], more: false, problem: null }, counts: { ...COUNTS, tiles: { notSeen: 0, assessing: 0, accidentsToTell: 0 } } }) },
    { id: 'filtered-empty', label: 'Filtered, nothing matches: Clear all', model: base({ address: { ...OPEN, q: 'NOTHING' }, rows: { items: [], more: false, problem: null } }) },
  ],
})
