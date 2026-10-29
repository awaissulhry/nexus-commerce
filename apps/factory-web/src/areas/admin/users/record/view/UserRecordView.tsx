'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner, Card, Field, KeyValue, Modal, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Select, Skeleton, Tag, Textarea } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Assignment, Role } from '../../../shared/api'
import { adminHref, EVERYWHERE, grainsOf, scopeWords, STATUS_TONE } from '../../../shared/model'
import { AdminMessages, GrainChips, ListState, NoticeBanner, RecordProblem, StepUp, useRoleWords } from '../../../shared/view/parts'
import { RecordFrame } from '../../../shared/view/RecordFrame'
import { ScopePicker } from '../../../shared/view/ScopePicker'
import { giveRoleProblems, lifecycleHeld, raises, type GiveRoleDraft, type UserDialog, type UserRecordModel, type UserTab } from '../model'

export type { UserRecordModel } from '../model'

export interface UserRecordActions {
  onDialog?: (dialog: UserDialog | null, endId?: string) => void
  /** Each resolves true when done (the dialog then closes). */
  onGiveRole?: (draft: GiveRoleDraft) => Promise<boolean>
  onEndRole?: (assignment: Assignment, reason: string) => Promise<boolean>
  onLifecycle?: (action: 'suspend' | 'reactivate' | 'deactivate' | 'password', reason: string) => Promise<boolean>
  onStepUp?: (code: string) => void
  onStepUpClose?: () => void
  onDock?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-011 — an office person's record (design 02 admin.users "Record: User"): Profile (who, status, the danger zone:
 * suspend, reactivate, deactivate, force a new password), Roles & scope (role × where × when, what they can do in plain
 * sentences with what money they see; Give role and End, each after a fresh code when it raises rights) and Activity.
 * The last administrator is held before the click. Fetches nothing (UserRecord.tsx reads the API).
 */
export function UserRecordView({ model, actions, panels }: { model: UserRecordModel; actions?: UserRecordActions; panels?: ReactNode }) {
  return (
    <AdminMessages>
      <UserRecord model={model} actions={actions} panels={panels} />
    </AdminMessages>
  )
}

function UserRecord({ model, actions, panels }: { model: UserRecordModel; actions?: UserRecordActions; panels?: ReactNode }) {
  const t = useT('admin')
  const href = (path: string) => adminHref(model.prefix, path)
  const back = { href: href('/users'), label: t('nav.users') }
  const [dialog, setDialog] = useState<UserDialog | null>(model.dialog ?? null)
  const [endId, setEndId] = useState<string | null>(model.endId ?? null)
  useEffect(() => {
    setDialog(model.dialog ?? null)
    setEndId(model.endId ?? null)
  }, [model.dialog, model.endId])
  const open = (next: UserDialog | null, end?: string) => {
    setDialog(next)
    if (end) setEndId(end)
    actions?.onDialog?.(next, end)
  }
  const user = model.user
  if (!user) {
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
        <Skeleton height={28} width="60%" />
        <Skeleton height={220} />
      </div>
    )
  }
  const held = lifecycleHeld(model)
  const live = (model.assignments.items ?? []).filter((assignment) => assignment.live)
  const tabs: Array<{ id: UserTab; label: string; count?: number | null }> = [
    { id: 'profile', label: t('user.tab.profile') },
    { id: 'roles', label: t('user.tab.roles'), count: model.assignments.items ? live.length : null },
    { id: 'activity', label: t('user.tab.activity') },
  ]

  return (
    <div className="fw-adm">
      <RecordFrame
        back={back}
        title={user.displayName}
        meta={user.email}
        status={
          <span className="fw-adm-tags">
            <Pill tone={STATUS_TONE[user.status] ?? 'neutral'}>{t(`users.status.${user.status}`)}</Pill>
            {user.status !== 'INVITED' && <Tag tone={user.mfaEnabled ? 'success' : 'warning'}>{t(user.mfaEnabled ? 'user.mfaOn' : 'user.mfaOff')}</Tag>}
          </span>
        }
        actions={
          <Button size="sm" variant="primary" onClick={() => open('give-role')} heldReason={heldWords(t, held.assign)}>
            {t('user.giveRole')}
          </Button>
        }
        tabs={tabs}
        active={model.tab}
        tabHref={(tab) => `${href(`/users/${user.id}`)}?tab=${tab}`}
        dock={model.tab === 'activity' ? undefined : panels}
        dockOpen={model.dockOpen}
        onDock={actions?.onDock}
      >
        <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
        {model.tab === 'profile' && <ProfileTab model={model} open={open} />}
        {model.tab === 'roles' && <RolesTab model={model} open={open} actions={actions} />}
        {model.tab === 'activity' && panels}
      </RecordFrame>
      <GiveRoleModal model={model} open={dialog === 'give-role'} onClose={() => open(null)} actions={actions} />
      <EndRoleModal model={model} open={dialog === 'end-role'} endId={endId} onClose={() => open(null)} actions={actions} />
      {(dialog === 'suspend' || dialog === 'reactivate' || dialog === 'deactivate' || dialog === 'password') && <LifecycleModal model={model} action={dialog} onClose={() => open(null)} actions={actions} />}
      <StepUp model={model.stepUp} onSubmit={actions?.onStepUp} onClose={actions?.onStepUpClose} />
    </div>
  )
}

