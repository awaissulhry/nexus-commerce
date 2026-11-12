import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { CHOICES, COMPANY, CONFIRMED_CARDS, DRAFT_HIDES, IDS, inSourcingShell, listAnswer, MANY, PREFIX, ROWS, SENT_SWATCHES, SOURCING_ROLES_DEMO, TODAY, withoutCost, type SourcingRoleDemo } from './_demo/fixtures'
import { EMPTY_ADDRESS, emptyDraft, newLine, sourcingCan, type SampleDraft, type SourcingAddress } from './model'
import type { NewState, SourcingPageModel } from './view-model'
import { SourcingPageView } from './view/SourcingPageView'

/**
 * SCR-222 — Purchasing › Sourcing & claims › RFQs & sourcing (B-W2b-347; design purchasing.sourcing; SCM-043). Made-up data only
 * (./_demo): an invented company, suppliers, styles, rounds, materials and sample orders. Roles from factory-domain's templates:
 * the buyer drafts and sees the cost; the planner and the warehouse read without the cost (the column is not drawn, the PDF
 * held); sales has no purchasing read. The RFQ list and record are Later: no case draws them. Labels and notes are English (the
 * design index only); the screen's words come from the catalogues.
 */

interface SourcingCase {
  role: SourcingRoleDemo
  model: SourcingPageModel
}

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })
const loading = { status: 'loading' as const }
const failed = { status: 'error' as const, problem: 'problem.read' }

function base(role: SourcingRoleDemo, over: Partial<SourcingPageModel> = {}, address: Partial<SourcingAddress> = {}): SourcingCase {
  const can = sourcingCan(SOURCING_ROLES_DEMO[role])
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      companyId: COMPANY.id,
      address: { ...EMPTY_ADDRESS, ...address },
      today: TODAY,
      orders: ready(listAnswer(can.cost ? ROWS : withoutCost(ROWS))),
      more: [],
      moreBusy: false,
      notice: null,
      selected: [],
      add: null,
      ...over,
    },
  }
}

const add = (draft: SampleDraft = emptyDraft(TODAY), over: Partial<NewState> = {}): NewState => ({ draft: { ...draft, siteId: draft.siteId ?? IDS.site }, choices: ready(CHOICES), busy: false, problem: null, ...over })

const FILLED: SampleDraft = {
  partyId: IDS.tannery,
  siteId: IDS.site,
  styleId: IDS.styleJkt,
  roundId: IDS.styleRound,
  requestedDate: '2026-11-24',
  note: 'Campioni per il primo prototipo: grazie.',
  lines: [
    { ...newLine('2026-11-24', 'HIDE', 'line-a'), itemId: IDS.leather, itemColourId: IDS.black, quantity: '2', uom: 'HIDE' },
    { ...newLine('2026-11-20', 'SWATCH', 'line-b'), itemId: IDS.mesh, quantity: '1', uom: 'M', description: '30 × 30 cm' },
    { ...newLine('2026-11-18', 'COLOUR_CARD', 'line-c'), itemId: IDS.leather, quantity: '1', uom: 'FT2' },
  ],
}

