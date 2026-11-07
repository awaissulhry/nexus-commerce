import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { canAs, CLASS_LIST, inShell, MACHINE_LIST, MACHINE_TILE_COUNTS, MACHINES, PREFIX, SITE, SITES, type PlantRole } from '../_shared/fixtures'
import { DEPTH_TILES, FACTS, TODAY, tagJob, tagsState, WALL } from './depth/fixtures'
import { diesSectionDemo } from './dies/fixtures'
import { DiesView } from './dies/view/DiesView'
import type { ListDepth, MachineDraft, MachinesDialog, MachinesListModel } from './view-model'
import { MachinesView } from './view/MachinesView'

/**
 * SCR-150 — Machines & tools (Plant › Maintenance) with made-up data only: the register (inline station and work centre;
 * one cell saving, one saved), the purchase cost only with the cost grain, each tile pressed, retired machines when asked,
 * New machine (empty; filled; the asset number refused as taken), "Print its tag" after one is made, Retire N (its reach,
 * a reason; one refused for its open work), and the page's states. Roles: the maintenance lead (keeps the register, no
 * money), the owner (with costs), the floor supervisor (sees; New machine held), read-only and sales (no plant.view).
 */

interface MachinesCase {
  role: PlantRole
  list: MachinesListModel
}

/** B-W2b-136: the register's depth (tiles, columns, the wall, Print QR tags) as a role sees it. */
const depthOf = (role: PlantRole, over: Partial<ListDepth> = {}): ListDepth => ({
  address: { section: 'machines', need: null },
  tiles: DEPTH_TILES,
  facts: FACTS,
  today: TODAY,
  wall: { loaded: { status: 'ready', value: WALL }, filter: 'ALL', asOf: WALL.at },
  tags: null,
  canPrint: role === 'maintenance' || role === 'owner' || role === 'supervisor',
  ...over,
})

function list(role: PlantRole, over: Partial<MachinesListModel> = {}): MachinesCase {
  return {
    role,
    list: {
      prefix: PREFIX,
      can: canAs(role),
      address: { view: 'inUse', q: '', siteId: null, classId: null },
      sites: SITES,
      classes: CLASS_LIST,
      rows: { items: MACHINE_LIST, more: false, problem: null },
      tiles: MACHINE_TILE_COUNTS,
      asOf: '2026-10-30T09:42:00.000Z',
      live: 'live',
      updates: 0,
      timeZone: 'Europe/Rome',
      cells: {},
      dialog: null,
      notice: null,
      made: null,
      depth: depthOf(role),
      ...over,
    },
  }
}

const withDepth = (role: PlantRole, depth: Partial<ListDepth>, over: Partial<MachinesListModel> = {}): MachinesCase => list(role, { ...over, depth: depthOf(role, depth) })

const draft = (over: Partial<MachineDraft> = {}): MachineDraft => ({ siteId: SITE.id, assetNumber: '', classId: null, make: '', modelName: '', serialNumber: '', year: '', stationId: null, workCentreId: null, supplier: null, cost: '', note: '', ...over })
const newMachine = (over: Partial<Extract<MachinesDialog, { kind: 'new' }>> = {}): MachinesDialog => ({ kind: 'new', draft: draft(), suppliers: null, busy: false, problem: null, field: null, ...over })
const filled = draft({ assetNumber: 'DEMO-SEW-10', classId: CLASS_LIST[0]!.id, make: 'Cuciture Demo', modelName: 'CD-8700', serialNumber: 'SN-D-1010', year: '2024', stationId: SITE.stations[2]!.id, workCentreId: SITE.workCentres[0]!.id, supplier: { id: MACHINES.sew1.supplier!.id, code: MACHINES.sew1.supplier!.code, legalName: MACHINES.sew1.supplier!.name }, cost: '1850,00' })

function MachinesDesign({ model }: { model: MachinesCase }) {
  return inShell('/plant/machines', createElement(MachinesView, { model: model.list }), model.role)
}

