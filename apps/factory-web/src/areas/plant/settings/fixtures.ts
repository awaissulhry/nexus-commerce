import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { LEAST_RETENTION_YEARS } from '@nexus/factory-domain/plant/statutory/rules'
import { at, CLASS_LIST, CLASSES, inShell, SYMPTOM_LIST, type PlantRole } from '../_shared/fixtures'
import type { ClassRow, SymptomRow } from './api'
import { DEMO_EMPLOYEES, DEMO_INCIDENT_RULES, DEMO_LOCK, DEMO_PEOPLE, DEMO_RULES, DEMO_TEAMS, DEMO_TYPES, demoDepth } from './_demo/fixtures'
import { blankRule, blankType, lockDraftOf, ruleDraftOf, typeDraftOf } from './depth-model'
import type { DepthModel } from './depth-view-model'
import { ALL, EMPTY_DRAFT, EVERY, markKey } from './model'
import { PlantSettingsView, type PlantSettingsModel } from './view/PlantSettingsView'

/**
 * SCR-241 — Plant › Settings › Plant settings: the W2a section "Symptoms on the floor" (B-W2a-73; NEW id given by W2A-PLAN
 * §10) and, from B-W2b-141, the W2b sections around it (routing and escalation, the unsafe lock, statutory check types,
 * incidents, the band; made-up data in _demo/fixtures.ts). Every case draws the whole page. Made-up data only: the Plant pages' invented group (machine types and symptoms as
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
    depth: demoDepth(role),
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

/** A W2b case: the role's page with its W2b sections changed. */
const depth = (role: PlantRole, over: Partial<DepthModel> = {}, page: Partial<PlantSettingsModel> = {}): SettingsCase => {
  const made = base(role, page)
  return { role, model: { ...made.model, depth: { ...made.model.depth, ...over } } }
}
const pickers = { status: 'ready' as const, value: { teams: DEMO_TEAMS, employees: DEMO_EMPLOYEES } }
const routingOf = (role: PlantRole) => demoDepth(role).routing
const checksOf = (role: PlantRole) => demoDepth(role).checks
const lockOf = (role: PlantRole) => demoDepth(role).lock

