import { defineDesignScreen } from '../design/design-screen'
import { WindowShellLab, type WindowShellLabModel } from './view/WindowShellLab'

/**
 * owb-b5 (w5.3) — the window frame's lab: every case is one open window. Made-up data only (Brand Alpha, SO-2026-0101).
 */
const base = { title: 'Print and start the work', subtitle: 'SO-2026-0101 · Race suit for Brand Alpha', lines: ['3 pages with the scan code · 12 baskets', 'The pages print in the browser. The baskets are made when you press the button.'], actWords: 'Print and start the work' } as const

export const designScreen = defineDesignScreen<WindowShellLabModel>({
  screen: 'SCR-owb-window-shell',
  title: 'The window frame — centred, the foot fixed, a sheet on a phone (owb-b5)',
  view: WindowShellLab,
  cases: [
    { id: 'act', label: 'A window that acts: Cancel + its ONE act', model: { ...base, show: 'act', moreWords: 'Print again…' }, note: 'The act is last; ⌘ Enter does it; Escape is Cancel. The other door sits at the foot’s left.' },
    { id: 'show', label: 'A window that only shows: Close', model: { title: 'The picture of the order', lines: ['The design of the first line is the picture.'], show: 'show' }, note: 'No act: the foot says Close.' },
    { id: 'held', label: 'A held act says why', model: { ...base, show: 'held', held: 'Place the scan code on page 2 first.' }, note: 'The button keeps its focus and says why; ⌘ Enter does nothing.' },
    { id: 'busy', label: 'The act runs', model: { ...base, show: 'busy' }, note: '“Working on it…” on the held button.' },
    { id: 'danger', label: 'A danger act', model: { title: 'Delete this draft', lines: ['The draft and its lines go away.'], actWords: 'Delete this draft', show: 'danger' }, note: 'Red, last in the foot.' },
    {
      id: 'room',
      label: 'The room rules inside a window',
      model: { title: 'Ship the whole order', lines: ['Alone · together · our warehouse', 'The table keeps its smallest width and scrolls inside its card.'], actWords: 'Ship', show: 'room', table: { columns: ['Basket', 'Piece', 'Size', 'Material', 'Department', 'Step', 'Ready', 'Parcel'], rows: [['B-0101-1', 'Race suit', '50', 'Leather black', 'Packing', '6 of 6', 'Yes', '1'], ['B-0101-2', 'Race suit', '52', 'Leather black', 'Quality', '5 of 6', 'No', '—']] } },
      note: 'Narrow window: the two parts stack (the room’s twin of the phone rule); one button height in the title bar.',
    },
  ],
})
