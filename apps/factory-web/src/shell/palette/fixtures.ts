import { defineDesignScreen } from '../../lib/design/design-screen'
import { DEMO_LABELS, DEMO_TAG, demoPages, OWNER_PERMISSIONS, SALES_PERMISSIONS, typo } from '../design-data'
import { CommandPaletteView, type CommandPaletteViewModel } from './view/CommandPaletteView'

const owner = { open: true, pages: demoPages(OWNER_PERMISSIONS), tenantTag: DEMO_TAG }

export const designScreen = defineDesignScreen<CommandPaletteViewModel>({
  screen: 'SCR-004',
  title: 'Search & command palette',
  view: CommandPaletteView,
  cases: [
    { id: 'pages', label: 'Opened: every page', model: { ...owner, query: '' }, note: 'Owner: every W0 page they may open, by area.' },
    { id: 'search', label: 'Typing a page name', model: { ...owner, query: 'us' }, note: '"us" finds Users; ↑ ↓ and Enter.' },
    { id: 'few-pages', label: 'Few pages (sales)', model: { open: true, pages: demoPages(SALES_PERMISSIONS), tenantTag: DEMO_TAG, query: '' }, note: 'A sales person sees only Mail to sort.' },
    { id: 'label', label: 'Scanned label', model: { ...owner, query: DEMO_LABELS.hide }, note: 'A hide label of this factory: what it is and its reference.' },
    { id: 'label-typo', label: 'Label with a typo', model: { ...owner, query: typo(DEMO_LABELS.bundle) }, note: 'The check symbol catches one wrong character.' },
    { id: 'label-other-factory', label: 'Label of another factory', model: { ...owner, query: DEMO_LABELS.otherFactory } },
    { id: 'number', label: 'A document number', model: { ...owner, query: 'FT-2026-00042' }, note: 'Search by number comes with the records.' },
    { id: 'nothing', label: 'Nothing found', model: { ...owner, query: 'zzz' } },
  ],
})
