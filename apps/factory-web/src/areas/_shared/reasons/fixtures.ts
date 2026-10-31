import { fieldsOf, REASON_LIST_GROUPS, sourceOf, type ReasonList } from '@nexus/factory-domain/reasons/lists'
import { missingStandardReasons, standardReasonsOf } from '@nexus/factory-domain/reasons/standard'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Reason, ReasonListView } from './api'
import { markKey } from './model'
import { ReasonListsView, type ReasonListsModel } from './view/ReasonListsView'

/**
 * SCR-242 — the shared reason list editor (B-W2a-18; NEW id: the plan gives the part no screen of its own; its hosts are
 * Production › Floor rules & codes "Reason codes" (SCR-088, B-W2a-46), Sales settings return reasons (SCR-235,
 * B-W2a-77) and the other settings pages). Made-up words only (the standard lists every factory starts from), with
 * Romanian words where a plant's tablets also speak it. Each case is one state of the design: the list, saving per cell,
 * rows selected, the new reason dialog (and a code already taken), the icon and colour, an empty list, a role that may
 * only look, a scan list (W2b: every column, as any list), loading, a failed read, no permission, changed by someone else, offline, one list.
 */

const AT = '2026-10-30T08:00:00.000Z'
const RO: Record<string, string> = {
  MATERIAL_WAIT: 'Așteptare material',
  MACHINE: 'Mașină oprită',
  INSTRUCTIONS: 'Așteptare instrucțiuni',
  BREAK: 'Pauză',
}
const USED: Record<string, number> = { MATERIAL_WAIT: 14, MACHINE: 6, BREAK: 31, STAIN: 3, LEATHER_FLAW: 9, WRONG_SIZE: 4 }

function rowsOf(list: ReasonList, extra: (reason: Reason) => Partial<Reason> = () => ({})): Reason[] {
  return standardReasonsOf(list).map((reason, index) => {
    const row: Reason = {
      id: `0190f1a2-0000-7000-8000-${String(REASON_INDEX[list] * 100 + index).padStart(12, '0')}`,
      list,
      code: reason.code,
      labelIt: reason.labelIt,
      labelEn: reason.labelEn,
      labelI18n: list === 'PAUSE' && RO[reason.code] ? { ro: RO[reason.code]! } : {},
      icon: reason.icon,
      colour: reason.colour,
      needsDetail: reason.needsDetail,
      sortOrder: (index + 1) * 10,
      active: true,
      usedCount: USED[reason.code] ?? 0,
      version: 1,
      createdAt: AT,
      updatedAt: AT,
    }
    return { ...row, ...extra(row) }
  })
}
const REASON_INDEX = Object.fromEntries((['PAUSE', 'DOWNTIME', 'HELP_CALL', 'ADJUSTMENT', 'HOLD', 'CANCEL', 'WRITE_OFF', 'RETURN', 'DISCREPANCY', 'CLAIM', 'DOWNGRADE', 'SCRAP', 'REWORK'] as const).map((list, index) => [list, index + 1])) as Record<ReasonList, number>

function viewOf(list: ReasonList, reasons: Reason[]): ReasonListView {
  return {
    list,
    source: sourceOf(list),
    fields: { ...fieldsOf(list) },
    active: reasons.filter((row) => row.active).length,
    inactive: reasons.filter((row) => !row.active).length,
    standardMissing: missingStandardReasons(list, reasons.map((row) => row.code)).map((reason) => reason.code),
    reasons,
  }
}

// The pause list as a plant has it: "Break" set inactive, a reason of its own at the end.
const pauseRows: Reason[] = [
  ...rowsOf('PAUSE', (row) => (row.code === 'BREAK' ? { active: false, version: 3 } : {})),
  { ...rowsOf('PAUSE')[0]!, id: '0190f1a2-0000-7000-8000-000000000199', code: 'TOOL_CHANGE', labelIt: 'Cambio attrezzo', labelEn: 'Tool change', labelI18n: {}, icon: 'zap', colour: '#0e7490', sortOrder: 60, usedCount: 0, needsDetail: false },
]
const pause = viewOf('PAUSE', pauseRows)

const base = (patch: Partial<ReasonListsModel> = {}): ReasonListsModel => ({
  lists: REASON_LIST_GROUPS.floorRules,
  list: 'PAUSE',
  load: { status: 'ready' },
  view: pause,
  languages: ['ro'],
  canManage: true,
  marks: {},
  notice: null,
  changedElsewhere: false,
  busy: false,
  dialog: null,
  ...patch,
})

const machine = pauseRows[1]!
const instructions = pauseRows[2]!
const wait = pauseRows[0]!
const other = pauseRows[4]!