/** A held reason as words: a missing right ("Needs: Suspend people"), or the rule's own sentence. */
function heldWords(t: (key: string, params?: Record<string, string | number>) => string, reason: string | null): string | null {
  if (!reason) return null
  return reason.startsWith('right.') ? t('held.needs', { right: t(reason) }) : t(reason)
}

function ProfileTab({ model, open }: { model: UserRecordModel; open: (dialog: UserDialog) => void }) {
  const t = useT('admin')
  const locale = useLocale()
  const user = model.user!
  const held = lifecycleHeld(model)
  const row = (action: 'suspend' | 'reactivate' | 'deactivate' | 'password', tone: 'danger-outline' | 'secondary') => (
    <div className="fw-adm-danger-row">
      <div>
        <strong>{t(`user.${action}.title`)}</strong>
        <span className="fw-adm-hint">{t(`user.${action}.body`)}</span>
      </div>
      <Button size="sm" variant={tone} heldReason={heldWords(t, held[action])} onClick={() => open(action)}>
        {t(`user.${action}.action`)}
      </Button>
    </div>
  )
  return (
    <div className="fw-adm-stack">
      <Card header={t('user.who')} headingLevel={2} padded>
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('users.invite.name'), value: user.displayName },
            { label: t('users.invite.email'), value: user.email },
            { label: t('users.col.language'), value: t(`common.language.${user.locale}`) },
            { label: t('users.col.status'), value: t(`users.status.${user.status}`) },
            { label: t('users.col.twoFactor'), value: user.status === 'INVITED' ? '—' : t(user.mfaEnabled ? 'users.mfa.on' : 'users.mfa.off') },
            { label: t('users.col.lastSignIn'), value: user.lastSignInAt ? formatDateTime(user.lastSignInAt, { locale }) : '—' },
            ...(user.invitationExpiresAt ? [{ label: t('user.invitedUntil'), value: formatDateTime(user.invitationExpiresAt, { locale }) }] : []),
          ]}
        />
        <p className="fw-adm-hint">{t('user.editLater')}</p>
      </Card>
      {model.lastAdmin && <Banner tone="info" title={t('user.lastAdmin')} />}
      <Card header={t('record.dangerZone')} headingLevel={2} padded>
        <div className="fw-adm-danger">
          {row('password', 'secondary')}
          {user.status === 'SUSPENDED' ? row('reactivate', 'secondary') : row('suspend', 'danger-outline')}
          {row('deactivate', 'danger-outline')}
        </div>
      </Card>
    </div>
  )
}

