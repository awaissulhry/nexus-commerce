import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { at, CLASS_LIST, CLASSES, inShell, SYMPTOM_LIST, type PlantRole } from '../_shared/fixtures'
import type { ClassRow, SymptomRow } from './api'
import { ALL, EMPTY_DRAFT, EVERY, markKey } from './model'
import { PlantSettingsView, type PlantSettingsModel } from './view/PlantSettingsView'

/**
 * SCR-241 — Plant › Settings › Plant settings, its W2a section "Symptoms on the floor" (B-W2a-73; NEW id given by W2A-PLAN
 * §10: a W2a section on the W2b page). Made-up data only: the Plant pages' invented group (machine types and symptoms as
 * the starter set words them, how often each was reported, one symptom of the group's own, one taken off the floor).
 * Roles from factory-domain's templates: the maintenance lead and the production manager keep the list
 * (plant.machines.manage over every company), the floor supervisor and read-only only look, sales has no plant.view.
 */

interface SettingsCase {
  role: PlantRole
  model: PlantSettingsModel
}

const AT = at(29, 16, 5)
const USED: Record<string, number> = { WONT_START: 12, NOISE: 7, OIL_LEAK: 4, GUARD_MISSING: 2, OTHER: 9, THREAD_BREAKS: 21, SKIPPED_STITCHES: 6, TWO_HAND_CONTROL: 1 }

const classRow = (entry: (typeof CLASS_LIST)[number], index: number, machines: number): ClassRow => ({ ...entry, sortOrder: index, active: true, machines, version: 1, updatedAt: AT })
const CLASS_ROWS: ClassRow[] = [...CLASS_LIST.map((entry, index) => classRow(entry, index, [6, 2, 1, 1, 1, 1][index] ?? 0)), { id: '0190f0e2-3131-7000-8000-000000000099', code: 'ZIG_ZAG', labelIt: 'Zig-zag', labelEn: 'Zig-zag', labelI18n: {}, icon: 'needle', sortOrder: 9, active: false, machines: 0, version: 2, updatedAt: AT }]

const symptomRow = (entry: (typeof SYMPTOM_LIST)[number], index: number): SymptomRow => ({ ...entry, sortOrder: index * 10, requests: USED[entry.code] ?? 0, version: 1, updatedAt: AT })
const BELT: SymptomRow = {
  id: '0190f0e2-3232-7000-8000-000000000050',
  code: 'BELT_SLIPS',
  classId: CLASSES.lockstitch.id,
  labelIt: 'La cinghia slitta',
  labelEn: 'Belt slips',
  labelI18n: {},
  icon: 'activity',
  colour: null,
  unsafe: false,
  needsDetail: false,
  active: false,
  sortOrder: 90,
  requests: 3,
  version: 4,
  updatedAt: AT,
}
const ROWS: SymptomRow[] = [...SYMPTOM_LIST.map(symptomRow), BELT]
const row = (code: string) => ROWS.find((entry) => entry.code === code)!

const base = (role: PlantRole, over: Partial<PlantSettingsModel> = {}): SettingsCase => ({
  role,
  model: {
    canView: role !== 'sales',
    load: { status: 'ready' },
    symptoms: ROWS,
    classes: CLASS_ROWS,
    starterMissing: [],
    canManage: role === 'maintenance' || role === 'production' || role === 'owner',
    classFilter: ALL,
    marks: {},
    notice: null,
    changedElsewhere: false,
    busy: false,
    dialog: null,
    ...over,
  },
})

