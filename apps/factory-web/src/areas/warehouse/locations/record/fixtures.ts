import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, inShell, LOCATIONS, NOW, PREFIX, ROLE_PERMISSIONS, TIME_ZONE, type RoleCase } from '../../../_shared/stock/fixtures'
import { NORTH_ALL, overviewOf } from '../demo/fixtures'
import { locationsCan, type RecordTab } from '../model'
import { LocationRecordView, type LocationRecordModel } from './view/LocationRecordView'
// B-W2b-327: the block, the kinds' profiles, Default for, the Labels tab, Print labels.
import { BIN_LABEL, DEFAULTS, PLACES, PRINTERS, RACK_LABEL } from '../../stock/depth/demo/fixtures'
import type { PlaceSite } from '../depth/api'

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
      permissions: ROLE_PERMISSIONS[role],
      today: '2026-10-30',
      ...over,
    },
  }
}

function LocationRecordDesign({ model }: { model: { role: RoleCase; model: LocationRecordModel } }) {
  return inShell('/warehouse/locations', createElement(LocationRecordView, { model: model.model }), model.role)
}

const BIN = LOCATIONS.binA1.id
const RACK = LOCATIONS.rackA.id

// ---- B-W2b-327 ------------------------------------------------------------------------------------------------------------
const DEPTH: PlaceSite = { ...NORTH_ALL, locations: PLACES }
const deep = (role: RoleCase, locationId: string, over: Partial<LocationRecordModel> = {}, tab: RecordTab = 'overview') => base(role, locationId, { record: { status: 'ready', site: DEPTH }, defaults: DEFAULTS, ...over }, tab)
const code = (value: string) => PLACES.find((place) => place.code === value)!.id
const W2B_CASES: { id: string; label: string; model: { role: RoleCase; model: LocationRecordModel }; note?: string }[] = [
  { id: 'w2b-count-blocked', label: 'W2b · Bin A1 blocked while count CNT-D-0007 runs: the banner, Open the count; Block held (the count lifts it)', model: deep('warehouse', BIN) },
  { id: 'w2b-damage-blocked', label: 'W2b · The quarantine shelf blocked for damage until 2 Nov (its note, since when); Default for Quality', model: deep('warehouse', LOCATIONS.quarantine.id) },
  { id: 'w2b-defaults', label: 'W2b · The goods-in dock: what it holds (any goods, a dock) and Default for Receiving', model: deep('owner', LOCATIONS.receiving.id) },
  { id: 'w2b-transit', label: 'W2b · A transit place: between two sites, only a transfer moves its goods, no label; its kind stays what it is', model: deep('warehouse', code('N-TRANSIT')) },
  { id: 'w2b-labels', label: 'W2b · Labels tab of rack A: the bin label to scale, the last job (not printed: Reprint), the code, the history', model: deep('warehouse', RACK, { label: { status: 'ready', value: RACK_LABEL } }, 'labels') },
  { id: 'w2b-labels-suggested', label: 'W2b · Labels tab of bin A2: no code yet — the label shows the one it gets; Give it STAB-N-N-MAG-A-02', model: deep('warehouse', LOCATIONS.binA2.id, { label: { status: 'ready', value: BIN_LABEL } }, 'labels') },
  { id: 'w2b-labels-change', label: 'W2b · Labels tab: a new code typed — labels already printed with the old code will no longer scan', model: deep('warehouse', RACK, { label: { status: 'ready', value: RACK_LABEL }, labelCodeDraft: 'MAG-A' }, 'labels') },
  { id: 'w2b-labels-read-only', label: 'W2b · Labels tab, read-only: the label and its history, no code change; prints as a PDF only', model: deep('readOnly', RACK, { label: { status: 'ready', value: RACK_LABEL } }, 'labels') },
  { id: 'w2b-labels-transit', label: 'W2b · Labels tab of a transit place: it carries no label (said in words)', model: deep('warehouse', code('N-TRANSIT'), {}, 'labels') },
  { id: 'w2b-labels-loading', label: 'W2b · Labels tab being read', model: deep('warehouse', RACK, { label: { status: 'loading' } }, 'labels') },
  { id: 'w2b-labels-error', label: 'W2b · Labels tab: the label could not be read (Try again)', model: deep('warehouse', RACK, { label: { status: 'error', problem: 'problem.offline' } }, 'labels') },
  { id: 'w2b-print', label: 'W2b · Print label of rack A on the warehouse label printer', model: deep('warehouse', RACK, { label: { status: 'ready', value: RACK_LABEL }, print: { places: [PLACES.find((place) => place.id === RACK)!], siteCode: NORTH_ALL.code, draft: { printerId: PRINTERS[0]!.id, copies: 1, language: 'it' }, printers: { status: 'ready', value: PRINTERS }, posting: false, problem: null, done: null } }, 'labels') },
  { id: 'w2b-block', label: 'W2b · Block… from the record (rack A)', model: deep('warehouse', RACK, { depthDialog: { kind: 'block', locationId: RACK } }) },
]


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
    ...W2B_CASES,
  ],
})

