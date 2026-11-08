import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, ME, ROLE_PERMISSIONS, type RoleCase } from '../../_shared/fixtures'
import { STEP_UP_CLOSED } from '../../_shared/hooks'
import { failedRead, reading, ready } from '../../_shared/model'
import { PROFILES, RECORD, RECORD_APPROVED, VERSION_RECORD, VERSION_RECORD_V2, VERSION_V2 } from '../demo/fixtures'
import { appliesDraftOf, newCheck, plansCan, versionDraftOf, type RecordAddress, type RecordTab, type VersionDraft } from '../model'
import { PlanRecordView, type PlanRecordModel } from './view/PlanRecordView'

/**
 * SCR-077-plan — an inspection plan's record (Builder page mode), made-up data only. Cases: the draft's Checks (one opened,
 * changed with problems held, a new check), Sampling (AQL profile, a fixed sample, a rule's frequency), Applies to
 * (changed), Versions (compared, with the records that ran on it), the band's next step for each person (submit, approve,
 * start a version), Approve version with ChangeReview and SignOffPanel (may approve; the author held; the code asked; a
 * refusal), Retire with the reason, the approved version read-only, the role cases, loading, not found, offline.
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: PlanRecordModel
}

const address = (tab: RecordTab = 'checks', over: Partial<RecordAddress> = {}): RecordAddress => ({ tab, version: null, approve: false, ...over })

function page(over: Partial<PlanRecordModel> = {}, role: RoleCase = 'owner'): DesignModel {
  const record = over.record?.value ?? RECORD
  return {
    role,
    model: {
      prefix: '/w/DEMO',
      me: ME,
      can: plansCan(ROLE_PERMISSIONS[role] as readonly string[]),
      address: address(),
      record: ready(RECORD),
      draft: versionDraftOf(record.current),
      applies: appliesDraftOf(record.plan),
      shown: false,
      refused: [],
      openCheck: null,
      profiles: ready(PROFILES),
      exampleLot: 500,
      version: null,
      approve: null,
      retire: null,
      chipSearch: null,
      busy: null,
      notice: null,
      stepUp: STEP_UP_CLOSED,
      live: 'live',
      savedAt: null,
      changedElsewhere: false,
      ...over,
    },
  }
}

const BASE = versionDraftOf(VERSION_V2)
const CHANGED: VersionDraft = {
  ...BASE,
  checks: [...BASE.checks.slice(0, 3), { ...BASE.checks[3]!, choices: ['Clean', 'clean'] }, BASE.checks[4]!, BASE.checks[5]!, { ...newCheck(BASE.checks, 1, 'MEASUREMENT'), labelIt: 'Lunghezza manica', labelEn: '', nominal: '64', tolerance: '' }],
}
const AUTHOR_RECORD = { ...RECORD, current: { ...VERSION_V2, author: { id: ME, name: 'Alex Demo' } } }
const SAMPLED_FIXED: VersionDraft = { ...BASE, sampling: { method: 'FIXED', profileId: null, fixedSize: 5, frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 4, stop: 'FINISH' } }
const SAMPLED_NAMED: VersionDraft = { ...BASE, sampling: { ...BASE.sampling, profileId: PROFILES.profiles[1]!.id } }

function RecordDesign({ model: design }: { model: DesignModel }) {
  const [current, setCurrent] = useState<PlanRecordModel>(design.model)
  useEffect(() => setCurrent(design.model), [design])
  const set = (change: Partial<PlanRecordModel>) => setCurrent((model) => ({ ...model, ...change }))
  const record = current.record.value
  return inShell(
    '/quality/plans',
    createElement(PlanRecordView, {
      model: current,
      actions: {
        onChecks: (checks) => current.draft && set({ draft: { ...current.draft, checks } }),
        onOpenCheck: (openCheck) => set({ openCheck }),
        onChangeNote: (changeNote) => current.draft && set({ draft: { ...current.draft, changeNote } }),
        onSampling: (sampling) => current.draft && set({ draft: { ...current.draft, sampling } }),
        onExampleLot: (exampleLot) => set({ exampleLot }),
        onDiscardVersion: () => record && set({ draft: versionDraftOf(record.current), shown: false }),
        onSaveVersion: () => set({ shown: true }),
        onApplies: (applies) => set({ applies }),
        onDiscardApplies: () => record && set({ applies: appliesDraftOf(record.plan) }),
        onApproveOpen: () => set({ approve: { problem: null } }),
        onApproveClose: () => set({ approve: null }),
        onApprove: () => set({ stepUp: { open: true, busy: false, sentence: 'stepUp.approve', problem: null } }),
        onStepUpCancel: () => set({ stepUp: STEP_UP_CLOSED }),
        onRetireOpen: (versionId, number, status) => set({ retire: { versionId, number, status, reason: '', shown: false, problem: null } }),
        onRetireReason: (reason) => current.retire && set({ retire: { ...current.retire, reason } }),
        onRetireClose: () => set({ retire: null }),
        onRetire: () => current.retire && set({ retire: { ...current.retire, shown: true } }),
        onDismissNotice: () => set({ notice: null }),
      },
    }),
    design.role,
  )
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-077-plan',
  title: 'Inspection plan (record)',
  view: RecordDesign,
  cases: [
    { id: 'checks', label: 'Approver: version 2 waits for approval — the checks in order, on the bench, Approve version 2 in the band', model: page(), note: 'You did not write it (Marta Demo did): the band offers Approve version 2.' },
    { id: 'checks-open', label: 'A check opened to change it (code, words, type, class, mandatory, photo, the measurement)', model: page({ openCheck: BASE.checks[1]!.key }) },
    { id: 'checks-changed', label: 'Changed with problems: a new measurement without English and tolerance, twice the same answer (Save held, Show me)', model: page({ draft: CHANGED, shown: true, openCheck: CHANGED.checks[6]!.key }) },
    { id: 'checks-author', label: 'The author: Submit for approval (asked already: held with why)', model: page({ record: ready(AUTHOR_RECORD), draft: versionDraftOf(AUTHOR_RECORD.current) }) },
    { id: 'checks-approved', label: 'No draft: version 1 approved and frozen (read-only, Start version 2)', model: page({ record: ready(RECORD_APPROVED), draft: versionDraftOf(RECORD_APPROVED.current), applies: appliesDraftOf(RECORD_APPROVED.plan) }) },
    { id: 'sampling', label: 'Sampling: the AQL profile that applies, stop at the reject number; the example lot from the company default', model: page({ address: address('sampling') }) },
    { id: 'sampling-named', label: 'Sampling: a named profile (AQL-EXM) — the example uses it', model: page({ address: address('sampling'), draft: SAMPLED_NAMED }) },
    { id: 'sampling-fixed', label: 'Sampling: a fixed 5 units, every 4th bundle, finish the sample (Save)', model: page({ address: address('sampling'), draft: SAMPLED_FIXED }) },
    { id: 'applies', label: 'Applies to: category Jackets and one customer — applies to 4 of 11 styles now', model: page({ address: address('applies') }) },
    { id: 'applies-changed', label: 'Applies to changed: a style chip added (Save, the preview after saving)', model: page({ address: address('applies'), applies: { ...appliesDraftOf(RECORD.plan), chips: [...appliesDraftOf(RECORD.plan).chips, { kind: 'STYLE', value: '0190f0e2-7721-7000-8000-000000000001', label: 'DEMO-JKT-01 · Moto jacket' }] } }) },
    { id: 'versions', label: 'Versions: v2 draft, v1 approved and used by 18 inspections; v2 compared with v1', model: page({ address: address('versions'), version: ready(VERSION_RECORD_V2) }) },
    { id: 'versions-v1', label: 'Versions: v1 with the records that ran on it and its signature', model: page({ address: address('versions', { version: VERSION_RECORD.version.id }), version: ready(VERSION_RECORD) }) },
    { id: 'approve', label: 'Approve version 2: what changed against v1 (ChangeReview), the sign-off — written by Marta Demo, you approve', model: page({ approve: { problem: null } }) },
    { id: 'approve-author', label: 'Approve held: you wrote version 2 (the duty broken, said in words)', model: page({ record: ready(AUTHOR_RECORD), draft: versionDraftOf(AUTHOR_RECORD.current), approve: { problem: null } }) },
    { id: 'approve-code', label: 'Approve: the fresh code asked (e-signature)', model: page({ approve: { problem: null }, stepUp: { open: true, busy: false, sentence: 'stepUp.approve', problem: null } }) },
    { id: 'approve-code-wrong', label: 'Approve: the code refused', model: page({ approve: { problem: null }, stepUp: { open: true, busy: false, sentence: 'stepUp.approve', problem: 'stepUp.problem.wrong' } }) },
    { id: 'approve-refused', label: 'Approve refused by the API: the profile it names was retired meanwhile', model: page({ approve: { problem: 'refusal.PROFILE_RETIRED' } }) },
    { id: 'approved', label: 'Approved: version 2 in force, version 1 retired (the receipt)', model: page({ record: ready(RECORD_APPROVED), draft: versionDraftOf(RECORD_APPROVED.current), notice: { key: 'done.approvedRetired', params: { number: 2, retired: 1 }, tone: 'success' } }) },
    { id: 'retire', label: 'Retire version 2 (the reason kept; empty: held)', model: page({ retire: { versionId: VERSION_V2.id, number: 2, status: 'DRAFT', reason: '', shown: true, problem: null } }) },
    { id: 'retire-refused', label: 'Retire refused: an active rule uses the plan', model: page({ record: ready(RECORD_APPROVED), draft: versionDraftOf(RECORD_APPROVED.current), retire: { versionId: RECORD_APPROVED.current.id, number: 1, status: 'APPROVED', reason: 'Replaced by the gloves plan', shown: true, problem: 'refusal.RULES_USE_PLAN' } }) },
    { id: 'saved', label: 'Saved (the band says when)', model: page({ savedAt: '2026-10-29T09:44:00.000Z', notice: { key: 'done.saved', params: { number: 2 }, tone: 'success' } }) },
    { id: 'changed-elsewhere', label: 'Live: changed on another screen while this one holds changes', model: page({ draft: CHANGED, changedElsewhere: true }) },
    { id: 'production', label: 'Production manager: approves, changes nothing (read-only builder)', model: page({}, 'production') },
    { id: 'supervisor', label: 'Floor supervisor: reads the plan only; the profiles are not in the role', model: page({ profiles: failedRead('problem.forbidden') }, 'supervisor') },
    { id: 'no-permission', label: 'Sales: no permission (which one, who grants it)', model: page({}, 'sales') },
    { id: 'loading', label: 'Loading (band, tabs and body in their places)', model: page({ record: reading(), draft: null, applies: null }) },
    { id: 'not-found', label: 'Not found (back to the plans)', model: page({ record: failedRead('problem.notFound'), draft: null, applies: null }) },
    { id: 'error', label: 'The plan could not be read (Try again)', model: page({ record: failedRead('problem.unavailable'), draft: null, applies: null }) },
    { id: 'offline', label: 'Offline: the last copy, every save held', model: page({ live: 'offline', draft: CHANGED }) },
  ],
})

