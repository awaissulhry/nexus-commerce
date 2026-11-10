import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { ACKS_COUNTS, ACKS_HR, ANSWER_V1, ANSWER_V2, ANSWER_V3, canFor, FILES, inShell, MEDIA_SRC, ME, NOW, PREFIX, RECORD, VERSIONS, type RoleCase } from '../demo/fixtures'
import { draftOf, problemsOf, ready, reading, failed, type RecordAddress, type VersionDraft } from '../model'
import { InstructionRecordView, type RecordModel } from './view/InstructionRecordView'

/**
 * SCR-285 — a work instruction's record (design production.instructions rec "Work instruction"), made-up data only. Cases:
 * Steps of the draft (a writer; a step open; problems shown; a step not in a floor language), Steps of the version in force
 * (read-only, Start version N), Media (per step, an upload running and one refused; read-only), Versions (the routing
 * revision, every version, two compared with VersionCompare), Acknowledgements (counts per site for the production manager;
 * the training record for HR with names hidden where the site's gate is shut; no version in force), Approve version 3
 * (may approve; the author held; no change note), Start version, Discard draft, Archive, Record a paper acknowledgement, an
 * archived instruction, changed elsewhere, offline, loading, not found, a failed read, no access.
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: RecordModel
}

const address = (over: Partial<RecordAddress> = {}): RecordAddress => ({ tab: 'steps', version: null, compare: null, approve: false, ...over })

/** The draft v3 is Bea's: the production manager (Alex) may approve it. */
function page(over: Partial<RecordModel> = {}, role: RoleCase = 'manager'): DesignModel {
  return {
    role,
    model: {
      prefix: PREFIX,
      me: ME,
      can: canFor(role),
      address: address(),
      record: ready(RECORD),
      shown: ready(ANSWER_V3),
      draft: draftOf(ANSWER_V3),
      changes: 0,
      showProblems: false,
      refused: [],
      language: 'it',
      openStep: null,
      mediaSrc: MEDIA_SRC,
      uploads: [],
      compare: { beforeId: VERSIONS[1]!.id, afterId: VERSIONS[0]!.id, before: ready(ANSWER_V2), after: ready(ANSWER_V3) },
      acks: ready(ACKS_COUNTS),
      dialog: null,
      busy: null,
      notice: null,
      offline: false,
      changedElsewhere: false,
      savedAt: null,
      ...over,
    },
  }
}

const DRAFT = draftOf(ANSWER_V3)
const CHANGED: VersionDraft = { ...DRAFT, steps: [...DRAFT.steps.slice(0, 1), { ...DRAFT.steps[1]!, text: { ...DRAFT.steps[1]!.text, it: 'Cuci a 12 mm dal bordo, punto 3,5 per cm; ferma a inizio e fine.' } }, ...DRAFT.steps.slice(2)] }
const BROKEN: VersionDraft = { ...DRAFT, changeNote: '', steps: [...DRAFT.steps, { key: 'new-1', code: 'CHECK_TAPE', text: {}, critical: false, safety: {}, icon: null, requiredTick: false, media: [] }] }
const READ_ONLY = { shown: ready(ANSWER_V2), draft: null, address: address({ version: VERSIONS[1]!.id }) }
const OWN_RECORD = { ...RECORD, versions: RECORD.versions.map((version) => (version.status === 'DRAFT' ? { ...version, author: { id: ME, name: 'Alex Demo' } } : version)) }
const NO_NOTE_RECORD = { ...RECORD, versions: RECORD.versions.map((version) => (version.status === 'DRAFT' ? { ...version, changeNote: null } : version)) }
const ARCHIVED_RECORD = { ...RECORD, instruction: { ...RECORD.instruction, status: 'ARCHIVED' }, draftVersionId: null, versions: RECORD.versions.filter((version) => version.status !== 'DRAFT') }
const UNPUBLISHED_RECORD = { ...RECORD, currentVersionId: null, versions: [{ ...VERSIONS[0]!, number: 1, changeNote: null }] }