function RolesTab({ model, open, actions }: { model: UserRecordModel; open: (dialog: UserDialog, end?: string) => void; actions?: UserRecordActions }) {
  const t = useT('admin')
  const locale = useLocale()
  const items = model.assignments.items
  const held = lifecycleHeld(model)
  const words = useRoleWords()
  if (items === null || model.assignments.problem) return <ListState loading={items === null} problem={model.assignments.problem} onRetry={actions?.onRetry} />
  const live = items.filter((assignment) => assignment.live)
  const roleOf = (id: string) => model.roles?.find((role) => role.id === id)
  const grains = model.roles ? grainsOf(live.map((assignment) => roleOf(assignment.roleId) ?? { grains: [] })) : null
  return (
    <div className="fw-adm-stack">
      <Card header={t('user.canDo')} headingLevel={2} padded>
        {live.length === 0 ? (
          <p className="fw-adm-intro">{t('user.noRole')}</p>
        ) : (
          <ul className="fw-adm-guards">
            {live.map((assignment) => (
              <li key={assignment.id}>
                <strong>{words.name({ key: assignment.roleKey, name: assignment.roleName })}</strong> — {words.description({ key: assignment.roleKey, description: roleOf(assignment.roleId)?.description ?? null }) ?? t('roles.noDescription')} · {scopeWords(assignment, model.companies, t('scope.all'))}
              </li>
            ))}
          </ul>
        )}
        {grains && (
          <p className="fw-adm-cell-row">
            <span className="fw-adm-hint">{t('user.seesMoney')}</span> <GrainChips grains={grains} />
          </p>
        )}
      </Card>
      <Card
        header={t('user.assignments')}
        headingLevel={2}
        headerAction={
          <Button size="sm" onClick={() => open('give-role')} heldReason={heldWords(t, held.assign)}>
            {t('user.giveRole')}
          </Button>
        }
      >
        {items.length === 0 ? (
          <p className="fw-adm-hint">{t('user.noRole')}</p>
        ) : (
          <SummaryTable
            label={t('user.assignments')}
            density="roomy"
            stackOnPhone
            columns={[t('users.col.roles'), t('users.col.where'), t('user.col.from'), t('user.col.to'), t('users.col.status'), t('common.actions')]}
            align={['left', 'left', 'left', 'left', 'left', 'right']}
            rows={items.map((assignment) => ({
              id: assignment.id,
              cells: [
                <span key="role" className="fw-adm-name">{words.name({ key: assignment.roleKey, name: assignment.roleName })}</span>,
                scopeWords(assignment, model.companies, t('scope.all')) || '—',
                formatDate(assignment.validFrom, { locale }),
                assignment.endedAt ? formatDate(assignment.endedAt, { locale }) : assignment.validTo ? formatDate(assignment.validTo, { locale }) : t('user.noEnd'),
                <Pill key="state" tone={assignment.live ? 'success' : 'neutral'}>{t(assignment.live ? 'user.live' : 'user.ended')}</Pill>,
                assignment.live ? (
                  <Button key="end" size="sm" variant="quiet" heldReason={heldWords(t, held.assign)} onClick={() => open('end-role', assignment.id)}>
                    {t('user.end')}
                    <span className="fw-adm-sr"> {words.name({ key: assignment.roleKey, name: assignment.roleName })}</span>
                  </Button>
                ) : (
                  ''
                ),
              ],
            }))}
          />
        )}
      </Card>
      <p className="fw-adm-hint">{t('user.sessionsLater')}</p>
    </div>
  )
}

function RoleOption({ role }: { role: Role }) {
  const words = useRoleWords()
  return <option value={role.id}>{words.name(role)}</option>
}