function SettingsDesign({ model }: { model: SettingsCase }) {
  return inShell('/plant/settings', createElement(PlantSettingsView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<SettingsCase>({
  screen: 'SCR-241',
  title: 'Plant settings › Symptoms on the floor',
  view: SettingsDesign,
  cases: [
    { id: 'list', label: 'Maintenance lead: every symptom of the group', model: base('maintenance'), note: 'Code · icon · Italian · English · for · locks the machine · asks for words · on the floor · used. "Belt slips" is off the floor (never deleted: 3 reports name it). c adds a symptom.' },
    {
      id: 'class',
      label: 'One machine type: what a lockstitch station offers',
      model: base('maintenance', { classFilter: CLASSES.lockstitch.id }),
      note: 'Its own symptoms and those for every machine, as its stations show them; the line above the list counts the offered ones.',
    },
    { id: 'every', label: 'Only the symptoms for every machine', model: base('production', { classFilter: EVERY }) },
    {
      id: 'saving',
      label: 'Saved per cell',
      model: base('maintenance', {
        marks: {
          [markKey(row('NOISE').id, 'labelIt')]: { state: 'saving' },
          [markKey(row('OIL_LEAK').id, 'icon')]: { state: 'saved' },
          [markKey(row('THREAD_BREAKS').id, 'needsDetail')]: { state: 'saving' },
        },
      }),
      note: 'One mark per cell: saving (↻), saved (fades).',
    },
    {
      id: 'refused',
      label: 'A cell refused, in words',
      model: base('maintenance', {
        marks: {
          [markKey(row('SKIPPED_STITCHES').id, 'labelEn')]: { state: 'refused', problem: 'problem.stale' },
          [markKey(row('WONT_START').id, 'labelIt')]: { state: 'refused', problem: 'problem.labelIt' },
        },
      }),
      note: 'The value before is put back; the reason is on the mark (hover, and to a screen reader).',
    },
    { id: 'selected', label: 'Rows selected: the bulk actions', model: base('maintenance', { selected: [row('NOISE').id, row('OIL_LEAK').id] }), note: 'Stop offering 2 · Offer 2 again (held: both offered) · Move up · Move down.' },
    {
      id: 'new',
      label: 'New symptom',
      model: base('maintenance', { dialog: { kind: 'new', draft: { ...EMPTY_DRAFT, code: 'BOBBIN_JAMS', classId: CLASSES.lockstitch.id, labelIt: 'La spolina si blocca', icon: 'needle' }, problem: null } }),
      note: 'Add symptom is held until both Italian and English words are given.',
    },
    {
      id: 'new-unsafe',
      label: 'New symptom that locks the machine',
      model: base('maintenance', { dialog: { kind: 'new', draft: { ...EMPTY_DRAFT, code: 'BLADE_EXPOSED', classId: CLASSES.cuttingTable.id, labelIt: 'Lama scoperta', labelEn: 'Blade exposed', icon: 'shield-off', unsafe: true }, problem: null } }),
      note: 'The banner says each report stops the machine at once until a technician signs it safe.',
    },
    {
      id: 'code-taken',
      label: 'New symptom: a code already taken (off the floor)',
      model: base('maintenance', { dialog: { kind: 'new', draft: { ...EMPTY_DRAFT, code: 'BELT_SLIPPING', labelIt: 'Cinghia', labelEn: 'Belt' }, problem: 'problem.codeTakenRetired' } }),
      note: 'The API refused it: offer the old code again instead.',
    },
    { id: 'icon', label: 'The icon of one symptom', model: base('maintenance', { dialog: { kind: 'icon', id: row('OIL_LEAK').id }, marks: { [markKey(row('OIL_LEAK').id, 'icon')]: { state: 'saved' } } }), note: 'Each pick saves at once; the footer says how it went. Arrow keys move the pick.' },
    { id: 'unsafe-off', label: '"Locks the machine" switched off: asked first', model: base('maintenance', { dialog: { kind: 'unsafeOff', id: row('GUARD_MISSING').id } }), note: 'A loosening of a safety rule: said in words before it is saved; anyone can still mark a machine unsafe on the report.' },
    {
      id: 'starter',
      label: 'Starter codes missing: Add N',
      model: base('maintenance', { starterMissing: ['ELECTRICAL_FAULT', 'CNC_CUTTER', 'SKIVING'], symptoms: ROWS.filter((entry) => entry.code !== 'ELECTRICAL_FAULT'), notice: { tone: 'success', key: 'done.created', params: { code: 'BELT_SLIPS' } } }),
      note: 'The toolbar offers "Add 3 from the starter set" (symptoms and machine types the group lacks); a notice after a change.',
    },
    { id: 'empty', label: 'No symptom yet', model: base('maintenance', { symptoms: [], starterMissing: ['WONT_START', 'NOISE', 'OIL_LEAK', 'GUARD_MISSING', 'OTHER'] }), note: 'Add the starter set, or the first symptom.' },
    { id: 'read-only', label: 'Floor supervisor: may only look', model: base('supervisor'), note: 'No switches, no selection; New symptom held with its reason.' },
    { id: 'read-only-role', label: 'Read-only', model: base('readOnly') },
    { id: 'no-permission', label: 'Sales: no plant.view', model: base('sales', { symptoms: null, classes: [] }), note: 'The page says so and reads nothing.' },
    { id: 'changed-elsewhere', label: 'Changed by someone else', model: base('maintenance', { changedElsewhere: true }), note: 'Live plant.lists_changed from another screen: Reload.' },
    {
      id: 'offline',
      label: 'Offline while saving',
      model: base('maintenance', { marks: { [markKey(row('NOISE').id, 'labelEn')]: { state: 'unknown', problem: 'problem.offline' } }, notice: { tone: 'danger', key: 'problem.offline' } }),
      note: 'A lost answer is "not known", never "saved".',
    },
    { id: 'loading', label: 'Loading', model: base('maintenance', { load: { status: 'loading' }, symptoms: null, classes: [] }) },
    { id: 'error', label: "Couldn't load", model: base('maintenance', { load: { status: 'error', problem: 'problem.read' }, symptoms: null, classes: [] }), note: 'A failed read is never drawn as an empty list.' },
    { id: 'keys', label: 'The keys', model: base('maintenance', { dialog: { kind: 'keys' } }) },
  ],
})
