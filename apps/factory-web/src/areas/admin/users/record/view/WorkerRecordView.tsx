'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, CheckboxCard, Input, Pill, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { EditModeBar, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { adminHref, STATUS_TONE } from '../../../shared/model'
import { OneTimeReveal } from '../../../shared/view/OneTimeReveal'
import { AdminMessages, GrainChips, NoticeBanner, RecordProblem, StepUp, useRoleWords } from '../../../shared/view/parts'
import { RecordFrame } from '../../../shared/view/RecordFrame'
import { FLOOR_LOCALES } from '../../model'
import { ownWorker, workerDraft, workerProfileProblems, type WorkerDialog, type WorkerProfileDraft, type WorkerRecordModel, type WorkerTab } from '../model'

export type { WorkerRecordModel } from '../model'

export interface WorkerRecordActions {
  onDialog?: (dialog: WorkerDialog | null) => void
  onSaveProfile?: (draft: WorkerProfileDraft) => Promise<boolean>
  onIssueBadge?: () => Promise<boolean>
  onMarkLost?: (status: 'LOST' | 'REVOKED') => Promise<boolean>
  onResetPin?: () => Promise<boolean>
  onSaveRoles?: (roleIds: string[]) => Promise<boolean>
  onStatus?: (action: 'deactivate' | 'reactivate', reason: string) => Promise<boolean>
  onRevealClose?: () => void
  onStepUp?: (code: string) => void
  onStepUpClose?: () => void
  onDock?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-011 — a floor worker's record (design 02 admin.users "Record: User", floor): Profile (the least data the work needs,
 * GDPR art. 5(1)(c)), Badge & PIN (the badge's last 4, issue a new one, mark it lost; the PIN's state and reset; floor
 * roles) and Activity. A badge code and a reset PIN are shown ONCE (the API keeps hashes). Badge, PIN and roles ask for a
 * fresh code; nobody manages their own. Fetches nothing (WorkerRecord.tsx reads the API).
 */
export function WorkerRecordView({ model, actions, panels }: { model: WorkerRecordModel; actions?: WorkerRecordActions; panels?: ReactNode }) {
  return (
    <AdminMessages>
      <WorkerRecord model={model} actions={actions} panels={panels} />
    </AdminMessages>
  )
}