function GiveRoleModal({ model, open, onClose, actions }: { model: UserRecordModel; open: boolean; onClose: () => void; actions?: UserRecordActions }) {
  const t = useT('admin')
  const officeRoles = (model.roles ?? []).filter((role) => role.audience === 'office')
  const blank: GiveRoleDraft = { roleId: officeRoles[0]?.id ?? '', scope: EVERYWHERE, validFrom: '', validTo: '' }
  const [draft, setDraft] = useState<GiveRoleDraft>(blank)
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) {
      setDraft({ roleId: officeRoles[0]?.id ?? '', scope: EVERYWHERE, validFrom: '', validTo: '' })
      setTried(false)
    }
    // The roles arrive once; a reopened dialog starts clean.
  }, [open, officeRoles.length])
  const problems = giveRoleProblems(draft)
  const ready = Object.keys(problems).length === 0
  const role = officeRoles.find((item) => item.id === draft.roleId)
  const words = useRoleWords()
  const raising = model.roles ? raises(draft.roleId, model.assignments.items ?? [], model.roles) : true
  const submit = () => {
    setTried(true)
    if (ready && !model.busy) void actions?.onGiveRole?.(draft)
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('user.give.title', { name: model.user?.displayName ?? '' })}
      size="md"
      busy={model.busy}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} heldReason={tried && !ready ? t('form.fixFirst', { count: Object.keys(problems).length }) : model.busy ? t('common.saving') : null}>
            {t('user.giveRole')}
          </Button>
        </>
      }
    >
      <form
        className="fw-adm-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit()
        }}
      >
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem)} />}
        <Field label={t('user.give.role')} required error={tried && problems.roleId ? t(problems.roleId) : undefined}>
          <Select autoFocus value={draft.roleId} onChange={(event) => setDraft({ ...draft, roleId: event.target.value })}>
            {officeRoles.map((item) => (
              <RoleOption key={item.id} role={item} />
            ))}
          </Select>
        </Field>
        {role && (
          <p className="fw-adm-cell">
            <span className="fw-adm-intro">{words.description(role) ?? t('roles.noDescription')}</span>
            <GrainChips grains={role.grains} label={t('grains.labelOf', { name: words.name(role) })} />
          </p>
        )}
        <fieldset className="fw-adm-pick">
          <legend className="fw-adm-name">{t('users.invite.where')}</legend>
          {tried && problems.scope && <Banner tone="warning" title={t(problems.scope)} />}
          <ScopePicker name="give-scope" value={draft.scope} companies={model.companies} onChange={(scope) => setDraft({ ...draft, scope })} />
        </fieldset>
        <div className="fw-adm-form">
          <Field label={t('user.col.from')} hint={t('user.give.fromHint')}>
            <Input type="date" value={draft.validFrom} onChange={(event) => setDraft({ ...draft, validFrom: event.target.value })} />
          </Field>
          <Field label={t('user.col.to')} hint={t('user.give.toHint')} error={tried && problems.validTo ? t(problems.validTo) : undefined}>
            <Input type="date" value={draft.validTo} onChange={(event) => setDraft({ ...draft, validTo: event.target.value })} />
          </Field>
        </div>
        {role && (
          <Banner tone={raising ? 'warning' : 'info'} title={t('user.give.summary', { name: model.user?.displayName ?? '', role: words.name(role), where: scopeWords(draft.scope, model.companies, t('scope.all')) || '—' })}>
            {raising ? t('user.give.raises') : t('user.give.noRaise')}
          </Banner>
        )}
      </form>
    </Modal>
  )
}

function EndRoleModal({ model, open, endId, onClose, actions }: { model: UserRecordModel; open: boolean; endId: string | null; onClose: () => void; actions?: UserRecordActions }) {
  const t = useT('admin')
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (open) setReason('')
  }, [open])
  const assignment = (model.assignments.items ?? []).find((item) => item.id === endId)
  const words = useRoleWords()
  if (!assignment) return null
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('user.endRole.title', { role: words.name({ key: assignment.roleKey, name: assignment.roleName }), name: model.user?.displayName ?? '' })}
      size="sm"
      busy={model.busy}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" heldReason={model.busy ? t('common.saving') : null} onClick={() => void actions?.onEndRole?.(assignment, reason.trim())}>
            {t('user.end')}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem)} />}
        <p className="fw-adm-intro">{t('user.endRole.body')}</p>
        <Field label={t('common.reason')} hint={t('common.reasonHint')}>
          <Textarea rows={2} limit={500} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

function LifecycleModal({ model, action, onClose, actions }: { model: UserRecordModel; action: 'suspend' | 'reactivate' | 'deactivate' | 'password'; onClose: () => void; actions?: UserRecordActions }) {
  const t = useT('admin')
  const [reason, setReason] = useState('')
  const held = lifecycleHeld(model)[action]
  return (
    <Modal
      open
      onClose={onClose}
      title={t(`user.${action}.confirm`, { name: model.user?.displayName ?? '' })}
      size="sm"
      busy={model.busy}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant={action === 'reactivate' || action === 'password' ? 'primary' : 'danger'} heldReason={heldWords(t, held) ?? (model.busy ? t('common.saving') : null)} onClick={() => void actions?.onLifecycle?.(action, reason.trim())}>
            {t(`user.${action}.action`)}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem)} />}
        <p className="fw-adm-intro">{t(`user.${action}.consequence`)}</p>
        {action === 'deactivate' && <p className="fw-adm-hint">{t('user.deactivate.handover')}</p>}
        <Field label={t('common.reason')} hint={t('common.reasonHint')}>
          <Textarea rows={2} limit={500} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