/** B-W2b-141: the W2b sections' cases (the production manager holds people.view: the pickers; the maintenance lead does not). */
const DEPTH_CASES = [
  {
    id: 'routing',
    label: 'Routing and escalation: the site\'s rules and where a request goes',
    model: depth('production'),
    note: 'Order · machine type · goes to · notice · escalation · state · used. "Where does a request go?" answers for a lockstitch in words. The heat press rule is switched off; the last rule takes every machine type.',
  },
  { id: 'routing-selected', label: 'Rules selected: the bulk actions', model: depth('production', { routing: { ...routingOf('production'), selected: [DEMO_RULES[1]!.id, DEMO_RULES[2]!.id] } }), note: 'Switch on 2 · Switch off 2 · Move up · Move down (⌥↑ / ⌥↓) · Remove 2.' },
  { id: 'routing-empty', label: 'No routing rule yet', model: depth('production', { routing: { ...routingOf('production'), read: { status: 'ready', value: { siteId: DEMO_RULES[0]!.siteId, rules: [], canManage: true } }, preview: { classId: null, read: { status: 'idle' } } } }), note: 'Every request waits in the triage queue until a rule is added.' },
  { id: 'routing-loading', label: 'Routing loading', model: depth('production', { routing: { ...routingOf('production'), read: { status: 'loading' } } }) },
  { id: 'routing-error', label: "Routing couldn't load", model: depth('production', { routing: { ...routingOf('production'), read: { status: 'error', problem: 'problem.read' } } }), note: 'Only this card fails; the others keep working. Never drawn as empty.' },
  {
    id: 'preview-none',
    label: 'Where does a request go: no rule fits',
    model: depth('production', { routing: { ...routingOf('production'), read: { status: 'ready', value: { siteId: DEMO_RULES[0]!.siteId, rules: DEMO_RULES.slice(0, 3), canManage: true } }, preview: { classId: CLASSES.cuttingTable.id, read: { status: 'ready', value: { rule: null } } } } }),
    note: 'Without the rule for every machine type a cutting table\'s request waits in the triage queue.',
  },
  {
    id: 'rule-new',
    label: 'New rule: the worked example before you save',
    model: depth('production', { dialog: { kind: 'rule', draft: { ...blankRule(CLASSES.postBed.id), teamId: DEMO_TEAMS[0]!.id, targetName: 'L1 Squadra giacche', escalate: true, escalateToId: DEMO_PEOPLE.marco.id, escalateToName: DEMO_PEOPLE.marco.name }, busy: false, problem: null, pickers } }),
    note: 'The sentences under the form change as you type: where it goes, the notice, the escalation.',
  },
  { id: 'rule-edit', label: 'Open a rule', model: depth('production', { dialog: { kind: 'rule', draft: ruleDraftOf(DEMO_RULES[0]!), busy: false, problem: null, pickers } }), note: 'Save rule is held until something changed. Remove rule asks first.' },
  {
    id: 'rule-held',
    label: 'Rule: the second escalation before the first is held',
    model: depth('production', { dialog: { kind: 'rule', draft: { ...ruleDraftOf(DEMO_RULES[0]!), escalateAgainAfterMinutes: 5 }, busy: false, problem: null, pickers } }),
    note: 'Save rule is held with its reason (focus or hover says it).',
  },
  {
    id: 'rule-no-people',
    label: 'Maintenance lead: no people.view for the pickers',
    model: depth('maintenance', { dialog: { kind: 'rule', draft: ruleDraftOf(DEMO_RULES[1]!), busy: false, problem: null, pickers: { status: 'forbidden' } } }),
    note: 'The rule keeps the people it names; minutes, notice, order and on/off still change. The gap is in the notes (a plant picker under plant.settings.manage).',
  },
  {
    id: 'rule-refused',
    label: 'Rule refused by the API, at the field',
    model: depth('production', { dialog: { kind: 'rule', draft: ruleDraftOf(DEMO_RULES[0]!), busy: false, problem: { key: 'field.teamId', field: 'teamId', unknown: false }, pickers } }),
  },
  {
    id: 'rule-remove',
    label: 'Remove a used rule: switched off and kept',
    model: depth('production', { dialog: { kind: 'rule', draft: ruleDraftOf(DEMO_RULES[0]!), busy: false, problem: null, pickers, confirmRemove: true } }),
    note: '14 requests name it, so it is switched off, never deleted.',
  },
  { id: 'rules-remove', label: 'Remove 2 rules', model: depth('production', { dialog: { kind: 'removeRules', ids: [DEMO_RULES[1]!.id, DEMO_RULES[2]!.id], busy: false, problem: null } }), note: 'What happens to each, said before.' },
  { id: 'rule-read-only', label: 'Floor supervisor opens a rule: read only', model: depth('supervisor', { dialog: { kind: 'rule', draft: ruleDraftOf(DEMO_RULES[0]!), busy: false, problem: null, pickers: { status: 'forbidden' } } }), note: 'The worked example is there to read; nothing changes.' },
  {
    id: 'lock-h1',
    label: 'Unsafe lock: another choice is held by Owner answer H1',
    model: depth('maintenance', { lock: { ...lockOf('maintenance'), draft: { ...lockDraftOf(DEMO_LOCK), lockBy: 'LEADS_AND_TECHNICIANS' } } }),
    note: 'Apply is held with the reason; the API refuses the same (409 refusal/H1_HELD).',
  },
  {
    id: 'lock-hazard-off',
    label: 'Unsafe lock: hazard report switched off asks the code',
    model: depth('maintenance', { lock: { ...lockOf('maintenance'), draft: { ...lockDraftOf(DEMO_LOCK), hazardReportOnLock: false } }, save: { kind: 'unsaved' } }),
    note: 'A loosening: said in words, and Apply asks the authenticator code (⌘S works too).',
  },
  {
    id: 'lock-step-up',
    label: 'Unsafe lock: the fresh code',
    model: depth('maintenance', { lock: { ...lockOf('maintenance'), draft: { ...lockDraftOf(DEMO_LOCK), hazardReportOnLock: false }, busy: true }, stepUp: { open: true, busy: false, sentence: 'stepUp.lock', problem: null }, save: { kind: 'saving' } }),
  },
  {
    id: 'lock-step-up-wrong',
    label: 'Unsafe lock: a wrong code',
    model: depth('maintenance', { lock: { ...lockOf('maintenance'), draft: { ...lockDraftOf(DEMO_LOCK), hazardReportOnLock: false }, busy: true }, stepUp: { open: true, busy: false, sentence: 'stepUp.lock', problem: 'stepUp.problem.wrong' }, save: { kind: 'saving' } }),
  },
  {
    id: 'lock-refused',
    label: 'Unsafe lock refused by the API',
    model: depth('maintenance', { lock: { ...lockOf('maintenance'), draft: { ...lockDraftOf(DEMO_LOCK), hazardReportOnLock: false }, problem: { key: 'problem.staleSettings', unknown: false } }, save: { kind: 'failed', count: 1 } }),
  },
  { id: 'lock-defaults', label: 'Unsafe lock: nothing saved yet (H1 defaults)', model: depth('maintenance', { lock: { ...lockOf('maintenance'), read: { status: 'ready', value: { ...DEMO_LOCK, version: null } } } }) },
  { id: 'lock-loading', label: 'Unsafe lock loading', model: depth('maintenance', { lock: { ...lockOf('maintenance'), read: { status: 'loading' } } }) },
  { id: 'checks-new', label: 'New check type', model: depth('maintenance', { dialog: { kind: 'type', draft: { ...blankType(LEAST_RETENTION_YEARS), code: 'NOISE_LEVEL', labelIt: 'Misura del rumore' }, busy: false, problem: null } }), note: 'No interval is offered: the office types each check\'s law and interval. Kept at least the years the API says.' },
  { id: 'checks-edit', label: 'Open a check type', model: depth('maintenance', { dialog: { kind: 'type', draft: typeDraftOf(DEMO_TYPES[1]!), busy: false, problem: null } }), note: 'Code and machine type are fixed; Retire is beside Save.' },
  { id: 'checks-taken', label: 'New check type: the code is taken', model: depth('maintenance', { dialog: { kind: 'type', draft: { ...blankType(LEAST_RETENTION_YEARS), code: 'EARTHING_2', labelIt: 'Terra', labelEn: 'Earthing', legalBasis: 'DPR 462/2001 (esempio)', defaultInterval: 2, defaultIntervalUnit: 'YEAR' }, busy: false, problem: { key: 'refusal.TYPE_TAKEN', field: 'code', unknown: false } } }) },
  { id: 'checks-retired', label: 'Check types: the retired ones', model: depth('maintenance', { checks: { ...checksOf('maintenance'), rows: 'retired' } }) },
  { id: 'checks-selected', label: 'Check types selected: Retire · Make active again', model: depth('maintenance', { checks: { ...checksOf('maintenance'), rows: 'all', selected: [DEMO_TYPES[0]!.id, DEMO_TYPES[3]!.id] } }) },
  { id: 'checks-retire', label: 'Retire 1 check type', model: depth('maintenance', { dialog: { kind: 'typeState', ids: [DEMO_TYPES[0]!.id], active: false, busy: false, problem: null } }), note: 'Its plans keep their dates; no new plan may use it.' },
  { id: 'checks-read-only', label: 'Floor supervisor: check types read only', model: depth('supervisor'), note: 'No selection; New check type held with its reason.' },
  { id: 'checks-error', label: "Check types couldn't load", model: depth('maintenance', { checks: { ...checksOf('maintenance'), read: { status: 'error', problem: 'problem.offlineSettings' } } }) },
  { id: 'incidents-no-right', label: 'Incidents: without safety.incidents.view', model: depth('maintenance', { incidents: { status: 'forbidden' } }), note: 'The card says which right it needs.' },
  { id: 'incidents-loading', label: 'Incidents loading', model: depth('maintenance', { incidents: { status: 'loading' } }) },
  { id: 'incidents', label: 'Incidents: the INAIL rule with its law (read only)', model: depth('production', { incidents: { status: 'ready', value: DEMO_INCIDENT_RULES } }), note: 'The numbers are the API\'s (the law\'s); the reminders are Nexus\'s own, said apart.' },
  { id: 'all-sites', label: 'All sites in the top bar: the site chosen here', model: depth('production', { siteFromTopBar: false }), note: 'The routing and the lock are per site: a Select in the band (kept in the address, ?site=).' },
  { id: 'changed-settings', label: 'Routing changed by someone else', model: depth('production', { changedElsewhere: true }), note: 'Live plant_settings.changed from another person: Reload.' },
  { id: 'notice', label: 'After removing rules', model: depth('production', { notice: { tone: 'success', key: 'done.rulesRemoved', params: { deleted: 1, switched: 1 } } }) },
  { id: 'leave', label: 'Leaving with the lock card changed', model: depth('maintenance', { lock: { ...lockOf('maintenance'), draft: { ...lockDraftOf(DEMO_LOCK), hazardReportOnLock: false } }, leaving: { busy: false }, save: { kind: 'unsaved' } }), note: 'Save · Discard · Stay.' },
  { id: 'page-keys', label: 'Every key of the page', model: depth('production', { dialog: { kind: 'keys' } }) },
  { id: 'no-audit', label: 'Maintenance lead: History held without audit.read', model: depth('maintenance'), note: 'The ⋯ menu says why History is held.' },
]

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
    ...DEPTH_CASES,
  ],
})
