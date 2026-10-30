import { defineDesignScreen } from '../../lib/design/design-screen'
import type { SearchResultRow, SearchResultsViewModel } from './view/SearchResultsView'
import { SearchResultsView } from './view/SearchResultsView'

/**
 * SCR-248 (NEW id, B-W2a-32) — All results, the design cases (made-up data only: "Demo" names, invented numbers). Roles:
 * the owner sees every type; a sales person sees customers, quotes and orders only (the API filters; the page shows
 * what it gets); a person whose roles open no record type sees "Nothing to search yet".
 */

const id = (n: number) => `0190f0e2-6666-7000-8000-${String(n).padStart(12, '0')}`
const row = (n: number, recordType: string, number: string | null, title: string, subtitle: string | null, status: string | null, area: string, match: SearchResultRow['match'] = 'words', companyCode: string | null = 'DEMO'): SearchResultRow => ({
  recordType,
  recordId: id(n),
  number,
  title,
  subtitle,
  status,
  area,
  companyCode,
  match,
  href: `/w/DEMO/records/${recordType}/${id(n)}`,
})

const PISTA: SearchResultRow[] = [
  row(1, 'Party', 'CLI-0042', 'Pista Demo Racing S.r.l.', 'Pista Demo', 'ACTIVE', 'sales', 'words', null),
  row(2, 'SalesOrder', 'ORD-2026-00042', 'Pista Demo', 'Giacche estive', 'IN_PRODUCTION', 'sales'),
  row(3, 'SalesOrder', 'ORD-2026-00057', 'Pista Demo', 'Tute pista', 'CONFIRMED', 'sales'),
  row(4, 'Quote', 'PRV-2026-00118', 'Pista Demo', 'Rif. PD-77', 'SENT', 'sales'),
  row(5, 'Quote', 'PRV-2026-00121', 'Pista Demo', null, 'DRAFT', 'sales'),
  row(6, 'Invoice', 'FT-2026-00031', 'Pista Demo', 'ORD-2026-00042', 'DELIVERED', 'finance'),
  row(7, 'Invoice', null, 'Pista Demo', 'ORD-2026-00057', 'DRAFT', 'finance'),
  row(8, 'Shipment', 'SPE-2026-00019', 'Pista Demo', 'ORD-2026-00042', 'SHIPPED', 'warehouse'),
  row(9, 'WorkOrder', 'WO-2026-00311', 'Giacca Pista Demo', 'STY-PD-01', 'IN_PROGRESS', 'production', 'words', 'ESEMPIO'),
  row(10, 'Style', 'STY-PD-01', 'Giacca Pista Demo', 'AI26 · Pista Demo', 'ACTIVE', 'products', 'words', null),
  row(11, 'Lot', 'LOT-2026-0088', 'Nappa Demo nera', 'Conceria Demo · PD-L7', 'QUARANTINE', 'warehouse'),
  row(12, 'PurchaseOrder', 'OA-2026-00064', 'Conceria Demo', 'Pista Demo stock', 'PARTLY_RECEIVED', 'purchasing'),
]
const COUNTS = [
  { recordType: 'SalesOrder', count: 4 },
  { recordType: 'Quote', count: 3 },
  { recordType: 'Invoice', count: 3 },
  { recordType: 'Party', count: 2 },
  { recordType: 'Lot', count: 7 },
  { recordType: 'Shipment', count: 1 },
  { recordType: 'WorkOrder', count: 2 },
  { recordType: 'Style', count: 1 },
  { recordType: 'PurchaseOrder', count: 1 },
]
const ready: SearchResultsViewModel = {
  q: 'pista',
  type: null,
  state: 'ready',
  words: ['pista'],
  rows: PISTA,
  counts: COUNTS,
  total: 24,
  more: true,
  asOf: '2026-10-30T08:41:00.000Z',
  timeZone: 'Europe/Rome',
}

export const designScreen = defineDesignScreen<SearchResultsViewModel>({
  screen: 'SCR-248',
  title: 'All results (global search)',
  view: SearchResultsView,
  cases: [
    { id: 'results', label: 'Results by name', model: ready, note: 'Owner: type chips with counts, then the rows; the matched word marked; Show more for the next 50.' },
    {
      id: 'one-type',
      label: 'One type (chip)',
      model: { ...ready, type: 'SalesOrder', rows: PISTA.filter((entry) => entry.recordType === 'SalesOrder'), total: 4, more: false },
      note: '`?type=SalesOrder`: the chip is pressed; All types goes back.',
    },
    {
      id: 'typo',
      label: 'A typo forgiven',
      model: { ...ready, q: 'pisra', words: ['pisra'], rows: PISTA.slice(0, 4).map((entry) => ({ ...entry, match: 'similar' as const })), counts: COUNTS.slice(0, 3), total: 4, more: false },
      note: 'Nothing is marked: every row says it matched a similar word.',
    },
    {
      id: 'number',
      label: 'An exact number',
      model: { ...ready, q: 'ORD-2026-00042', words: ['ord-2026-00042'], rows: [{ ...PISTA[1]!, match: 'number' }, PISTA[5]!, PISTA[7]!], counts: [{ recordType: 'SalesOrder', count: 1 }, { recordType: 'Invoice', count: 1 }, { recordType: 'Shipment', count: 1 }], total: 3, more: false },
      note: 'The order with that number first; the invoice and shipment that name it follow.',
    },
    { id: 'selected', label: 'Rows selected: copy numbers', model: { ...ready, selected: [id(2), id(3), id(7)] }, note: 'Copy numbers (2): the draft invoice has no number (its box says why).' },
    { id: 'copied', label: 'Numbers copied', model: { ...ready, notice: { tone: 'success', key: 'page.copied', count: 2 } } },
    {
      id: 'sales',
      label: 'Role: sales (fewer types)',
      model: { ...ready, rows: PISTA.filter((entry) => ['Party', 'SalesOrder', 'Quote'].includes(entry.recordType)), counts: COUNTS.slice(0, 2).concat([{ recordType: 'Party', count: 2 }]), total: 9, more: false },
      note: 'A sales person: customers, quotes and orders only — the API shows nothing else.',
    },
    { id: 'start', label: 'Nothing typed yet', model: { ...ready, q: '', words: [], rows: [], counts: [], total: 0, more: false, state: 'start' } },
    { id: 'loading', label: 'Loading', model: { ...ready, rows: [], counts: [], state: 'loading' } },
    { id: 'slow', label: 'Still loading', model: { ...ready, rows: [], counts: [], state: 'slow' }, note: '"Still loading…" after about a second.' },
    { id: 'empty', label: 'No results', model: { ...ready, q: 'zzzz', words: ['zzzz'], rows: [], counts: [], total: 0, more: false } },
    { id: 'error', label: 'Search not answering', model: { ...ready, rows: [], counts: [], state: 'error' }, note: 'In words, with Try again; the navigation keeps working.' },
    { id: 'no-access', label: 'No permission', model: { ...ready, q: 'pista', rows: [], counts: [], total: 0, more: false, state: 'noAccess' }, note: 'A person whose roles open no record type.' },
    { id: 'keys', label: 'Keys (footer icon)', model: { ...ready, keysOpen: true }, note: 'The keys live only in the footer information icon.' },
  ],
})