function RecordDesign({ model: design }: { model: DesignModel }) {
  const [current, setCurrent] = useState<RecordModel>(design.model)
  useEffect(() => setCurrent(design.model), [design])
  const set = (change: Partial<RecordModel>) => setCurrent((model) => ({ ...model, ...change }))
  const shown = current.shown?.status === 'ready' ? current.shown.value : null
  return inShell(
    '/production/instructions',
    createElement(InstructionRecordView, {
      model: current,
      actions: {
        onDraft: (draft) => set({ draft, changes: current.changes + 1 }),
        onOpenStep: (openStep) => set({ openStep }),
        onLanguage: (language) => set({ language }),
        onDiscardChanges: () => shown && set({ draft: draftOf(shown), changes: 0, showProblems: false }),
        onSave: () => current.draft && (problemsOf(current.draft).length > 0 ? set({ showProblems: true }) : set({ changes: 0, savedAt: NOW, notice: { key: 'notice.saved', params: { number: 3 }, tone: 'success' } })),
        onDismissNotice: () => set({ notice: null }),
        onApproveOpen: () => set({ address: { ...current.address, approve: true } }),
        onApproveClose: () => set({ address: { ...current.address, approve: false } }),
        onNewVersionOpen: () => set({ dialog: { kind: 'newVersion', changeNote: '', problem: null } }),
        onDiscardOpen: () => set({ dialog: { kind: 'discard', reason: '', shown: false, problem: null } }),
        onStatusOpen: (to) => set({ dialog: { kind: 'status', to, reason: '', problem: null } }),
        onPaperOpen: () => set({ dialog: { kind: 'paper', workerId: '', locale: 'it', date: NOW.slice(0, 10), problem: null } }),
        onDialog: (dialog) => set({ dialog }),
        onCompare: (beforeId, afterId) => set({ compare: { ...current.compare, beforeId, afterId } }),
      },
    }),
    design.role,
  )
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-285',
  title: 'Work instruction',
  view: RecordDesign,
  cases: [
    { id: 'steps-draft', label: 'Steps: draft v3 (production manager)', model: page(), note: 'A version is a document: ordered steps with words per language, critical point, safety note, icon, the tick the tablet asks; the aside: facts, change note, ask to look again, languages, problems, machine settings. Approve version 3 in the band.' },
    { id: 'steps-open', label: 'Steps: a step open, changed', model: page({ openStep: DRAFT.steps[1]!.key, draft: CHANGED, changes: 1 }), note: 'The EditModeBar: 1 change, Discard, Save the draft (⌘S). Approve is held until it is saved.' },
    { id: 'steps-language', label: 'Steps: written in Romanian', model: page({ language: 'ro', openStep: DRAFT.steps[1]!.key }), note: 'A step not written in the language shows the words it has, marked; the floor language missing is marked per step.' },
    { id: 'steps-problems', label: 'Steps: problems shown', model: page({ draft: BROKEN, changes: 2, showProblems: true, openStep: 'new-1' }), note: 'A code twice and words missing, at their place and in the aside; Save held with the count.' },
    { id: 'steps-published', label: 'Steps: v2 in force (read-only)', model: page(READ_ONLY), note: 'A published version never changes: one Banner, read-only fields as text.' },
    { id: 'steps-supervisor', label: 'Steps: floor supervisor', model: page({}, 'supervisor'), note: 'Writes the draft; Approve is not this role\'s.' },
    { id: 'steps-quality', label: 'Steps: quality (approves, reads the steps)', model: page({ draft: null }, 'quality'), note: 'The draft is read-only for a person without the right to write; Approve version 3 is offered.' },
    { id: 'media', label: 'Media: per step', model: page({ address: address({ tab: 'media' }) }), note: 'Photos whole (never cropped), a video as on the tablet, captions in the language written, moved or taken off, upload per step (never a face).' },
    { id: 'media-uploading', label: 'Media: an upload running, one refused', model: page({ address: address({ tab: 'media' }), uploads: [{ key: 'u1', stepKey: DRAFT.steps[2]!.key, name: 'stiro.jpg', state: 'uploading', problem: null }, { key: 'u2', stepKey: DRAFT.steps[2]!.key, name: 'stiro.gif', state: 'failed', problem: 'media.problem.type' }] }) },
    { id: 'media-read', label: 'Media: v2 (read-only, no files.read)', model: page({ ...READ_ONLY, address: address({ tab: 'media', version: VERSIONS[1]!.id }), mediaSrc: { [FILES.jacket]: null, [FILES.seam]: null } }), note: 'Without an address the kind and the name show instead.' },
    { id: 'versions', label: 'Versions: compared', model: page({ address: address({ tab: 'versions' }) }), note: 'The routing revision and where it is used, every version with who wrote and approved it, then v2 → v3 with VersionCompare.' },
    { id: 'versions-v1', label: 'Versions: v1 → v2', model: page({ address: address({ tab: 'versions' }), compare: { beforeId: VERSIONS[2]!.id, afterId: VERSIONS[1]!.id, before: ready(ANSWER_V1), after: ready(ANSWER_V2) } }) },
    { id: 'versions-loading', label: 'Versions: comparing…', model: page({ address: address({ tab: 'versions' }), compare: { beforeId: VERSIONS[1]!.id, afterId: VERSIONS[0]!.id, before: reading(), after: reading() } }) },
    { id: 'acks', label: 'Acknowledgements: counts (production manager)', model: page({ address: address({ tab: 'acks' }) }), note: 'What it shows is said first; "9 of 11" per site; per version a count; no name anywhere; Remind held with the reason.' },
    { id: 'acks-hr', label: 'Acknowledgements: HR training record', model: page({ address: address({ tab: 'acks' }), acks: ready(ACKS_HR) }, 'hr'), note: 'Names inside this record only; hidden where the site has not recorded the legal basis; Record a paper acknowledgement.' },
    { id: 'acks-none', label: 'Acknowledgements: no version in force', model: page({ address: address({ tab: 'acks' }), record: ready(UNPUBLISHED_RECORD), acks: ready({ ...ACKS_COUNTS, current: null, versions: [] }) }) },
    { id: 'acks-error', label: 'Acknowledgements: could not read', model: page({ address: address({ tab: 'acks' }), acks: failed('problem.unavailable') }) },
    { id: 'paper', label: 'Record a paper acknowledgement', model: page({ address: address({ tab: 'acks' }), acks: ready(ACKS_HR), dialog: { kind: 'paper', workerId: '', locale: 'it', date: NOW.slice(0, 10), problem: null } }, 'hr') },
    { id: 'approve', label: 'Approve version 3', model: page({ address: address({ approve: true }) }), note: 'pop:wi-approve: the floor shows v3 from now on; what changed against v2; the change note; the sign-off — written by Bea, approved by a second person.' },
    { id: 'approve-own', label: 'Approve: the author (held)', model: page({ record: ready(OWN_RECORD), address: address({ approve: true }) }), note: 'Four eyes: the author never approves their own draft — the rule broken, the button held with the reason.' },
    { id: 'approve-no-note', label: 'Approve: no change note (held)', model: page({ record: ready(NO_NOTE_RECORD), draft: { ...DRAFT, changeNote: '' }, address: address({ approve: true }) }) },
    { id: 'approve-refused', label: 'Approve: refused by the API', model: page({ address: address({ approve: true }), notice: { key: 'refusal.MEDIA_NOT_READY', tone: 'danger' } }) },
    { id: 'new-version', label: 'Start version 3', model: page({ record: ready({ ...RECORD, draftVersionId: null, versions: RECORD.versions.filter((version) => version.status !== 'DRAFT') }), ...READ_ONLY, address: address(), dialog: { kind: 'newVersion', changeNote: '', problem: null } }) },
    { id: 'discard', label: 'Discard draft v3', model: page({ dialog: { kind: 'discard', reason: '', shown: true, problem: null } }), note: 'The reason is asked; Discard held without it.' },
    { id: 'archive', label: 'Archive', model: page({ dialog: { kind: 'status', to: 'ARCHIVED', reason: '', problem: null } }) },
    { id: 'archived', label: 'Archived instruction', model: page({ record: ready(ARCHIVED_RECORD), ...READ_ONLY, address: address() }), note: 'One Banner; Restore in ⋯.' },
    { id: 'saved', label: 'Just saved', model: page({ savedAt: NOW, notice: { key: 'notice.saved', params: { number: 3 }, tone: 'success' } }) },
    { id: 'changed-elsewhere', label: 'Changed elsewhere', model: page({ changedElsewhere: true }), note: 'Design: no live feed; a change by someone else shows a Banner with Reload.' },
    { id: 'offline', label: 'Offline', model: page({ offline: true }), note: 'Save and the writes held with the reason.' },
    { id: 'loading', label: 'Loading', model: page({ record: reading(), shown: reading() }) },
    { id: 'error', label: 'Could not read', model: page({ record: failed('problem.unavailable') }) },
    { id: 'not-found', label: 'Not found', model: page({ record: failed('problem.notFound') }) },
    { id: 'no-permission', label: 'No access (sales)', model: page({}, 'sales') },
  ],
})
