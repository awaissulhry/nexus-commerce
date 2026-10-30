import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, inShell, LOCATIONS, NOW, PREFIX, ROLE_PERMISSIONS, TIME_ZONE, type RoleCase } from '../../../_shared/stock/fixtures'
import { NORTH_ALL, overviewOf } from '../demo/fixtures'
import { locationsCan, type RecordTab } from '../model'
import { LocationRecordView, type LocationRecordModel } from './view/LocationRecordView'

/**
 * Design cases of SCR-065's Location record (made-up data: ../demo.ts): bin N-MAG-A-01 with three hides, rack A with its
 * two bins (the stock of the places inside), the archived mezzanine (read only), and the states.
 */

function base(role: RoleCase, locationId: string, over: Partial<LocationRecordModel> = {}, tab: RecordTab = 'overview'): { role: RoleCase; model: LocationRecordModel } {
  const can = locationsCan(ROLE_PERMISSIONS[role])
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      locationId,
      record: { status: 'ready', site: NORTH_ALL },
      stock: { value: can.stock ? overviewOf(can.cost) : null, problem: null },
      tab,
      includeInside: false,
      asOf: NOW,
      live: 'live',
      updates: 0,
      timeZone: TIME_ZONE,
      busy: false,
      conflict: false,
      savedAt: null,
      notice: null,
      ...over,
    },
  }
}

function LocationRecordDesign({ model }: { model: { role: RoleCase; model: LocationRecordModel } }) {
  return inShell('/warehouse/locations', createElement(LocationRecordView, { model: model.model }), model.role)
}

const BIN = LOCATIONS.binA1.id
const RACK = LOCATIONS.rackA.id

export const designScreen = defineDesignScreen<{ role: RoleCase; model: LocationRecordModel }>({
  screen: 'SCR-065-record',
  title: 'A location (Warehouse › Settings › Locations)',
  view: LocationRecordDesign,
  cases: [
    { id: 'bin', label: 'Bin N-MAG-A-01: facts, name and kind, what lies here; Archive held (3 hides)', model: base('owner', BIN), note: 'Type a new name: the save bar counts the change; ⌘S saves.' },
    { id: 'rack', label: 'Rack A: two bins inside, nothing lying on the rack itself', model: base('warehouse', RACK) },
    { id: 'editing', label: 'Editing: a new name, unsaved (save bar)', model: base('warehouse', BIN, { draft: { name: 'Ripiano A1 · pelli nere', kind: 'BIN' } }) },
    { id: 'editing-empty-name', label: 'Editing: the name emptied (Save held, the field says why)', model: base('warehouse', BIN, { draft: { name: '', kind: 'BIN' } }) },
    { id: 'saved', label: 'Saved: “All changes saved · 10:42”', model: base('warehouse', BIN, { savedAt: at(30, 9, 42) }) },
    { id: 'conflict', label: 'Saved by someone else meanwhile: Reload', model: base('warehouse', BIN, { conflict: true, draft: { name: 'Ripiano A1 nuovo', kind: 'BIN' } }) },
    { id: 'stock', label: 'Stock tab: what lies in bin A1 (lots and hides link to their records)', model: base('owner', BIN, {}, 'stock') },
    { id: 'stock-inside', label: 'Stock tab of rack A with “Include the places inside”', model: base('warehouse', RACK, { includeInside: true }, 'stock') },
    { id: 'stock-nothing', label: 'Stock tab of rack A alone: “Nothing here” (try including the places inside)', model: base('warehouse', RACK, {}, 'stock') },
    { id: 'stock-updates', label: 'Stock moved meanwhile: “1 update · Show”', model: base('warehouse', BIN, { updates: 1 }, 'stock') },
    { id: 'archived', label: 'The archived mezzanine: read only (info banner)', model: base('warehouse', LOCATIONS.old.id) },
    { id: 'move', label: 'Move under… open', model: base('warehouse', LOCATIONS.binA2.id, { dialog: { kind: 'move', locationId: LOCATIONS.binA2.id } }) },
    { id: 'read-only', label: 'Read-only person: fields as text, no actions', model: base('readOnly', BIN) },
    { id: 'quality', label: 'Quality: sees the place and its stock, changes nothing', model: base('quality', BIN, {}, 'stock') },
    { id: 'no-permission', label: 'Sales: no permission (inventory.locations.view)', model: base('sales', BIN) },
    { id: 'loading', label: 'Loading', model: base('warehouse', BIN, { record: { status: 'loading' } }) },
    { id: 'not-found', label: 'Not found or another company’s: Back to the list', model: base('warehouse', BIN, { record: { status: 'not_found' } }) },
    { id: 'error', label: 'The read failed: Try again', model: base('warehouse', BIN, { record: { status: 'error', problem: 'problem.offline' } }) },
    { id: 'stock-failed', label: 'The stock could not be read: said with Try again', model: base('warehouse', BIN, { stock: { value: null, problem: 'problem.read' } }, 'stock') },
  ],
})