export const designScreen = defineDesignScreen<ReasonListsModel>({
  screen: 'SCR-242',
  title: 'Reason lists (the shared reason list editor)',
  view: ReasonListsView,
  cases: [
    { id: 'floor-rules', label: 'Floor rules & codes: the pause list', model: base(), note: 'The host passes its lists (pause, scrap, rework, downtime, help calls, adjustments, holds, cancellations). Words per language; the Romanian column because plant A1 speaks it. Break is inactive (never deleted).' },
    {
      id: 'saving',
      label: 'Saved per cell',
      model: base({
        marks: {
          [markKey(wait.id, 'lang:ro')]: { state: 'saving' },
          [markKey(machine.id, 'labelEn')]: { state: 'saved' },
          [markKey(instructions.id, 'labelIt')]: { state: 'refused', problem: 'problem.stale' },
          [markKey(other.id, 'needsDetail')]: { state: 'unknown', problem: 'problem.offline' },
        },
      }),
      note: 'One mark per cell: saving (↻), saved (fades), refused with its reason (!, on hover and to a screen reader), not known (?).',
    },
    { id: 'selected', label: 'Rows selected: the bulk actions', model: base({ selected: [machine.id, instructions.id] }), note: 'Set 2 inactive · Set 2 active (held: both active) · Move up · Move down; the count says 2 selected.' },
    { id: 'new-reason', label: 'New reason code', model: base({ dialog: { kind: 'new', draft: { code: 'NO_THREAD', labelIt: 'Filo finito', labelEn: '', words: { ro: 'Ață terminată' }, icon: 'package', colour: '#b87503', needsDetail: false }, problem: null } }), note: 'Add code is held until both Italian and English words are given.' },
    { id: 'new-reason-taken', label: 'New reason: a code already taken (inactive)', model: base({ dialog: { kind: 'new', draft: { code: 'BREAK', labelIt: 'Pausa caffè', labelEn: 'Coffee break', words: {}, icon: 'clock', colour: null, needsDetail: false }, problem: 'problem.codeTakenInactive' } }), note: 'The API refused it in words: set the old code active again instead.' },
    { id: 'look', label: 'Icon and colour of one reason', model: base({ dialog: { kind: 'look', id: machine.id }, marks: { [markKey(machine.id, 'look')]: { state: 'saved' } } }), note: 'Each pick saves at once; the footer says how it went.' },
    { id: 'empty', label: 'A list with no reason yet', model: base({ list: 'DOWNTIME', view: viewOf('DOWNTIME', []) }), note: 'Add the first reason, or the 5 standard ones.' },
    { id: 'read-only', label: 'A role that may only look', model: base({ canManage: false }), note: 'Words only, no switches; New reason held with the reason; no selection.' },
    { id: 'scrap', label: 'Scrap reasons (the operation screen): icon, colour, other languages, needs detail', model: base({ list: 'SCRAP', view: viewOf('SCRAP', rowsOf('SCRAP')) }), note: 'W2b (B-W2b-10, MES-125): ScrapReason keeps an icon, a colour, the other floor languages and "needs detail" like every list; the floor\'s scrap and rework tiles draw them.' },
    { id: 'standard-missing', label: 'Standard reasons missing', model: base({ list: 'HOLD', view: viewOf('HOLD', rowsOf('HOLD').slice(0, 2)), notice: { tone: 'success', key: 'done.created', params: { code: 'SUPPLIER_CHECK' } } }), note: 'The toolbar offers "Add 3 standard reasons"; a notice after a change.' },
    { id: 'loading', label: 'Loading', model: base({ load: { status: 'loading' }, view: null }) },
    { id: 'error', label: "Couldn't load", model: base({ load: { status: 'error', problem: 'problem.read' }, view: null }), note: 'A failed read is never drawn as an empty list.' },
    { id: 'no-permission', label: 'No permission to see the lists', model: base({ load: { status: 'error', problem: 'problem.readForbidden' }, view: null, canManage: false }) },
    { id: 'changed-elsewhere', label: 'Changed by someone else', model: base({ changedElsewhere: true }), note: 'Live reason.changed from another screen: Reload.' },
    { id: 'offline', label: 'Offline while saving', model: base({ marks: { [markKey(machine.id, 'labelIt')]: { state: 'unknown', problem: 'problem.offline' } }, notice: { tone: 'danger', key: 'problem.offline' } }), note: 'The office editor saves online only: a lost answer is "not known", never "saved".' },
    { id: 'one-list', label: 'One list (Sales settings: returns)', model: base({ lists: ['RETURN'], list: 'RETURN', view: viewOf('RETURN', rowsOf('RETURN')) }), note: 'A host with one list shows no switch.' },
    { id: 'keys', label: 'The keys', model: base({ dialog: { kind: 'keys' } }) },
  ],
})
