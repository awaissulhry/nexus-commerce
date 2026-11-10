import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, NOW, PREFIX } from '../../library/demo'
import { OPERATIONS, SHOULDER } from '../fixtures'
import { OperationRecordView, type OperationRecordViewModel } from './view/OperationRecordView'
// B-W2b-235: Minutes in depth and Machine & settings (made-up data).
import { minutesModel, settingsModel } from '../depth/demo'

/**
 * SCR-049 the operation record — made-up data only: a shoulder seam at 6.2 min used in five routings, two with other
 * minutes (a draft that may take the library value, a released one that stays frozen), an unused finishing operation.
 * Role cases: the Owner, a product developer (keeps the library and routings), quality (reads).
 */

const base: OperationRecordViewModel = {
  prefix: PREFIX,
  can: canFor('owner'),
  tab: 'definition',
  operation: { status: 'ready', value: SHOULDER },
  save: { state: 'idle', at: null },
  busy: false,
  notice: null,
  changed: null,
  refused: null,
  dialog: null,
}
const unused: OperationRecordViewModel = { ...base, operation: { status: 'ready', value: { ...OPERATIONS[4]!, instructions: null, createdAt: NOW, createdById: null, whereUsed: [] } } }

export const designScreen = defineDesignScreen<OperationRecordViewModel>({
  screen: 'SCR-049-operation',
  title: 'Operation record',
  view: OperationRecordView,
  cases: [
    { id: 'definition', label: 'Definition (Owner)', model: base, note: 'The code is frozen once a routing copied it, said under the field; names in each floor language.' },
    { id: 'definition-unused', label: 'Definition: not used yet', model: unused, note: 'The code still changes.' },
    { id: 'definition-quality', label: 'Definition: quality (reads)', model: { ...base, can: canFor('quality') }, note: 'Fields drawn as text, never greyed inputs.' },
    { id: 'minutes', label: 'Minutes', model: { ...base, tab: 'minutes' }, note: 'A new SMV goes to new routings; routings keep their own minutes.' },
    { id: 'where-used', label: 'Where used', model: { ...base, tab: 'whereused' }, note: 'Only draft steps that differ can take the library value; released and obsolete rows say why on their box.' },
    { id: 'where-used-selected', label: 'Where used: a draft selected', model: { ...base, tab: 'whereused', selected: [SHOULDER.whereUsed[0]!.stepId] }, note: 'Update 1 to the library value.' },
    { id: 'where-used-confirm', label: 'Update to the library value', model: { ...base, tab: 'whereused', selected: [SHOULDER.whereUsed[0]!.stepId], updateOpen: true }, note: 'Old → new minutes per step before the click.' },
    { id: 'where-used-developer', label: 'Where used: product developer', model: { ...base, can: canFor('developer'), tab: 'whereused', selected: [SHOULDER.whereUsed[0]!.stepId] } },
    { id: 'where-used-quality', label: 'Where used: quality (no routing right)', model: { ...base, can: canFor('quality'), tab: 'whereused', selected: [SHOULDER.whereUsed[0]!.stepId] }, note: 'The update is held: changing a routing needs product.routing.manage.' },
    { id: 'where-used-none', label: 'Where used: none', model: { ...unused, tab: 'whereused' } },
    { id: 'saved', label: 'Just saved', model: { ...base, save: { state: 'idle', at: NOW }, notice: { key: 'operation.notice.updated', tone: 'success', params: { count: 1 } } } },
    { id: 'refused', label: 'A code change refused', model: { ...base, save: { state: 'failed', at: null }, notice: { key: 'problem.write.invalid', tone: 'danger' }, refused: { key: 'problem.write.invalid', reload: false, paths: ['code'], messages: ['Routings copied the code DEMO-CUC-SPALLA: it no longer changes. Make a new operation instead.'] } } },
    { id: 'archived', label: 'Archived', model: { ...base, operation: { status: 'ready', value: { ...SHOULDER, status: 'ARCHIVED' } } } },
    { id: 'archive-dialog', label: 'Archive', model: { ...base, dialog: 'archive' } },
    { id: 'changed', label: 'Changed meanwhile', model: { ...base, changed: { at: NOW } } },
    { id: 'loading', label: 'Loading', model: { ...base, operation: { status: 'loading' } } },
    { id: 'error', label: 'Could not load', model: { ...base, operation: { status: 'error', problem: 'problem.read.unavailable' } } },
    { id: 'not-found', label: 'Not found', model: { ...base, operation: { status: 'notFound' } } },
    { id: 'no-permission', label: 'No access (sales)', model: { ...base, can: canFor('sales'), operation: { status: 'forbidden' } } },
    // ---- B-W2b-235: Minutes in depth, Propose SMV change, decisions, Machine & settings ------------------------------------
    { id: 'w2b-235-minutes', label: 'W2b: Minutes (governed, a change waiting)', model: minutes(), note: 'SMV in force 6.2 (version 2 from 20 Oct) = 5.5 min + 12.7 %; "Changes need approval"; version 4 (6.5 from 12 Nov) waits — Approve / Reject for this reader (proposed by Demo Planner); the versions newest first with who, when and why; routings and piece rates affected; People › Piece rates; Changes & versions comes with its page.' },
    { id: 'w2b-235-minutes-own', label: 'W2b: a change I proposed', model: minutes({ userId: '0190f0e2-4705-7000-8000-000000000002' }), note: 'No Approve / Reject: "You proposed this change: a second person decides it."' },
    { id: 'w2b-235-minutes-first', label: 'W2b: Minutes, no approved version yet', model: minutes({}, { governed: false }), note: 'W1\'s typed SMV still edits here; Propose SMV change starts the approval rule.' },
    { id: 'w2b-235-propose', label: 'W2b: Propose SMV change', model: minutes({ dialog: { kind: 'propose' }, draft: { basic: '5,8', personal: '5', fatigue: '4,5', delay: '2,569', source: 'TIME_STUDY', effectiveFrom: '2026-11-12', reason: 'Nuova pelle più spessa: un passaggio in più.', replace: true } }), note: 'Version 4 waits: "Send this one in place of version 4" ticked; old → new 6.2 → 6.5 min, the allowances, from 12 Nov; what it reaches.' },
    { id: 'w2b-235-propose-held', label: 'W2b: Propose SMV change, a change waiting', model: minutes({ dialog: { kind: 'propose' } }), note: 'Send for approval held: a proposal waits (tick to replace it, or let it be decided).' },
    { id: 'w2b-235-propose-refused', label: 'W2b: Propose SMV change refused', model: minutes({ dialog: { kind: 'propose' }, refused: { key: 'problem.write.invalid', reload: false, paths: ['effectiveFrom'], messages: ['Version 2 is approved from 2026-10-20: a new version applies from that day or later.'] } }, { pending: false }) },
    { id: 'w2b-235-approve', label: 'W2b: Approve version 4', model: minutes({ dialog: { kind: 'approve', versionId: '0190f0e2-4950-7000-8000-000000000004' } }), note: 'Old → new, built from, from 12 Nov, why, who proposed it, what it reaches; it takes effect on its day.' },
    { id: 'w2b-235-reject', label: 'W2b: Reject version 4', model: minutes({ dialog: { kind: 'reject', versionId: '0190f0e2-4950-7000-8000-000000000004' } }), note: 'Reject held until the reason is typed.' },
    { id: 'w2b-235-approved', label: 'W2b: just approved', model: minutes({ notice: { key: 'notice.approvedWaits', tone: 'success', params: { number: 4, day: '2026-11-12' } } }, { pending: false }) },
    { id: 'w2b-235-quality', label: 'W2b: Minutes, quality (reads)', model: { ...minutes({}, {}, 'quality'), can: canFor('quality') }, note: 'Propose SMV change held with the right it needs; no Approve / Reject; piece rates by count only.' },
    { id: 'w2b-235-propose-offline', label: 'W2b: Propose SMV change offline', model: minutes({ offline: true, dialog: { kind: 'propose' }, draft: { basic: '5,8', personal: '5', fatigue: '4,5', delay: '2,569', source: 'TIME_STUDY', effectiveFrom: '2026-11-12', reason: 'Nuova pelle più spessa.', replace: true } }), note: 'Send for approval held: "Offline — your changes are kept on this page".' },
    { id: 'w2b-235-minutes-loading', label: 'W2b: Minutes loading', model: minutes({ part: { status: 'loading' } }) },
    { id: 'w2b-235-minutes-error', label: 'W2b: Minutes could not load', model: minutes({ part: { status: 'error', problem: 'problem.read.unavailable' } }), note: 'The W1 routings card stays.' },
    { id: 'w2b-235-machine', label: 'W2b: Machine & settings', model: { ...base, can: canFor('developer'), tab: 'machine', settings: settingsModel() }, note: 'Needle, stitches per cm, thread ticket, attachment (and machine class, stitch type, tension, notes) per setting; explicit save with ⌘S; where the settings go.' },
    { id: 'w2b-235-machine-edited', label: 'W2b: Machine & settings being changed', model: { ...base, can: canFor('developer'), tab: 'machine', settings: settingsModel({ drafts: [{ key: 'a', machineClassId: '0190f0e2-4971-7000-8000-000000000002', stitchType: '301', needle: '134 LR Nm 110', thread: 'Tkt 40', stitchesPerCm: '3,8', tension: '', foot: 'Piedino a rullo', notes: '', }, { key: 'b', machineClassId: '', stitchType: '', needle: '', thread: '', stitchesPerCm: '0', tension: '', foot: '', notes: '' }] }) }, note: 'The bar says the settings changed; Save held: setting 2 says nothing and its stitches are not above 0 (each field says why).' },
    { id: 'w2b-235-machine-read', label: 'W2b: Machine & settings, quality (reads)', model: { ...base, can: canFor('quality'), tab: 'machine', settings: settingsModel({}, false) }, note: 'Drawn as text with the tablet line; why it is read only.' },
    { id: 'w2b-235-machine-empty', label: 'W2b: Machine & settings, none yet', model: { ...base, can: canFor('developer'), tab: 'machine', settings: settingsModel({ part: { status: 'ready', value: { operation: { ...SHOULDER, status: 'ACTIVE', version: 6, companyId: SHOULDER.companyId }, settings: [], draftStepsWithout: 5, may: { manage: true } } } }) } },
    { id: 'w2b-235-machine-offline', label: 'W2b: Machine & settings offline', model: { ...base, can: canFor('developer'), tab: 'machine', settings: settingsModel({ offline: true, drafts: [{ key: 'a', machineClassId: '', stitchType: '301', needle: '134 LR Nm 110', thread: 'Tkt 40', stitchesPerCm: '3,8', tension: '', foot: '', notes: '' }] }) }, note: 'Save held while offline; the typed list stays on the page.' },
    { id: 'w2b-235-machine-loading', label: 'W2b: Machine & settings loading', model: { ...base, tab: 'machine', settings: settingsModel({ part: { status: 'loading' } }) } },
    { id: 'w2b-235-machine-error', label: 'W2b: Machine & settings could not load', model: { ...base, tab: 'machine', settings: settingsModel({ part: { status: 'error', problem: 'problem.read.unavailable' } }) } },
  ],
})

/** B-W2b-235: the Minutes tab with its W2b parts, for a production manager (proposes and approves). */
function minutes(overrides: Parameters<typeof minutesModel>[1] = {}, options: Parameters<typeof minutesModel>[2] = {}, role: 'developer' | 'quality' = 'developer'): OperationRecordViewModel {
  return { ...base, can: canFor(role), tab: 'minutes', minutes: minutesModel(role, overrides, options) }
}