function WorkerRecord({ model, actions, panels }: { model: WorkerRecordModel; actions?: WorkerRecordActions; panels?: ReactNode }) {
  const t = useT('admin')
  const href = (path: string) => adminHref(model.prefix, path)
  const back = { href: `${href('/users')}?audience=floor`, label: t('nav.users') }
  const [dialog, setDialog] = useState<WorkerDialog | null>(model.dialog ?? null)
  useEffect(() => setDialog(model.dialog ?? null), [model.dialog])
  const open = (next: WorkerDialog | null) => {
    setDialog(next)
    actions?.onDialog?.(next)
  }
  const worker = model.worker
  if (!worker) {
    if (model.problem)
      return (
        <div className="fw-adm">
          <RecordProblem
            problem={model.problem}
            onRetry={actions?.onRetry}
            back={
              <Button size="sm" asChild>
                <Link href={back.href}>{t('record.backTo', { name: back.label })}</Link>
              </Button>
            }
          />
        </div>
      )
    return (
      <div className="fw-adm" aria-busy="true">
        <Skeleton height={36} width="40%" />
        <Skeleton height={220} />
      </div>
    )
  }
  const own = ownWorker(worker, model.me)
  const credentialsHeld = !model.can.credentials ? t('held.needs', { right: t('right.workers_credentials') }) : own ? t('worker.held.own') : worker.status !== 'ACTIVE' ? t('worker.held.inactive') : null
  const tabs: Array<{ id: WorkerTab; label: string; count?: number | null }> = [
    { id: 'profile', label: t('worker.tab.profile') },
    { id: 'badge', label: t('worker.tab.badge') },
    { id: 'activity', label: t('worker.tab.activity') },
  ]
  return (
    <div className="fw-adm">
      <RecordFrame
        back={back}
        title={worker.displayName}
        meta={[model.siteName, worker.employeeCode ? t('users.employeeNo', { code: worker.employeeCode }) : null].filter(Boolean).join(' · ') || undefined}
        status={
          <span className="fw-adm-tags">
            <Pill tone={STATUS_TONE[worker.status] ?? 'neutral'}>{t(`users.workerStatus.${worker.status}`)}</Pill>
            {worker.locked && <Tag tone="warning">{t('users.locked')}</Tag>}
          </span>
        }
        actions={
          <>
            <Button size="sm" onClick={() => open('pin')} heldReason={credentialsHeld}>
              {t('worker.pin.reset')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => open('badge')} heldReason={credentialsHeld}>
              {t(worker.badge ? 'worker.badge.reissue' : 'worker.badge.issue')}
            </Button>
          </>
        }
        tabs={tabs}
        active={model.tab}
        tabHref={(tab) => `${href(`/users/floor/${worker.id}`)}?tab=${tab}`}
        dock={model.tab === 'activity' ? undefined : panels}
        dockOpen={model.dockOpen}
        onDock={actions?.onDock}
      >
        <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
        {own && <Banner tone="info" title={t('worker.ownBanner')} />}
        {model.tab === 'profile' && <ProfileTab model={model} actions={actions} open={open} />}
        {model.tab === 'badge' && <BadgeTab model={model} open={open} credentialsHeld={credentialsHeld} />}
        {model.tab === 'activity' && panels}
      </RecordFrame>
      <Confirm model={model} dialog={dialog} onClose={() => open(null)} actions={actions} />
      <RolesModal model={model} open={dialog === 'roles'} onClose={() => open(null)} actions={actions} />
      <OneTimeReveal
        model={model.reveal ?? null}
        onClose={actions?.onRevealClose}
        extra={model.reveal?.kind === 'badge' ? <p className="fw-adm-hint">{t('reveal.badge.printHint')}</p> : undefined}
      />
      <StepUp model={model.stepUp} onSubmit={actions?.onStepUp} onClose={actions?.onStepUpClose} />
    </div>
  )
}