function SourcingDesign({ model }: { model: SourcingCase }) {
  return inSourcingShell(createElement(SourcingPageView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<SourcingCase>({
  screen: 'SCR-222',
  title: 'RFQs & sourcing (Purchasing › Sourcing & claims)',
  view: SourcingDesign,
  cases: [
    {
      id: 'normal',
      label: 'Buyer: the sample and development orders',
      model: base('buyer'),
      note: 'Number (opens the PO record of type Sample), supplier, project (style and sample round), items in the supplier’s words, status, cost. ⋯ opens the record or the Sample order PDF in a new tab. c drafts a sample order. Requests for quotation are Later: not drawn.',
    },
    { id: 'all-rows', label: 'Every order (rows: all)', model: base('buyer', {}, { rows: 'ALL' }) },
    { id: 'status-sent', label: 'Status Sent as the filter', model: base('buyer', { orders: ready(listAnswer([SENT_SWATCHES])) }, { rows: 'ALL', status: 'SENT' }) },
    { id: 'selected', label: 'Two rows chosen: Export 2 (a sample order is sent from its record)', model: base('buyer', { selected: [DRAFT_HIDES.id, SENT_SWATCHES.id] }) },
    { id: 'many', label: '50 rows and Show more', model: base('buyer', { orders: ready(listAnswer(MANY, MANY.at(-1)!.id)) }) },
    { id: 'empty', label: 'No sample orders yet', model: base('buyer', { orders: ready(listAnswer([])) }) },
    { id: 'filtered-empty', label: 'Filters match nothing: Clear filters', model: base('buyer', { orders: ready(listAnswer([])) }, { q: 'cordura', status: 'CLOSED', rows: 'ALL' }) },
    { id: 'loading', label: 'Loading: the list in its shape, Still loading… after a second', model: base('buyer', { orders: loading }) },
    { id: 'error', label: 'The read failed: said with Try again, never drawn as empty', model: base('buyer', { orders: failed }) },
    { id: 'planner', label: 'Planner: reads without the cost; the PDF held; New sample order held with the reason', model: base('planner'), note: 'The Cost column is not drawn (Columns ▾ says why); ⋯ Sample order PDF is held “The PDF prints the prices: it needs the cost rights.”' },
    { id: 'warehouse', label: 'Warehouse: reads without the cost', model: base('warehouse') },
    { id: 'no-permission', label: 'Sales: no purchasing read', model: base('sales') },
    { id: 'notice', label: 'After Create draft: the notice with Open', model: base('buyer', { notice: { tone: 'success', key: 'notice.drafted', params: { number: DRAFT_HIDES.number }, orderId: DRAFT_HIDES.id } }) },
    { id: 'new', label: 'New sample order: empty, Create draft held “Choose the supplier.”', model: base('buyer', { add: add() }, { add: true }) },
    { id: 'new-filled', label: 'New sample order: a sample hide, a swatch and a colour card for a proto round', model: base('buyer', { add: add(FILLED) }, { add: true }), note: 'Each line’s words are printed for the supplier in its language (Pelle campione · Campione di materiale · Cartella colori).' },
    { id: 'new-style-no-round', label: 'New sample order: a style with no open round (for the style alone)', model: base('buyer', { add: add({ ...FILLED, styleId: CHOICES.styles[1]!.id, roundId: null }) }, { add: true }) },
    { id: 'new-hide-refused', label: 'Refused: a lining as a sample hide (said at its line)', model: base('buyer', { add: add(FILLED, { problem: { key: 'refusal.HIDE_NOT_LEATHER', field: 'itemId', line: 1 } }) }, { add: true }) },
    { id: 'new-round-closed', label: 'Refused: the sample round was decided meanwhile', model: base('buyer', { add: add(FILLED, { problem: { key: 'refusal.ROUND_CLOSED', field: 'sampleRoundId', line: null } }) }, { add: true }) },
    { id: 'new-unit-refused', label: 'Refused: a unit the material is not bought in', model: base('buyer', { add: add(FILLED, { problem: { key: 'invalid.line.uom', field: 'uom', line: 2 } }) }, { add: true }) },
    { id: 'new-busy', label: 'Create draft working', model: base('buyer', { add: add(FILLED, { busy: true }) }, { add: true }) },
    { id: 'new-line-held', label: 'A line without its material: Create draft held with why', model: base('buyer', { add: add({ ...FILLED, lines: [...FILLED.lines, newLine('2026-11-20', 'SWATCH', 'line-d')] }) }, { add: true }) },
    { id: 'new-loading', label: 'New sample order: reading the choices', model: base('buyer', { add: add(emptyDraft(TODAY), { choices: loading }) }, { add: true }) },
    { id: 'new-choices-failed', label: 'New sample order: the choices could not be read', model: base('buyer', { add: add(emptyDraft(TODAY), { choices: failed }) }, { add: true }) },
    { id: 'new-incomplete', label: 'New sample order: a list cut at its limit is said', model: base('buyer', { add: add(FILLED, { choices: ready({ ...CHOICES, complete: false }) }) }, { add: true }) },
    { id: 'keys', label: 'Keyboard shortcuts (?)', model: base('buyer', { keysOpen: true }) },
    { id: 'confirmed-free', label: 'A free colour card confirmed by the supplier', model: base('buyer', { orders: ready(listAnswer([CONFIRMED_CARDS])) }, { rows: 'ALL' }) },
  ],
})