export const designScreen = defineDesignScreen<MachinesCase>({
  screen: 'SCR-150',
  title: 'Machines & tools (the machine register)',
  view: MachinesDesign,
  cases: [
    { id: 'maintenance', label: 'Maintenance lead: the register, inline station and work centre (no money)', model: list('maintenance'), note: 'c makes a machine; an asset number opens the machine.' },
    { id: 'owner-cost', label: 'Owner: the purchase cost (cost grain)', model: list('owner') },
    { id: 'cells', label: 'Inline place: one saving, one saved', model: list('maintenance', { cells: { [`${MACHINES.sew1.id}:stationId`]: { state: 'saving' }, [`${MACHINES.cutTable.id}:workCentreId`]: { state: 'saved' } } }) },
    { id: 'tile-dnu', label: 'Tile pressed: do-not-use (one locked as unsafe)', model: list('maintenance', { address: { view: 'doNotUse', q: '', siteId: null, classId: null }, rows: { items: [MACHINES.sew2], more: false, problem: null } }) },
    { id: 'retired', label: 'Rows ▾ Retired: kept for their history', model: list('maintenance', { address: { view: 'retired', q: '', siteId: SITE.id, classId: null }, rows: { items: [MACHINES.retired], more: false, problem: null } }) },
    { id: 'search', label: 'Searched a model, one site', model: list('maintenance', { address: { view: 'inUse', q: 'CD-8700', siteId: SITE.id, classId: CLASS_LIST[0]!.id }, rows: { items: [MACHINES.sew1, MACHINES.sew2, MACHINES.sew3], more: false, problem: null } }) },
    { id: 'selected', label: 'Three machines selected: Print 3 tags, Retire 3, Export 3', model: list('maintenance', { selected: [MACHINES.sew1.id, MACHINES.heat.id, MACHINES.compressor.id] }) },
    { id: 'new', label: 'New machine: the site, the asset number on its tag, the type', model: list('maintenance', { dialog: newMachine() }) },
    { id: 'new-filled', label: 'New machine filled (owner: supplier and cost)', model: list('owner', { dialog: newMachine({ draft: filled, suppliers: [{ id: MACHINES.sew1.supplier!.id, code: MACHINES.sew1.supplier!.code, legalName: MACHINES.sew1.supplier!.name }] }) }) },
    { id: 'new-refused', label: 'New machine refused: the asset number is taken', model: list('maintenance', { dialog: newMachine({ draft: { ...filled, assetNumber: 'DEMO-SEW-01' }, problem: { key: 'problem.assetTaken' }, field: 'assetNumber' }) }) },
    { id: 'made', label: 'Made: "Print its tag"', model: list('maintenance', { made: { id: MACHINES.sew1.id, assetNumber: MACHINES.sew1.assetNumber } }) },
    { id: 'retire', label: 'Retire 2: the reach and a reason', model: list('maintenance', { dialog: { kind: 'retire', machines: [MACHINES.heat, MACHINES.compressor], reason: '', busy: false, problem: null, refused: [] } }) },
    { id: 'retire-refused', label: 'Retire: one refused for its open work (in words)', model: list('maintenance', { dialog: { kind: 'retire', machines: [MACHINES.sew3], reason: 'Sostituita', busy: false, problem: null, refused: [{ assetNumber: MACHINES.sew3.assetNumber, words: { key: 'refusal.OPEN_WORK' } }] } }) },
    { id: 'supervisor', label: 'Floor supervisor: sees the register; New machine held', model: list('supervisor') },
    { id: 'read-only', label: 'Read-only: no inline edits', model: list('readOnly') },
    { id: 'updates', label: 'Live changes waiting', model: list('maintenance', { updates: 2 }) },
    { id: 'loading', label: 'Loading', model: list('maintenance', { rows: { items: null, more: false, problem: null }, tiles: null, asOf: null }) },
    { id: 'error', label: "The machines couldn't be read", model: list('maintenance', { rows: { items: null, more: false, problem: 'problem.unavailable' }, tiles: null }) },
    { id: 'empty', label: 'No machines yet: "Add your machines"', model: list('maintenance', { rows: { items: [], more: false, problem: null }, tiles: { tiles: { DOWN: 0, DO_NOT_USE: 0, UNDER_MAINTENANCE: 0 }, locked: 0, inUse: 0 } }) },
    { id: 'no-match', label: 'Nothing matches the search', model: list('maintenance', { address: { view: 'inUse', q: 'ZZZ', siteId: null, classId: null }, rows: { items: [], more: false, problem: null } }) },
    { id: 'keys', label: 'The keys (footer icon, ?)', model: list('maintenance', { helpOpen: true }) },
    { id: 'sales', label: 'Sales: no plant.view (the page says so)', model: list('sales') },
    // B-W2b-136: machines in depth.
    { id: 'w2a-only', label: 'The W2a register without the depth (as before B-W2b-136)', model: list('maintenance', { depth: undefined }) },
    { id: 'tile-checks', label: 'Tile pressed: checks overdue (B-W2b-124 plans)', model: withDepth('maintenance', { address: { section: 'machines', need: 'checks' } }, { rows: { items: [MACHINES.press], more: false, problem: null } }) },
    { id: 'tile-ce', label: 'Tile pressed: no CE declaration on file (art. 71)', model: withDepth('maintenance', { address: { section: 'machines', need: 'ce' } }, { rows: { items: [MACHINES.sew3, MACHINES.heat, MACHINES.compressor], more: false, problem: null } }) },
    { id: 'depth-reading', label: 'The depth columns still being read', model: withDepth('maintenance', { facts: {}, tiles: null }) },
    { id: 'tags', label: 'Print QR tags: three machines, the label printer of their site', model: withDepth('maintenance', { tags: tagsState() }), note: 't opens it for the selection (none selected: the rows on screen).' },
    {
      id: 'tags-sent',
      label: 'Print QR tags sent: queued, one failed with Retry, a retired one left out in words',
      model: withDepth('maintenance', {
        tags: tagsState({
          machines: [...tagsState().machines, { id: MACHINES.retired.id, assetNumber: MACHINES.retired.assetNumber, typeWords: 'Lockstitch', placeWords: 'STAB-N', siteId: MACHINES.retired.siteId, retired: true }],
          result: { jobs: [tagJob(MACHINES.sew1.id, 'QUEUED'), tagJob(MACHINES.sew3.id, 'FAILED'), tagJob(MACHINES.press.id, 'PRINTED')], refused: [{ machineId: MACHINES.retired.id, assetNumber: MACHINES.retired.assetNumber, code: 'TAG_RETIRED', message: '' }] },
        }),
      }),
    },
    { id: 'tags-no-printer', label: 'Print QR tags: no label printer at the site (print on paper)', model: withDepth('maintenance', { tags: tagsState({ printers: { status: 'ready', value: [] }, printerId: null }) }) },
    { id: 'tags-loading', label: 'Print QR tags: the printers still being read', model: withDepth('maintenance', { tags: tagsState({ printers: { status: 'loading' }, printerId: null }) }) },
    { id: 'tags-no-right', label: 'Print QR tags held: no print.labels (production manager)', model: withDepth('production', { tags: tagsState({ printers: { status: 'forbidden' }, printerId: null }) }) },
    { id: 'tags-refused', label: 'Print QR tags refused by the server (in words)', model: withDepth('maintenance', { tags: tagsState({ problem: { key: 'problem.forbidden' } }) }) },
    { id: 'wall', label: 'Section Status wall: every machine by line, coloured and said', model: withDepth('maintenance', { address: { section: 'wall', need: null } }) },
    { id: 'wall-filter', label: 'Status wall filtered: not running', model: withDepth('maintenance', { address: { section: 'wall', need: null }, wall: { loaded: { status: 'ready', value: WALL }, filter: 'NOT_RUNNING', asOf: WALL.at } }) },
    { id: 'wall-loading', label: 'Status wall loading', model: withDepth('maintenance', { address: { section: 'wall', need: null }, wall: { loaded: { status: 'loading' }, filter: 'ALL', asOf: null } }) },
    { id: 'wall-error', label: "Status wall couldn't be read", model: withDepth('maintenance', { address: { section: 'wall', need: null }, wall: { loaded: { status: 'error', problem: 'problem.unavailable' }, filter: 'ALL', asOf: null } }) },
    { id: 'wall-empty', label: 'Status wall: no machine in use', model: withDepth('maintenance', { address: { section: 'wall', need: null }, wall: { loaded: { status: 'ready', value: { ...WALL, lines: [], counts: { RUNNING: 0, DOWN: 0, UNDER_MAINTENANCE: 0, DO_NOT_USE: 0, locked: 0 } } }, filter: 'ALL', asOf: WALL.at } }) },
    { id: 'section-dies', label: 'Section Clicking dies (its own register: SCR-150-dies)', model: withDepth('maintenance', { address: { section: 'dies', need: null }, dies: createElement(DiesView, { model: diesSectionDemo('maintenance') }) }) },
  ],
})