function ProfileTab({ model, actions, open }: { model: WorkerRecordModel; actions?: WorkerRecordActions; open: (dialog: WorkerDialog) => void }) {
  const t = useT('admin')
  const worker = model.worker!
  const read = useMemo(() => workerDraft(worker), [worker])
  const [draft, setDraft] = useState<WorkerProfileDraft>(model.draft ?? read)
  useEffect(() => setDraft(model.draft ?? read), [read, model.draft])
  const editable = model.can.manage && worker.status === 'ACTIVE'
  const problems = workerProfileProblems(draft)
  const dirty = draft.displayName !== read.displayName || draft.locale !== read.locale || draft.employeeCode !== read.employeeCode
  return (
    <div className="fw-adm-stack">
      <Banner tone="info" title={t('users.worker.minimal')} />
      <Card header={t('user.who')} headingLevel={2} padded>
        {editable ? (
          <div className="fw-adm-form">
            <Field label={t('users.worker.name')} required error={problems.displayName ? t(problems.displayName) : undefined}>
              <Input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
            </Field>
            <Field label={t('users.worker.language')}>
              <Select value={draft.locale} onChange={(event) => setDraft({ ...draft, locale: event.target.value })}>
                {[...new Set([draft.locale, ...FLOOR_LOCALES])].map((code) => (
                  <option key={code} value={code}>
                    {t(`common.language.${code}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('users.worker.employeeNo')} hint={t('users.worker.employeeHint')} error={problems.employeeCode ? t(problems.employeeCode) : undefined}>
              <Input value={draft.employeeCode} onChange={(event) => setDraft({ ...draft, employeeCode: event.target.value })} />
            </Field>
            <Field label={t('users.worker.site')} hint={t('worker.siteHint')}>
              <Input value={model.siteName ?? '—'} readOnly />
            </Field>
          </div>
        ) : (
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('users.worker.name'), value: worker.displayName },
              { label: t('users.worker.language'), value: t(`common.language.${worker.locale}`) },
              { label: t('users.worker.employeeNo'), value: worker.employeeCode ?? '—' },
              { label: t('users.worker.site'), value: model.siteName ?? '—' },
            ]}
          />
        )}
      </Card>
      {model.can.manage && (
        <Card header={t('record.dangerZone')} headingLevel={2} padded>
          <div className="fw-adm-danger-row">
            <div>
              <strong>{t(worker.status === 'ACTIVE' ? 'worker.deactivate.title' : 'worker.reactivate.title')}</strong>
              <span className="fw-adm-hint">{t(worker.status === 'ACTIVE' ? 'worker.deactivate.body' : 'worker.reactivate.body')}</span>
            </div>
            <Button size="sm" variant={worker.status === 'ACTIVE' ? 'danger-outline' : 'secondary'} onClick={() => open(worker.status === 'ACTIVE' ? 'deactivate' : 'reactivate')}>
              {t(worker.status === 'ACTIVE' ? 'worker.deactivate.action' : 'worker.reactivate.action')}
            </Button>
          </div>
        </Card>
      )}
      {editable && dirty && (
        <EditModeBar
          count={1}
          message={t('form.unsaved', { count: 1 })}
          applyLabel={t('common.save')}
          busy={model.busy}
          saveShortcut
          applyHeldReason={Object.keys(problems).length > 0 ? t('form.fixFirst', { count: Object.keys(problems).length }) : null}
          onDiscard={() => setDraft(read)}
          onApply={() => void actions?.onSaveProfile?.(draft)}
        />
      )}
    </div>
  )
}

function BadgeTab({ model, open, credentialsHeld }: { model: WorkerRecordModel; open: (dialog: WorkerDialog) => void; credentialsHeld: string | null }) {
  const t = useT('admin')
  const locale = useLocale()
  const worker = model.worker!
  const own = ownWorker(worker, model.me)
  const words = useRoleWords()
  const rolesHeld = !model.can.roles ? t('held.needs', { right: t('right.workers_roles') }) : own ? t('worker.held.own') : worker.status !== 'ACTIVE' ? t('worker.held.inactive') : null
  return (
    <div className="fw-adm-stack">
      <Card
        header={t('worker.badge.title')}
        description={t('worker.badge.hint')}
        headingLevel={2}
        padded
        headerAction={
          worker.badge ? (
            <Button size="sm" variant="danger-outline" heldReason={credentialsHeld} onClick={() => open('lost')}>
              {t('worker.badge.lost')}
            </Button>
          ) : undefined
        }
      >
        {worker.badge ? (
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('worker.badge.hintLabel'), value: <span className="fw-adm-code">{t('users.badgeHint', { hint: worker.badge.hint })}</span> },
              { label: t('worker.badge.issued'), value: formatDate(worker.badge.issuedAt, { locale }) },
            ]}
          />
        ) : (
          <p className="fw-adm-intro">{t('worker.badge.none')}</p>
        )}
      </Card>
      <Card header={t('worker.pin.title')} description={t('worker.pin.hint')} headingLevel={2} padded>
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('worker.pin.state'), value: t(worker.pinMustChange ? 'worker.pin.mustChange' : worker.hasPin ? 'worker.pin.set' : 'worker.pin.none') },
            { label: t('worker.pin.lock'), value: t(worker.locked ? 'worker.pin.locked' : 'worker.pin.notLocked') },
          ]}
        />
        <span className="fw-adm-actions">
          <Button size="sm" heldReason={credentialsHeld} onClick={() => open('pin')}>
            {t('worker.pin.reset')}
          </Button>
        </span>
        {worker.locked && <p className="fw-adm-hint">{t('worker.pin.unlockHint')}</p>}
      </Card>
      <Card
        header={t('worker.roles.title')}
        description={t('worker.roles.hint')}
        headingLevel={2}
        padded
        headerAction={
          <Button size="sm" heldReason={rolesHeld} onClick={() => open('roles')}>
            {t('worker.roles.change')}
          </Button>
        }
      >
        {worker.roles.length === 0 ? (
          <p className="fw-adm-intro">{t('users.noFloorRole')}</p>
        ) : (
          <span className="fw-adm-tags">
            {worker.roles.map((role) => (
              <Tag key={role.workerRoleId}>{words.name(role)}</Tag>
            ))}
          </span>
        )}
      </Card>
    </div>
  )
}

function RolesModal({ model, open, onClose, actions }: { model: WorkerRecordModel; open: boolean; onClose: () => void; actions?: WorkerRecordActions }) {
  const t = useT('admin')
  const current = model.worker?.roles.map((role) => role.roleId) ?? []
  const [picked, setPicked] = useState<string[]>(current)
  useEffect(() => {
    if (open) setPicked(model.worker?.roles.map((role) => role.roleId) ?? [])
  }, [open, model.worker])
  const roles = (model.floorRoles ?? []).filter((role) => role.audience === 'floor')
  const words = useRoleWords()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('worker.roles.dialog', { name: model.worker?.displayName ?? '' })}
      size="md"
      busy={model.busy}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={model.busy ? t('common.saving') : null} onClick={() => void actions?.onSaveRoles?.(picked)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem)} />}
        {roles.map((role) => (
          <CheckboxCard
            key={role.id}
            variant="row"
            checked={picked.includes(role.id)}
            selected={picked.includes(role.id)}
            onChange={(event) => setPicked(event.target.checked ? [...picked, role.id] : picked.filter((id) => id !== role.id))}
            title={words.name(role)}
            description={
              <span className="fw-adm-cell">
                <span>{words.description(role) ?? t('roles.noDescription')}</span>
                <GrainChips grains={role.grains} label={t('grains.labelOf', { name: words.name(role) })} />
              </span>
            }
          />
        ))}
        <p className="fw-adm-hint">{t('worker.roles.stepUp')}</p>
      </div>
    </Modal>
  )
}

function Confirm({ model, dialog, onClose, actions }: { model: WorkerRecordModel; dialog: WorkerDialog | null; onClose: () => void; actions?: WorkerRecordActions }) {
  const t = useT('admin')
  const [reason, setReason] = useState('')
  useEffect(() => setReason(''), [dialog])
  if (!dialog || dialog === 'roles') return null
  const name = model.worker?.displayName ?? ''
  const run = () =>
    dialog === 'badge' ? actions?.onIssueBadge?.() : dialog === 'pin' ? actions?.onResetPin?.() : dialog === 'lost' ? actions?.onMarkLost?.('LOST') : actions?.onStatus?.(dialog, reason.trim())
  const danger = dialog === 'lost' || dialog === 'deactivate'
  return (
    <Modal
      open
      onClose={onClose}
      title={t(`worker.confirm.${dialog}.title`, { name })}
      size="sm"
      busy={model.busy}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant={danger ? 'danger' : 'primary'} heldReason={model.busy ? t('common.saving') : null} onClick={() => void run()}>
            {t(`worker.confirm.${dialog}.go`)}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem)} />}
        <p className="fw-adm-intro">{t(`worker.confirm.${dialog}.body`)}</p>
        {(dialog === 'deactivate' || dialog === 'reactivate') && (
          <Field label={t('common.reason')} hint={t('common.reasonHint')}>
            <Textarea rows={2} limit={500} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
        )}
        {(dialog === 'badge' || dialog === 'pin') && <p className="fw-adm-hint">{t('worker.confirm.stepUp')}</p>}
      </div>
    </Modal>
  )
}
