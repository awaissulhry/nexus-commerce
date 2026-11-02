'use client'

import { useId, type ReactNode } from 'react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SignBlock } from '@nexus/ui/components/SignBlock/index'
import { Button, Input, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { Combobox, DateField, Modal, StepUpModal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { StepUpState } from '../../../quality/_shared/hooks'
import { useWords } from '../../_shared/parts'
import type { MatrixClass, MatrixRow, SkillKind, SkillLevel } from '../api'
import { authoriseHeld, className, firstAtSites, reasonHeld, signOffHeld, SKILL_LEVELS, skillName, TIME_ZONE, trainersFor } from '../model'
import type { SkillDialog, SkillDialogActions, SkillDraft, SkillProblem } from '../use-skill-dialogs'

/** The words of the page (`people-skills`). */
export function useSkillWords() {
  return useT('people-skills')
}

/** A failed call in words, from whichever catalogue owns it. */
export function useProblemWords(): (problem: SkillProblem | null) => string | null {
  const t = useSkillWords()
  const people = useWords()
  return (problem) => (problem ? (problem.ns === 'skills' ? t(problem.words.key, problem.words.params) : people(problem.words.key, problem.words.params)) : null)
}

export interface SkillDialogsModel {
  dialog: SkillDialog | null
  /** The rows read (people to choose, trainers). */
  rows: readonly MatrixRow[]
  classes: readonly MatrixClass[]
  /** The skills that may be set from the employee's tab. */
  skills: readonly { id: string; name: string; nameI18n: Record<string, string>; code: string }[]
  sites: readonly { id: string; name: string }[]
  today: string
  signer: string
  stepUp: StepUpState
}

/** Every dialog of Skills & training: one view, the state and commands are `use-skill-dialogs.ts`. */
export function SkillDialogs({ model, actions }: { model: SkillDialogsModel; actions?: SkillDialogActions }) {
  const t = useSkillWords()
  const dialog = model.dialog
  return (
    <>
      {dialog?.kind === 'authorise' && <AuthoriseDialog model={model} dialog={dialog} actions={actions} />}
      {dialog?.kind === 'signoff' && <SignOffDialog model={model} dialog={dialog} actions={actions} />}
      {dialog?.kind === 'level' && <LevelDialog model={model} dialog={dialog} actions={actions} />}
      {dialog?.kind === 'removeLevel' && <ReasonDialog title={t('remove.title', { skill: dialog.skillLabel, name: dialog.person.name })} body={t('remove.body')} confirm={t('remove.confirm')} dialog={dialog} onConfirm={actions?.onRemoveLevel} actions={actions} />}
      {dialog?.kind === 'revoke' && <ReasonDialog title={t('revoke.title', { machine: dialog.classLabel, name: dialog.person.name })} body={t('revoke.body')} confirm={t('revoke.confirm')} dialog={dialog} onConfirm={actions?.onRevoke} actions={actions} />}
      {dialog?.kind === 'validUntil' && <ValidUntilDialog dialog={dialog} actions={actions} />}
      {dialog?.kind === 'catalogue' && <CatalogueDialog model={model} dialog={dialog} actions={actions} />}
      <StepUpModal
        open={model.stepUp.open}
        title={t('stepUp.title')}
        sentence={model.stepUp.sentence ? t(model.stepUp.sentence) : ''}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpSubmit(code)}
        onClose={() => actions?.onStepUpCancel()}
        confirmLabel={t('stepUp.confirm')}
      />
    </>
  )
}

function Refused({ problem }: { problem: SkillProblem | null }) {
  const say = useProblemWords()
  return problem ? <Banner tone="danger" title={say(problem) ?? ''} /> : null
}

function Foot({ onClose, children }: { onClose?: () => void; children?: ReactNode }) {
  const t = useSkillWords()
  return (
    <>
      <Button variant="quiet" onClick={onClose}>
        {t('common.cancel')}
      </Button>
      {children}
    </>
  )
}

// ---- Authorise a machine (band secondary, a machine cell, N rows) -----------------------------------------------------------

function AuthoriseDialog({ model, dialog, actions }: { model: SkillDialogsModel; dialog: Extract<SkillDialog, { kind: 'authorise' }>; actions?: SkillDialogActions }) {
  const t = useSkillWords()
  const locale = useLocale()
  const ds = useDsWords()
  const say = useProblemWords()
  const place = { locale, timeZone: TIME_ZONE }
  const entry = model.classes.find((item) => item.id === dialog.draft.classId) ?? null
  const label = entry ? className(entry, locale) : null
  const first = firstAtSites(entry, dialog.people)
  const held = authoriseHeld(dialog.people, dialog.draft)
  const today = dialog.draft.from === model.today
  const from = dialog.draft.from ? formatDate(`${dialog.draft.from}T12:00:00Z`, place) : ''
  const candidates = model.rows.filter((row) => row.canAuthorise)
  const draft = (change: Partial<typeof dialog.draft>) => actions?.onPatch({ draft: { ...dialog.draft, ...change } })
  return (
    <Modal
      open
      onClose={() => actions?.onClose()}
      title={t('authorise.title')}
      size="md"
      footer={
        <Foot onClose={actions?.onClose}>
          <Button variant="primary" heldReason={held ? t(held) : null} disabled={dialog.busy} onClick={() => actions?.onAuthorise()}>
            {dialog.people.length > 1 ? t('authorise.confirmCount', { count: dialog.people.length }) : t('authorise.confirm')}
          </Button>
        </Foot>
      }
    >
      <div className="fw-sk-form">
        <Refused problem={dialog.problem} />
        {dialog.refused.length > 0 && (
          <Banner tone="danger" title={t('authorise.partly', { count: dialog.refused.length, done: dialog.done, refused: dialog.refused.length })}>
            <ul className="fw-sk-plain">
              {dialog.refused.map((entry) => (
                <li key={entry.name}>
                  {entry.name}: {say(entry.problem)}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        {dialog.fixed || dialog.people.length > 1 ? (
          <Field label={t('authorise.person')}>
            <p className="fw-sk-value">{dialog.people.map((person) => person.name).join(', ')}</p>
          </Field>
        ) : (
          <Field label={t('authorise.person')} required>
            <Combobox
              options={candidates.map((row) => ({ value: row.employeeId, label: row.name }))}
              value={dialog.people[0]?.employeeId ?? ''}
              placeholder={t('authorise.personPick')}
              onChange={(value) => {
                const row = candidates.find((item) => item.employeeId === value)
                actions?.onPatch({ people: row ? [{ employeeId: row.employeeId, name: row.name, companyId: row.companyId, siteId: row.siteId }] : [] })
              }}
            />
          </Field>
        )}
        <Field label={t('authorise.machine')} required hint={t('authorise.machineHint')}>
          <Select value={dialog.draft.classId ?? ''} onChange={(event) => draft({ classId: event.target.value || null })}>
            <option value="">{t('authorise.machinePick')}</option>
            {model.classes.map((item) => (
              <option key={item.id} value={item.id}>
                {className(item, locale)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="fw-sk-pair">
          <Field label={t('authorise.from')} required>
            <DateField value={dialog.draft.from} onChange={(value) => draft({ from: value })} />
          </Field>
          <Field label={t('authorise.until')} hint={t('authorise.untilHint')}>
            <DateField value={dialog.draft.until ?? ''} onChange={(value) => draft({ until: value || null })} clearable />
          </Field>
        </div>
        <Field label={t('authorise.by')}>
          <p className="fw-sk-value">{model.signer}</p>
        </Field>
        {label && <p className="fw-sk-effect">{today ? t('authorise.effectToday', { machine: label }) : t('authorise.effectFrom', { machine: label, date: from })}</p>}
        {first.length > 0 && label && (
          <Banner tone="warning" title={t('authorise.firstTitle', { machine: label })}>
            {t('authorise.firstBody', { sites: first.map((id) => model.sites.find((site) => site.id === id)?.name ?? id).join(', ') })}{' '}
            <LawRef law={t('authorise.law')} plain={t('authorise.lawPlain')} labels={ds.lawRef} />
          </Banner>
        )}
        <p className="fw-sk-hint">{t('authorise.notChecked')}</p>
      </div>
    </Modal>
  )
}

// ---- Sign off a trainee (a skill cell, the employee's tab) --------------------------------------------------------------------

function SignOffDialog({ model, dialog, actions }: { model: SkillDialogsModel; dialog: Extract<SkillDialog, { kind: 'signoff' }>; actions?: SkillDialogActions }) {
  const t = useSkillWords()
  const say = useProblemWords()
  const trainers = trainersFor(model.rows, dialog.person, dialog.skillId)
  const held = signOffHeld(dialog.draft, { since: dialog.since, today: model.today })
  const draft = (change: Partial<typeof dialog.draft>) => actions?.onPatch({ draft: { ...dialog.draft, ...change } })
  return (
    <Modal open onClose={() => actions?.onClose()} title={t('signOff.title')} subtitle={t('signOff.subtitle', { name: dialog.person.name, skill: dialog.skillLabel })} size="md">
      <div className="fw-sk-form">
        <div className="fw-sk-pair">
          <Field label={t('signOff.trainer')} hint={t('signOff.trainerHint')}>
            <Select value={dialog.draft.trainerId ?? ''} onChange={(event) => draft({ trainerId: event.target.value || null })}>
              <option value="">{t('signOff.outside')}</option>
              {trainers.map((row) => (
                <option key={row.employeeId} value={row.employeeId}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('signOff.on')} required>
            <DateField value={dialog.draft.on} max={model.today} min={dialog.since} onChange={(value) => draft({ on: value })} />
          </Field>
        </div>
        <Field label={t('signOff.level')} hint={t('signOff.levelHint')}>
          <Select value={dialog.draft.level ?? ''} onChange={(event) => draft({ level: (event.target.value || null) as SkillLevel | null })}>
            <option value="">{t('signOff.levelKeep')}</option>
            {SKILL_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(`level.${level}`)}
              </option>
            ))}
          </Select>
        </Field>
        <SignBlock
          legal={<p>{t('signOff.effect')}</p>}
          nameLabel={t('signOff.name')}
          nameHint={t('signOff.nameHint')}
          expectedName={model.signer}
          nameEmptyLabel={t('signOff.nameEmpty')}
          nameMismatchLabel={t('signOff.nameMismatch')}
          acceptLabel={t('signOff.confirm')}
          onAccept={() => actions?.onSignOff()}
          declineLabel={t('common.cancel')}
          onDecline={() => actions?.onClose()}
          state={dialog.busy ? 'busy' : 'idle'}
          busyLabel={t('common.saving')}
          heldReason={held ? t(held) : null}
          message={say(dialog.problem)}
          messageTone="danger"
        />
      </div>
    </Modal>
  )
}

// ---- a level with its trainee period (a cell's popover, Add a skill on the tab) ---------------------------------------------

function LevelDialog({ model, dialog, actions }: { model: SkillDialogsModel; dialog: Extract<SkillDialog, { kind: 'level' }>; actions?: SkillDialogActions }) {
  const t = useSkillWords()
  const locale = useLocale()
  const held = !dialog.skillId ? t('held.chooseSkill') : !dialog.level ? t('held.chooseLevel') : null
  return (
    <Modal
      open
      onClose={() => actions?.onClose()}
      title={dialog.skillLabel ? t('level.title', { skill: dialog.skillLabel }) : t('level.titleNew')}
      subtitle={dialog.person.name}
      size="sm"
      footer={
        <Foot onClose={actions?.onClose}>
          <Button variant="primary" heldReason={held} disabled={dialog.busy} onClick={() => actions?.onLevel()}>
            {t('level.confirm')}
          </Button>
        </Foot>
      }
    >
      <div className="fw-sk-form">
        <Refused problem={dialog.problem} />
        {dialog.skillLabel === null && (
          <Field label={t('level.skill')} required>
            <Select value={dialog.skillId ?? ''} onChange={(event) => actions?.onPatch({ skillId: event.target.value || null })}>
              <option value="">{t('level.skillPick')}</option>
              {model.skills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skillName(skill, locale)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('level.level')} required hint={t('level.judgement')}>
          <Select value={dialog.level ?? ''} onChange={(event) => actions?.onPatch({ level: event.target.value || null })}>
            <option value="">{t('level.levelPick')}</option>
            {SKILL_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(`level.${level}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('level.trainee')} hint={t(dialog.hasTrainee ? 'level.traineeOpen' : 'level.traineeHint')}>
          <DateField value={dialog.until} onChange={(value) => actions?.onPatch({ until: value })} clearable={!dialog.hasTrainee} />
        </Field>
      </div>
    </Modal>
  )
}

// ---- a reason, then final ------------------------------------------------------------------------------------------------------

function ReasonDialog({ title, body, confirm, dialog, onConfirm, actions }: { title: string; body: string; confirm: string; dialog: { reason: string; busy: boolean; problem: SkillProblem | null }; onConfirm?: () => void; actions?: SkillDialogActions }) {
  const t = useSkillWords()
  const id = useId()
  const held = reasonHeld(dialog.reason)
  return (
    <Modal
      open
      onClose={() => actions?.onClose()}
      title={title}
      size="sm"
      footer={
        <Foot onClose={actions?.onClose}>
          <Button variant="danger" heldReason={held ? t(held) : null} disabled={dialog.busy} onClick={onConfirm}>
            {confirm}
          </Button>
        </Foot>
      }
    >
      <div className="fw-sk-form">
        <Refused problem={dialog.problem} />
        <p className="fw-sk-hint">{body}</p>
        <Field label={t('common.reason')} required htmlFor={id}>
          <Textarea id={id} rows={3} value={dialog.reason} maxLength={300} onChange={(event) => actions?.onPatch({ reason: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

function ValidUntilDialog({ dialog, actions }: { dialog: Extract<SkillDialog, { kind: 'validUntil' }>; actions?: SkillDialogActions }) {
  const t = useSkillWords()
  return (
    <Modal
      open
      onClose={() => actions?.onClose()}
      title={t('validUntil.title', { machine: dialog.classLabel })}
      subtitle={dialog.person.name}
      size="sm"
      footer={
        <Foot onClose={actions?.onClose}>
          <Button variant="primary" disabled={dialog.busy} heldReason={dialog.until && dialog.until < dialog.from ? t('held.untilBeforeFrom') : null} onClick={() => actions?.onValidUntil()}>
            {t('common.save')}
          </Button>
        </Foot>
      }
    >
      <div className="fw-sk-form">
        <Refused problem={dialog.problem} />
        <Field label={t('authorise.until')} hint={t('authorise.untilHint')}>
          <DateField value={dialog.until} min={dialog.from} onChange={(value) => actions?.onPatch({ until: value })} clearable />
        </Field>
      </div>
    </Modal>
  )
}

// ---- the list of skills (the matrix's columns) -------------------------------------------------------------------------------

export const skillDraftHeld = (draft: SkillDraft): string | null => (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(draft.code.trim()) ? 'held.skillCode' : !draft.nameIt.trim() ? 'held.skillName' : draft.kind === 'OPERATION' && !draft.targetId ? 'held.skillOperation' : draft.kind === 'MACHINE' && !draft.targetId ? 'held.skillClass' : null)

const KINDS: readonly SkillKind[] = ['OPERATION', 'MACHINE', 'GENERAL']

function CatalogueDialog({ model, dialog, actions }: { model: SkillDialogsModel; dialog: Extract<SkillDialog, { kind: 'catalogue' }>; actions?: SkillDialogActions }) {
  const t = useSkillWords()
  const locale = useLocale()
  const held = skillDraftHeld(dialog.draft)
  const draft = (change: Partial<SkillDraft>) => actions?.onPatch({ draft: { ...dialog.draft, ...change } })
  const rows = dialog.skills ?? []
  return (
    <Modal open onClose={() => actions?.onClose()} title={t('catalogue.title')} subtitle={t('catalogue.subtitle')} size="lg">
      <div className="fw-sk-form">
        <Refused problem={dialog.problem} />
        {dialog.skills === null && !dialog.problem ? (
          <p className="fw-sk-hint" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        ) : (
          <SummaryTable
            label={t('catalogue.title')}
            columns={[t('catalogue.code'), t('catalogue.name'), t('catalogue.kind'), t('catalogue.status'), t('catalogue.actions')]}
            density="roomy"
            stackOnPhone
            rows={rows.map((skill) => ({
              id: skill.id,
              cells: [
                skill.code,
                skillName(skill, locale),
                t(`kind.${skill.kind}`),
                <Pill key="status" tone={skill.status === 'ACTIVE' ? 'success' : 'neutral'}>
                  {t(`status.${skill.status}`)}
                </Pill>,
                <Button key="act" size="sm" variant="quiet" disabled={dialog.busy} onClick={() => actions?.onSkillStatus(skill, skill.status === 'ACTIVE' ? 'archive' : 'restore')}>
                  {t(skill.status === 'ACTIVE' ? 'catalogue.archive' : 'catalogue.restore')}
                </Button>,
              ],
            }))}
          />
        )}
        {dialog.adding ? (
          <div className="fw-sk-form boxed">
            <div className="fw-sk-pair">
              <Field label={t('catalogue.code')} required hint={t('catalogue.codeHint')}>
                <Input value={dialog.draft.code} maxLength={40} onChange={(event) => draft({ code: event.target.value })} />
              </Field>
              <Field label={t('catalogue.kind')} required>
                <Select value={dialog.draft.kind} onChange={(event) => draft({ kind: event.target.value as SkillKind, targetId: null })}>
                  {KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`kind.${kind}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('catalogue.nameIt')} required>
                <Input value={dialog.draft.nameIt} maxLength={120} onChange={(event) => draft({ nameIt: event.target.value })} />
              </Field>
              <Field label={t('catalogue.nameEn')}>
                <Input value={dialog.draft.nameEn} maxLength={120} onChange={(event) => draft({ nameEn: event.target.value })} />
              </Field>
              {dialog.draft.kind === 'OPERATION' && (
                <Field label={t('catalogue.operation')} required hint={dialog.operations?.length === 0 ? t('catalogue.noOperations') : undefined}>
                  <Select value={dialog.draft.targetId ?? ''} onChange={(event) => draft({ targetId: event.target.value || null })}>
                    <option value="">{t('catalogue.operationPick')}</option>
                    {(dialog.operations ?? []).map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {dialog.draft.kind === 'MACHINE' && (
                <Field label={t('catalogue.machine')} required>
                  <Select value={dialog.draft.targetId ?? ''} onChange={(event) => draft({ targetId: event.target.value || null })}>
                    <option value="">{t('authorise.machinePick')}</option>
                    {model.classes.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {className(entry, locale)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            <span className="fw-sk-row">
              <Button variant="primary" size="sm" heldReason={held ? t(held) : null} disabled={dialog.busy} onClick={() => actions?.onAddSkill()}>
                {t('catalogue.save')}
              </Button>
              <Button variant="quiet" size="sm" onClick={() => actions?.onPatch({ adding: false })}>
                {t('common.cancel')}
              </Button>
            </span>
          </div>
        ) : (
          <span>
            <Button size="sm" onClick={() => actions?.onPatch({ adding: true })}>
              {t('catalogue.add')}
            </Button>
          </span>
        )}
      </div>
    </Modal>
  )
}
