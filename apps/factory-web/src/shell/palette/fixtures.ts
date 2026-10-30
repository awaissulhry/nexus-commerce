import { defineDesignScreen } from '../../lib/design/design-screen'
import { DEMO_LABELS, DEMO_TAG, demoPages, OWNER_PERMISSIONS, SALES_PERMISSIONS, typo } from '../design-data'
import type { PaletteRecord, PaletteRecords } from './palette-model'
import { CommandPaletteView, type CommandPaletteViewModel } from './view/CommandPaletteView'

const owner = { open: true, pages: demoPages(OWNER_PERMISSIONS), tenantTag: DEMO_TAG }

// Made-up records (B-W2a-32): what the search would answer. No real company, person or number.
const id = (n: number) => `0190f0e2-5555-7000-8000-${String(n).padStart(12, '0')}`
const record = (n: number, recordType: string, number: string | null, title: string, subtitle: string | null, status: string | null, match: PaletteRecord['match'] = 'words'): PaletteRecord => ({
  recordType,
  recordId: id(n),
  number,
  title,
  subtitle,
  status,
  match,
  href: `/w/DEMO/records/${recordType}/${id(n)}`,
})
const ready = (query: string, hits: PaletteRecord[], total = hits.length): PaletteRecords => ({ query, state: 'ready', hits, total, allHref: `/w/DEMO/search?q=${encodeURIComponent(query)}` })

const PISTA = [
  record(1, 'Party', 'CLI-0042', 'Pista Demo Racing S.r.l.', 'Pista Demo', 'ACTIVE'),
  record(2, 'SalesOrder', 'ORD-2026-00042', 'Pista Demo', 'Giacche estive', 'IN_PRODUCTION'),
  record(3, 'Quote', 'PRV-2026-00118', 'Pista Demo', null, 'SENT'),
  record(4, 'Invoice', 'FT-2026-00031', 'Pista Demo', 'ORD-2026-00042', 'DELIVERED'),
  record(5, 'Shipment', 'SPE-2026-00019', 'Pista Demo', 'ORD-2026-00042', 'SHIPPED'),
]

export const designScreen = defineDesignScreen<CommandPaletteViewModel>({
  screen: 'SCR-004',
  title: 'Search & command palette',
  view: CommandPaletteView,
  cases: [
    { id: 'pages', label: 'Opened: every page', model: { ...owner, query: '' }, note: 'Owner: every page they may open, by area.' },
    { id: 'search', label: 'Typing a page name', model: { ...owner, query: 'us' }, note: '"us" finds Users; ↑ ↓ and Enter.' },
    { id: 'few-pages', label: 'Few pages (sales)', model: { open: true, pages: demoPages(SALES_PERMISSIONS), tenantTag: DEMO_TAG, query: '' }, note: 'A sales person sees only the pages their roles open.' },
    {
      id: 'records',
      label: 'Records by name (W2a)',
      model: { ...owner, query: 'pista', records: ready('pista', PISTA, 14) },
      note: 'Records group: number · name, type · line · status; then "See all results (14)" → the results page (SCR-248). Tab jumps to Pages.',
    },
    {
      id: 'records-typo',
      label: 'A typo forgiven (W2a)',
      model: { ...owner, query: 'pisra', records: ready('pisra', PISTA.slice(0, 3).map((hit) => ({ ...hit, match: 'similar' as const }))) },
      note: '"pisra" finds Pista: each row says it matched a similar word.',
    },
    {
      id: 'exact-number',
      label: 'Exact number (W2a)',
      model: { ...owner, query: 'ORD-2026-00042', records: ready('ORD-2026-00042', [{ ...PISTA[1]!, match: 'number' }, PISTA[3]!, PISTA[4]!]) },
      note: 'The number typed or pasted whole opens its record at once (Enter); records that only mention it follow.',
    },
    { id: 'number-none', label: 'A number nobody has (W2a)', model: { ...owner, query: 'FT-2026-99999', records: ready('FT-2026-99999', []) }, note: 'Said in words; pages still listed.' },
    {
      id: 'label-record',
      label: 'Scanned label opens its record (W2a)',
      model: { ...owner, query: DEMO_LABELS.hide, records: ready(DEMO_LABELS.hide, [record(9, 'Hide', DEMO_LABELS.hide, 'Nappa Demo nera', 'LOT-2026-0088', null, 'number')]) },
      note: 'A hide label of this factory: its record opens with Enter.',
    },
    { id: 'label', label: 'Scanned label, no record yet', model: { ...owner, query: DEMO_LABELS.hide, records: ready(DEMO_LABELS.hide, []) }, note: 'What it is and its reference; no record has it.' },
    { id: 'label-typo', label: 'Label with a typo', model: { ...owner, query: typo(DEMO_LABELS.bundle) }, note: 'The check symbol catches one wrong character.' },
    { id: 'label-other-factory', label: 'Label of another factory', model: { ...owner, query: DEMO_LABELS.otherFactory } },
    { id: 'loading', label: 'Records loading (W2a)', model: { ...owner, query: 'pista', records: { query: 'pista', state: 'loading', hits: [], total: 0, allHref: null } }, note: 'Skeleton rows in the row\'s own shape; pages already listed.' },
    { id: 'slow', label: 'Records still loading (W2a)', model: { ...owner, query: 'pista', records: { query: 'pista', state: 'slow', hits: [], total: 0, allHref: null } }, note: '"Still loading…" after about a second.' },
    { id: 'error', label: 'Search not answering (W2a)', model: { ...owner, query: 'pista', records: { query: 'pista', state: 'error', hits: [], total: 0, allHref: null } }, note: 'The Records group says so; pages still work.' },
    { id: 'nothing', label: 'Nothing found', model: { ...owner, query: 'zzz', records: ready('zzz', []) }, note: 'No group at all: try a number, a name or scan a label.' },
  ],
})
