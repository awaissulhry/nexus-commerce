import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { OrderRow } from '../api'
import { waitChipsOf } from './model'
import { SheetLab, type SheetLabModel } from './view/SheetLab'

/**
 * SCR-owb-portal-sheet — the customer's orders sheet's own parts (owb-po7.4): empty, drafts, sent (Take it back), late, many columns.
 * Made-up data only (Brand Alpha's race suits; example names).
 */

const COLUMNS: SheetLabModel['columns'] = [
  { id: 'c-sizing', name: 'Sizing', kind: 'CHOICE', choices: ['Standard size', 'Made to measure'], closed: false, version: 1 },
  { id: 'c-remake', name: 'Remake', kind: 'YES_NO', choices: [], closed: false, version: 1 },
  { id: 'c-comment', name: 'Comment', kind: 'TEXT', choices: [], closed: false, version: 1 },
  { id: 'c-team', name: 'Team', kind: 'TEXT', choices: [], closed: false, version: 1 },
  { id: 'c-needed', name: 'Needed by', kind: 'DATE', choices: [], closed: false, version: 1 },
]

const waits = (list: NonNullable<OrderRow['waits']>) => waitChipsOf(list)

const empty: SheetLabModel = { drafts: { drafts: [], sendHeld: null, deleteHeld: null, busy: false }, sent: null, withdrawn: { count: 0, shown: false }, columns: [], rows: [] }

const drafts: SheetLabModel = {
  ...empty,
  drafts: {
    drafts: [
      { id: 'd-1', title: 'Race suits 2027', href: '/p/BRAND-ALPHA/orders/new?draft=d-1' },
      { id: 'd-2', title: null, href: '/p/BRAND-ALPHA/orders/new?draft=d-2' },
    ],
    sendHeld: null,
    deleteHeld: null,
    busy: false,
  },
  rows: [{ id: 'r-1', title: 'Gloves for the juniors', life: 'SENT', waits: [], lines: [], picture: true }],
}

export const designScreen = defineDesignScreen<SheetLabModel>({
  screen: 'SCR-owb-portal-sheet',
  title: 'The customer’s orders sheet — drafts, Send…, Take it back, Withdrawn, picture, Waits · news, Details (owb-po7)',
  view: SheetLab,
  cases: [
    { id: 'empty', label: 'Nothing yet', model: empty, note: 'No drafts bar, no chip.' },
    { id: 'drafts', label: 'Two drafts: open, bin (asks first), Delete the drafts, Send…', model: drafts },
    { id: 'sent', label: 'After Send: the green line with Take it back', model: { ...drafts, drafts: { ...drafts.drafts, drafts: [] }, sent: { titles: ['Race suits 2027'], takeBack: true, busy: false, refused: null } } },
    {
      id: 'late',
      label: 'Late, a design waiting for your yes, a new message',
      model: { ...empty, withdrawn: { count: 2, shown: false }, rows: [{ id: 'o-12', title: 'Your order 12 · Team kit', life: 'IN_PRODUCTION', waits: waits([{ kind: 'NEW_MESSAGES', count: 1 }, { kind: 'DESIGN_APPROVAL', count: null }, { kind: 'LATE', count: null }]), lines: [], picture: true }] },
    },
    {
      id: 'columns',
      label: 'Many own columns: two chips, then "+ n"',
      model: {
        ...empty,
        columns: COLUMNS,
        rows: [{ id: 'o-13', title: 'Your order 13 · Rain jackets', life: 'CONFIRMED', waits: waits([{ kind: 'OPEN_DETAILS', count: 2 }]), lines: [{ 'c-sizing': 'Made to measure', 'c-remake': true, 'c-comment': 'Collar 1 cm lower', 'c-team': 'Alpha juniors', 'c-needed': '2027-03-01' }], picture: false }],
      },
    },
  ],
})
