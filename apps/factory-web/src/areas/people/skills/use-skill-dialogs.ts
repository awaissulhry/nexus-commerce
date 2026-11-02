'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isStepUpCancelled, useStepUp } from '../../quality/_shared/hooks'
import { authoriseMachine, changeValidUntil, createSkill, listOperations, listSkills, removeLevel, revokeAuthorisation, setLevel, setSkillStatus, signOffTrainee, type Skill, type SkillKind, type SkillLevel } from './api'
import { authoriseHeld, reasonHeld, signOffHeld, skillsProblem, type AuthoriseDraft, type DialogPerson, type SignOffDraft } from './model'

/** A failed call in words: `ns` names the catalogue. */
export type SkillProblem = ReturnType<typeof skillsProblem>

const common = { busy: false, problem: null as SkillProblem | null }

/** An operation of the library a skill can be about. */
export interface SkillTarget {
  id: string
  label: string
}

export type SkillDialog =
  | ({ kind: 'authorise'; people: DialogPerson[]; fixed: boolean; draft: AuthoriseDraft; refused: { name: string; problem: SkillProblem }[]; done: number } & typeof common)
  | ({ kind: 'signoff'; person: DialogPerson; skillId: string; skillLabel: string; levelId: string; version: number; since: string; draft: SignOffDraft } & typeof common)
  | ({ kind: 'level'; person: DialogPerson; skillId: string | null; skillLabel: string | null; level: SkillLevel | null; until: string; version: number | null; hasTrainee: boolean } & typeof common)
  | ({ kind: 'removeLevel'; person: DialogPerson; skillLabel: string; levelId: string; version: number; reason: string } & typeof common)
  | ({ kind: 'validUntil'; person: DialogPerson; classLabel: string; id: string; version: number; from: string; until: string } & typeof common)
  | ({ kind: 'revoke'; person: DialogPerson; classLabel: string; id: string; version: number; reason: string } & typeof common)
  | ({ kind: 'catalogue'; skills: Skill[] | null; operations: readonly SkillTarget[] | null; draft: SkillDraft; adding: boolean } & typeof common)

export interface SkillDraft {
  code: string
  nameIt: string
  nameEn: string
  kind: SkillKind
  /** The operation of the library (OPERATION) or the class of machine (MACHINE) the skill is about. */
  targetId: string | null
}

const BLANK_SKILL: SkillDraft = { code: '', nameIt: '', nameEn: '', kind: 'OPERATION', targetId: null }

export interface SkillDialogActions {
  onClose: () => void
  onPatch: (patch: Record<string, unknown>) => void
  onAuthorise: () => void
  onSignOff: () => void
  onLevel: () => void
  onRemoveLevel: () => void
  onValidUntil: () => void
  onRevoke: () => void
  onAddSkill: () => void
  onSkillStatus: (skill: Skill, to: 'archive' | 'restore') => void
  onStepUpSubmit: (code: string) => void
  onStepUpCancel: () => void
}

/**
 * The dialogs of Skills & training, shared by the matrix (SCR-160) and the employee's tab: which one is open, what it holds
 * and the one command each one sends (Idempotency-Key and the version read). Sign off asks a fresh code when the API
 * answers 403 `stepUp`. `today` is the API's. `onChanged(words)` re-reads the page after a write.
 */
