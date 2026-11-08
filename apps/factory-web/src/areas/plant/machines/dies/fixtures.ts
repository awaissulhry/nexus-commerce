import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, inShell, PLANT_ROLES, PREFIX, SITE, SITES, uid, type PlantRole } from '../../_shared/fixtures'
import type { Die, StyleChoice } from './api'
import { blankDieDraft, dieCan, type DieDraft } from './model'
import type { DiesDialog, DiesModel } from './view-model'
import { DiesView } from './view/DiesView'

/**
 * SCR-150-dies — Plant › Machines & tools › Clicking dies (B-W2b-136; QHS-173; design plant.machines/sec:dies) with
 * made-up data only: an invented style ("DEMO-GIA-01"), dies "FD-0001" …, racks and a supplier ("Fustelle Demo"). The
 * register (rack and condition inline; a cell saving, saved, refused), the cost only with the cost grain, Rows ▾ Retired,
 * New die (empty, filled, refused for a taken number), Retire 2 with one refused, and the section's states. Roles: the
 * maintenance lead (keeps the register, no money), the owner (with costs), the floor supervisor (reads only) and sales
 * (no plant.view). Nothing here is a real company, style, person or number.
 */

interface DiesCase {
  role: PlantRole
  dies: DiesModel
}

const STYLE = { id: uid('3131', 1), code: 'DEMO-GIA-01', name: 'Giacca demo da moto' }
const STYLE_TWO = { id: uid('3131', 2), code: 'DEMO-PAN-02', name: 'Pantalone demo' }
const SUPPLIER = { id: uid('3232', 1), code: 'DEMO-F1', name: 'Fustelle Demo S.r.l.' }
const PIECE_FRONT = { id: uid('3333', 1), name: 'Davanti sinistro', revision: 2 }
const PIECE_SLEEVE = { id: uid('3333', 2), name: 'Manica', revision: 2 }

const die = (n: number, over: Partial<Die>): Die => ({
  id: uid('3434', n),
  companyId: SITE.companyId,
  siteId: SITE.id,
  siteCode: SITE.code,
  code: `FD-${String(n).padStart(4, '0')}`,
  style: STYLE,
  size: '50',
  piece: 'Davanti sinistro',
  patternPiece: PIECE_FRONT,
  rackLocation: 'Rastrelliera R1, ripiano 1',
  material: 'Lama in acciaio',
  supplier: SUPPLIER,
  purchaseCost: 18000,
  condition: 'GOOD',
  note: null,
  version: 1,
  createdAt: at(2, 8),
  updatedAt: at(2, 8),
  ...over,
})

export const DIES = {
  front50: die(1, {}),
  front52: die(2, { size: '52', rackLocation: 'Rastrelliera R1, ripiano 2', condition: 'WORN', note: 'Filo arrotondato al collo: ordinarne una nuova.', purchaseCost: 18500, version: 3 }),
  front54: die(3, { size: '54', rackLocation: 'Rastrelliera R1, ripiano 3' }),
  sleeve: die(4, { size: null, piece: 'Manica', patternPiece: PIECE_SLEEVE, rackLocation: 'Rastrelliera R2', material: 'Acciaio forgiato', purchaseCost: 26000 }),
  pocket: die(5, { style: STYLE_TWO, size: null, piece: 'Tasca', patternPiece: null, rackLocation: null, material: null, supplier: null, purchaseCost: null, condition: 'DAMAGED', note: 'Lama piegata.' }),
  retired: die(6, { size: '56', rackLocation: 'Rastrelliera R9 (scarti)', condition: 'RETIRED', note: 'Dismessa 2026-10-02: crepata.', purchaseCost: 17000 }),
}
const IN_USE: Die[] = [DIES.front50, DIES.front52, DIES.front54, DIES.sleeve, DIES.pocket]

/** Without the cost grain the API leaves the cost out (absent, never null). */
const noCost = (rows: Die[]): Die[] => rows.map(({ purchaseCost: _cost, ...rest }) => rest)

const STYLE_CHOICES: StyleChoice[] = [
  { ...STYLE, sizes: ['48', '50', '52', '54', '56'] },
  { ...STYLE_TWO, sizes: ['46', '48', '50'] },
]

function dies(role: PlantRole, over: Partial<DiesModel> = {}): DiesCase {
  const can = dieCan(PLANT_ROLES[role])
  return {
    role,
    dies: {
      prefix: PREFIX,
      can,
      address: { q: '', rows: 'inUse', isNew: false },
      sites: SITES,
      siteId: SITE.id,
      rows: { items: can.cost ? IN_USE : noCost(IN_USE), more: false, problem: null },
      asOf: at(30, 9, 42),
      live: 'live',
      updates: 0,
      cells: {},
      dialog: null,
      notice: null,
      ...over,
    },
  }
}

const draft = (over: Partial<DieDraft> = {}): DieDraft => ({ ...blankDieDraft(SITE.id), ...over })
const newDie = (over: Partial<Extract<DiesDialog, { kind: 'new' }>> = {}): DiesDialog => ({ kind: 'new', draft: draft(), styles: null, choices: null, suppliers: null, busy: false, problem: null, field: null, ...over })
const filled = draft({ code: 'FD-0007', style: STYLE_CHOICES[0]!, size: '56', piece: 'Davanti sinistro', patternPieceId: PIECE_FRONT.id, rackLocation: 'Rastrelliera R1, ripiano 4', material: 'Lama in acciaio', supplier: { id: SUPPLIER.id, code: SUPPLIER.code, legalName: SUPPLIER.name }, cost: '185,00', note: 'Per la taglia 56 nuova.' })
const choices = { style: STYLE, sizes: STYLE_CHOICES[0]!.sizes, pieces: [{ ...PIECE_FRONT, sizes: [] }, { ...PIECE_SLEEVE, sizes: ['52', '54'] }] }

/** The dies section as Machines & tools shows it (SCR-150's `section-dies` case): the maintenance lead's register. */
export const diesSectionDemo = (role: PlantRole = 'maintenance'): DiesModel => dies(role).dies

function DiesDesign({ model }: { model: DiesCase }) {
  return inShell('/plant/machines', createElement(DiesView, { model: model.dies }), model.role)
}

export const designScreen = defineDesignScreen<DiesCase>({
  screen: 'SCR-150-dies',
  title: 'Clicking dies (the die register of Machines & tools)',
  view: DiesDesign,
  cases: [
    { id: 'maintenance', label: 'Maintenance lead: the register, rack and condition inline (no money)', model: dies('maintenance'), note: 'c registers a die; the rack saves on Enter or when the focus leaves.' },
    { id: 'owner-cost', label: 'Owner: the purchase cost (cost grain)', model: dies('owner') },
    { id: 'cells', label: 'Inline: a rack saving, a condition saved, a rack refused', model: dies('maintenance', { cells: { [`${DIES.front50.id}:rackLocation`]: { state: 'saving' }, [`${DIES.front52.id}:condition`]: { state: 'saved' }, [`${DIES.sleeve.id}:rackLocation`]: { state: 'failed', words: { key: 'problem.conflict' } } }, notice: { tone: 'danger', words: { key: 'cell.refused', params: { die: DIES.sleeve.code } }, detail: { key: 'problem.conflict' } } }) },
    { id: 'selected', label: 'Two dies selected: Retire 2, Export 2', model: dies('maintenance', { selected: [DIES.front52.id, DIES.pocket.id] }) },
    { id: 'retired', label: 'Rows ▾ Retired: kept for their history, read only', model: dies('maintenance', { address: { q: '', rows: 'retired', isNew: false }, rows: { items: noCost([DIES.retired]), more: false, problem: null } }) },
    { id: 'all-sites', label: 'All sites: the Site column', model: dies('maintenance', { siteId: null, rows: { items: noCost([...IN_USE, DIES.retired]), more: true, problem: null }, address: { q: '', rows: 'all', isNew: false } }) },
    { id: 'new', label: 'New die: the number, the style found by code or name', model: dies('maintenance', { dialog: newDie() }) },
    { id: 'new-styles', label: 'New die: styles found for "demo"', model: dies('maintenance', { dialog: newDie({ draft: draft({ code: 'FD-0007' }), styles: STYLE_CHOICES }) }) },
    { id: 'new-filled', label: 'New die filled (owner: supplier and cost; the pattern piece)', model: dies('owner', { dialog: newDie({ draft: filled, styles: STYLE_CHOICES, choices, suppliers: [{ id: SUPPLIER.id, code: SUPPLIER.code, legalName: SUPPLIER.name }] }) }) },
    { id: 'new-refused', label: 'New die refused: the number is taken', model: dies('maintenance', { dialog: newDie({ draft: { ...filled, code: 'FD-0001', cost: '' }, styles: STYLE_CHOICES, choices, problem: { key: 'refusal.DIE_NUMBER_TAKEN' }, field: 'code' }) }) },
    { id: 'retire', label: 'Retire 2: what happens, and a reason', model: dies('maintenance', { dialog: { kind: 'retire', dies: [DIES.front52, DIES.pocket], reason: '', busy: false, problem: null, refused: [] } }) },
    { id: 'retire-refused', label: 'Retire: one refused (changed meanwhile), in words', model: dies('maintenance', { dialog: { kind: 'retire', dies: [DIES.pocket], reason: 'Lama piegata, non riparabile', busy: false, problem: null, refused: [{ code: DIES.pocket.code, words: { key: 'problem.conflict' } }] }, notice: { tone: 'success', words: { key: 'done.retired', params: { count: 1 } } } }) },
    { id: 'supervisor', label: 'Floor supervisor: reads the register; New die held', model: dies('supervisor') },
    { id: 'updates', label: 'Live changes waiting', model: dies('maintenance', { updates: 2 }) },
    { id: 'loading', label: 'Loading (still reading after a second)', model: dies('maintenance', { rows: { items: null, more: false, problem: null }, slow: true, asOf: null }) },
    { id: 'error', label: "The dies couldn't be read", model: dies('maintenance', { rows: { items: null, more: false, problem: 'problem.unavailable' } }) },
    { id: 'empty', label: 'No dies registered', model: dies('maintenance', { rows: { items: [], more: false, problem: null } }) },
    { id: 'no-match', label: 'Nothing matches the search', model: dies('maintenance', { address: { q: 'ZZZ', rows: 'inUse', isNew: false }, rows: { items: [], more: false, problem: null } }) },
    { id: 'keys', label: 'The keys (footer icon, ?)', model: dies('maintenance', { helpOpen: true }) },
    { id: 'sales', label: 'Sales: no plant.view (the section says so)', model: dies('sales') },
  ],
})