export function useSkillDialogs(api: ApiClient, facts: { today: string; companyId: string | null }, onChanged: (done: string, params?: Record<string, string | number>) => void) {
  const [dialog, setDialog] = useState<SkillDialog | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const signKey = useRef<{ body: string; key: string } | null>(null)

  const patch = useCallback((change: Record<string, unknown>) => setDialog((current) => (current ? ({ ...current, ...change } as SkillDialog) : current)), [])
  const fail = useCallback((error: unknown) => {
    if (isStepUpCancelled(error)) return patch({ busy: false })
    patch({ busy: false, problem: skillsProblem(error) })
  }, [patch])

  const open = {
    authorise: (people: DialogPerson[], fixed: boolean, classId: string | null = null) => setDialog({ kind: 'authorise', people, fixed, draft: { classId, from: facts.today, until: null }, refused: [], done: 0, ...common }),
    signOff: (person: DialogPerson, level: { skillId: string; skillLabel: string; levelId: string; version: number; since: string }) => setDialog({ kind: 'signoff', person, ...level, draft: { on: facts.today, trainerId: null, level: null }, ...common }),
    level: (person: DialogPerson, level: { skillId: string | null; skillLabel: string | null; level: SkillLevel | null; until: string | null; version: number | null; hasTrainee: boolean }) => setDialog({ kind: 'level', person, ...level, until: level.until ?? '', ...common }),
    removeLevel: (person: DialogPerson, level: { skillLabel: string; levelId: string; version: number }) => setDialog({ kind: 'removeLevel', person, ...level, reason: '', ...common }),
    validUntil: (person: DialogPerson, entry: { classLabel: string; id: string; version: number; from: string; until: string | null }) => setDialog({ kind: 'validUntil', person, ...entry, until: entry.until ?? '', ...common }),
    revoke: (person: DialogPerson, entry: { classLabel: string; id: string; version: number }) => setDialog({ kind: 'revoke', person, ...entry, reason: '', ...common }),
    catalogue: () => {
      setDialog({ kind: 'catalogue', skills: null, operations: null, draft: BLANK_SKILL, adding: false, ...common })
      listSkills(api, { status: 'ALL', companyId: facts.companyId })
        .then((answer) => patch({ skills: answer.skills }))
        .catch(fail)
      // The library is product.routing.view's: without it the list says so and General skills can still be added.
      listOperations(api)
        .then((operations) => patch({ operations }))
        .catch(() => patch({ operations: [] }))
    },
  }

  const actions: SkillDialogActions = {
    onClose: () => setDialog(null),
    onPatch: patch,
    onAuthorise: () => {
      if (dialog?.kind !== 'authorise' || dialog.busy || authoriseHeld(dialog.people, dialog.draft)) return
      const { people, draft } = dialog
      patch({ busy: true, problem: null, refused: [] })
      void (async () => {
        const refused: { name: string; problem: SkillProblem }[] = []
        let done = 0
        for (const person of people) {
          try {
            await authoriseMachine(api, { employeeId: person.employeeId, machineClassId: draft.classId!, authorisedOn: draft.from, ...(draft.until ? { validUntil: draft.until } : {}) })
            done += 1
          } catch (error) {
            refused.push({ name: person.name, problem: skillsProblem(error) })
          }
        }
        if (refused.length === 0) {
          setDialog(null)
          onChanged('done.authorised', { count: done })
        } else {
          // Those already authorised stay so; the dialog lists who was refused and why.
          if (done > 0) onChanged('done.authorised', { count: done })
          patch({ busy: false, refused, done, people: people.filter((person) => refused.some((entry) => entry.name === person.name)) })
        }
      })()
    },
    onSignOff: () => {
      if (dialog?.kind !== 'signoff' || dialog.busy || signOffHeld(dialog.draft, { since: dialog.since, today: facts.today })) return
      const { levelId, version, draft } = dialog
      const body = { version, signedOffOn: draft.on, ...(draft.trainerId ? { trainerEmployeeId: draft.trainerId } : {}), ...(draft.level ? { level: draft.level } : {}) }
      const text = JSON.stringify(body)
      // One key per attempt of the same signature: the code asked in between sends it once more.
      if (signKey.current?.body !== text) signKey.current = { body: text, key: newIdempotencyKey() }
      const key = signKey.current.key
      patch({ busy: true, problem: null })
      guard('stepUp.signOff', () => signOffTrainee(api, levelId, body, key))
        .then(() => {
          signKey.current = null
          setDialog(null)
          onChanged('done.signedOff')
        })
        .catch(fail)
    },
    onLevel: () => {
      if (dialog?.kind !== 'level' || dialog.busy || !dialog.skillId || !dialog.level) return
      const { person, skillId, level, until, version } = dialog
      patch({ busy: true, problem: null })
      setLevel(api, { employeeId: person.employeeId, skillId, level, ...(until ? { traineeUntil: until } : {}), ...(version !== null ? { version } : {}) })
        .then(() => {
          setDialog(null)
          onChanged('done.level')
        })
        .catch(fail)
    },
    onRemoveLevel: () => {
      if (dialog?.kind !== 'removeLevel' || dialog.busy || reasonHeld(dialog.reason)) return
      patch({ busy: true, problem: null })
      removeLevel(api, dialog.levelId, { version: dialog.version, reason: dialog.reason.trim() })
        .then(() => {
          setDialog(null)
          onChanged('done.removed')
        })
        .catch(fail)
    },
    onValidUntil: () => {
      if (dialog?.kind !== 'validUntil' || dialog.busy) return
      patch({ busy: true, problem: null })
      changeValidUntil(api, dialog.id, { version: dialog.version, validUntil: dialog.until || null })
        .then(() => {
          setDialog(null)
          onChanged('done.validUntil')
        })
        .catch(fail)
    },
    onRevoke: () => {
      if (dialog?.kind !== 'revoke' || dialog.busy || reasonHeld(dialog.reason)) return
      patch({ busy: true, problem: null })
      revokeAuthorisation(api, dialog.id, { version: dialog.version, reason: dialog.reason.trim() })
        .then(() => {
          setDialog(null)
          onChanged('done.revoked')
        })
        .catch(fail)
    },
    onAddSkill: () => {
      if (dialog?.kind !== 'catalogue' || dialog.busy || !facts.companyId) return
      const { draft } = dialog
      patch({ busy: true, problem: null })
      createSkill(api, { companyId: facts.companyId, code: draft.code.trim(), name: draft.nameIt.trim(), nameI18n: { it: draft.nameIt.trim(), ...(draft.nameEn.trim() ? { en: draft.nameEn.trim() } : {}) }, kind: draft.kind, ...(draft.kind === 'OPERATION' ? { operationId: draft.targetId } : draft.kind === 'MACHINE' ? { machineClassId: draft.targetId } : {}) })
        .then((skill) => {
          patch({ busy: false, adding: false, draft: BLANK_SKILL, skills: [...(dialog.skills ?? []), skill] })
          onChanged('done.skillAdded')
        })
        .catch(fail)
    },
    onSkillStatus: (skill, to) => {
      if (dialog?.kind !== 'catalogue' || dialog.busy) return
      patch({ busy: true, problem: null })
      setSkillStatus(api, skill.id, to, skill.version)
        .then((next) => {
          patch({ busy: false, skills: (dialog.skills ?? []).map((entry) => (entry.id === next.id ? next : entry)) })
          onChanged(to === 'archive' ? 'done.skillArchived' : 'done.skillRestored')
        })
        .catch(fail)
    },
    onStepUpSubmit: (code) => void submitStepUp(code),
    onStepUpCancel: cancelStepUp,
  }

  return { dialog, open, actions, stepUp }
}
