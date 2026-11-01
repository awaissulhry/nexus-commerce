'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRightLeft, ExternalLink, IdCard, LogOut, MoreHorizontal, Pencil, Upload } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu, SummaryTable, type TabItem } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Input, Pill, Select, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { AsOf, Countdown, DateField, EditModeBar, Timeline, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { EMPLOYEE_KINDS, type EmployeeRecord, type NextStep } from '../../../_shared/api'
import { activityAction, activityChanges, hoursText, zonedInstant } from '../../../_shared/model'
import { KindTag, languageText, LifecyclePill, LiveLine, NoticeBanner, PeopleMessages, PeoplePrivacyNote, RecordFrame, say, useWords, type Translate } from '../../../_shared/parts'
import { EmployeeDialogs, AgencyField, LOCALE_CHOICES } from '../../view/EmployeeDialogs'
import { LeaverCard } from '../../view/LeaversPanel'
import { EMPLOYEE_TABS, type EditDraft, type EmployeeRecordActions, type EmployeeRecordModel } from '../../view-model'

export type { EmployeeRecordActions, EmployeeRecordModel } from '../../view-model'

/**
 * SCR-085 — an employee (design people.employees "Record: Employee", a record page): the band (‹ Employees, the name, the
 * lifecycle, type, site and code; Print badge, Loan to another line, Start leaver steps; ⋯ Change team, Cancel leaving)
 * with the privacy note, and the W2b-1 tabs: Profile (Identity with its explicit edit, What we do not keep, the floor
 * sign-in read only — one edit path: Admin › Users —, the side panel with the next step), Job & team (the job's edit,
 * loans to other lines), Documents (what is signed or issued; no payslips) and Activity (every change with before → after,
 * who, when, why; the views of protected data). Skills & training, Attendance, Pay & piece rates and Safety join with their
 * own pages. J / K open the employee before or after in the list last opened.
 */
export function EmployeeRecordView({ model, actions }: { model: EmployeeRecordModel; actions?: EmployeeRecordActions }) {
  return (
    <PeopleMessages>
      <RecordBody model={model} actions={actions} />
    </PeopleMessages>
  )
}

type Place = { locale: ReturnType<typeof useLocale>; timeZone: string }
const dayText = (value: string | null, place: Place) => (value ? formatDate(`${value}T12:00:00Z`, place) : '—')

function RecordBody({ model, actions }: { model: EmployeeRecordModel; actions?: EmployeeRecordActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const listHref = `${model.prefix}/people/employees`
  const value = model.loaded.status === 'ready' ? model.loaded.value : null
  const employee = value?.employee ?? null
  const base = employee ? `${listHref}/${encodeURIComponent(employee.id)}` : listHref
  const tabs: TabItem[] = EMPLOYEE_TABS.map((tab) => ({ id: tab, href: tab === 'profile' ? base : `${base}?tab=${tab}`, label: t(`tab.${tab}`), count: tab === 'job' && value ? value.loans.filter((loan) => loan.state !== 'ENDED').length || null : null }))
  const left = employee?.status === 'LEFT'
  const manage = model.can.manageEmployees && (value?.canManage ?? false)

  // J / K: the employee before or after in the list last opened (design keys).
  const neighbours = useRef(model.neighbours)
  neighbours.current = model.neighbours
  const [jump, setJump] = useState<string | null>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.dialog || model.edit) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      const to = event.key === 'j' || event.key === 'J' ? neighbours.current.next : event.key === 'k' || event.key === 'K' ? neighbours.current.prev : null
      if (to) {
        event.preventDefault()
        setJump(to)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog, model.edit])

  let title: ReactNode = null
  let meta: ReactNode = null
  let bandActions: ReactNode = null
  if (employee && value) {
    title = employee.name
    meta = (
      <>
        <LifecyclePill lifecycle={employee.lifecycle} />
        <KindTag kind={employee.kind} />
        <Tag tone="neutral">{employee.site.code}</Tag>
        {employee.employeeCode ? <Tag tone="neutral">{employee.employeeCode}</Tag> : <Tag tone="warning">{t('record.noCode')}</Tag>}
      </>
    )
    const loanHeld = !model.can.manageLoans ? t('held.noManageLoans') : left ? t('held.left') : null
    const leaverHeld = !model.can.manageLeavers || !value.canLeave ? t('held.noManageLeavers') : left ? t('held.left') : value.leaving?.status === 'OPEN' ? t('held.alreadyLeaving') : null
    bandActions = (
      <span className="fw-pp-actions">
        <Button size="sm" onClick={() => actions?.onBadge?.()} heldReason={left ? t('held.left') : null}>
          <IdCard size={14} aria-hidden /> {t('list.printBadge')}
        </Button>
        <Button size="sm" heldReason={loanHeld} onClick={() => actions?.onLoan?.()}>
          <ArrowRightLeft size={14} aria-hidden /> {t('list.loan')}
        </Button>
        <Button size="sm" variant="danger-outline" heldReason={leaverHeld} onClick={() => actions?.onLeaver?.()}>
          <LogOut size={14} aria-hidden /> {t('list.leaver')}
        </Button>
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('record.more') }}
          items={[
            { id: 'team', label: t('record.changeTeam'), disabled: !model.can.manageTeams || left, description: !model.can.manageTeams ? t('held.noManageTeams') : left ? t('held.left') : undefined, onSelect: () => actions?.onTeamChange?.() },
            ...(value.leaving?.status === 'OPEN' ? [{ id: 'cancel', label: t('leavers.cancel'), onSelect: () => actions?.onCancelLeaving?.() }] : []),
            ...(model.neighbours.prev ? [{ id: 'prev', label: t('record.prev'), href: `${listHref}/${encodeURIComponent(model.neighbours.prev)}` }] : []),
            ...(model.neighbours.next ? [{ id: 'next', label: t('record.next'), href: `${listHref}/${encodeURIComponent(model.neighbours.next)}` }] : []),
          ]}
        />
      </span>
    )
  }

  return (
    <RecordFrame
      backHref={listHref}
      backLabel={t('record.back')}
      loaded={model.loaded}
      noun={t('record.noun')}
      title={title}
      meta={meta}
      actions={bandActions}
      status={<LiveLine asOf={model.asOf} live={model.live} />}
      note={<PeoplePrivacyNote sight={model.sight} text={t('privacy.record')} />}
      tabs={tabs}
      tab={model.tab}
      onRetry={actions?.onRetry}
    >
      {jump && <JumpTo href={`${listHref}/${encodeURIComponent(jump)}`} onDone={() => setJump(null)} />}
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {value && model.tab === 'profile' && <Profile model={model} value={value} actions={actions} manage={manage} place={place} />}
      {value && model.tab === 'job' && <Job model={model} value={value} actions={actions} manage={manage} place={place} />}
      {value && model.tab === 'documents' && <Documents model={model} value={value} place={place} />}
      {value && model.tab === 'activity' && <Activity model={model} value={value} place={place} />}
      {value && (
        <EmployeeDialogs
          model={{ dialog: model.dialog, can: model.can, prefix: model.prefix, origin: model.origin, companyName: value.employee.companyCode, sites: [value.employee.site], lines: model.lines, teams: model.teams, today: value.today, timeZone: model.timeZone }}
          actions={actions?.dialog}
        />
      )}
    </RecordFrame>
  )
}

/** A J / K jump: a real link followed (the record is a page). */
function JumpTo({ href, onDone }: { href: string; onDone: () => void }) {
  const link = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    link.current?.click()
    onDone()
  }, [href, onDone])
  return <Link ref={link} href={href} hidden aria-hidden tabIndex={-1} />
}

// ---- the explicit edit (Identity, Job) -----------------------------------------------------------------------------------------

function EditBar({ model, actions, t }: { model: EmployeeRecordModel; actions?: EmployeeRecordActions; t: Translate }) {
  const edit = model.edit
  if (!edit) return null
  const heldKey = editHeld(edit.draft, edit.section)
  const held = heldKey ? t(heldKey) : edit.codeTaken ? t('refusal.CODE_TAKEN') : null
  return <EditModeBar count={1} message={edit.problem ? say(t, edit.problem) : t('edit.unsaved')} onDiscard={actions?.onDiscard} onApply={actions?.onApply} applyLabel={t('edit.apply')} busy={edit.busy} applyHeldReason={held} saveShortcut />
}

/** Why Apply is held, or null (a message key). */
export function editHeld(draft: EditDraft, section: 'identity' | 'job'): string | null {
  if (section === 'identity') {
    if (!draft.firstName.trim() || !draft.lastName.trim()) return 'held.names'
    if (!draft.displayName.trim()) return 'held.displayName'
    if (!draft.startDate) return 'held.start'
    if (draft.kind === 'AGENCY' && !draft.agency) return 'held.agency'
    if (draft.kind === 'AGENCY' && !draft.endDate) return 'held.agencyEnd'
    if (draft.endDate && draft.endDate < draft.startDate) return 'held.endBeforeStart'
    if (draft.employeeCode.trim() && !/^[A-Za-z0-9._\-/]+$/.test(draft.employeeCode.trim())) return 'problem.field.employeeCode'
    return null
  }
  const hours = draft.hours.trim().replace(',', '.')
  if (hours && (!/^\d{1,2}(\.\d{1,2})?$/.test(hours) || Number(hours) <= 0 || Number(hours) > 80)) return 'problem.field.weeklyMinutes'
  return null
}

// ---- Profile --------------------------------------------------------------------------------------------------------------------

function Profile({ model, value, actions, manage, place }: { model: EmployeeRecordModel; value: EmployeeRecord; actions?: EmployeeRecordActions; manage: boolean; place: Place }) {
  const t = useWords()
  const ds = useDsWords()
  const id = useId()
  const employee = value.employee
  const editing = model.edit?.section === 'identity' ? model.edit : null
  const editHeldWords = !manage ? t('held.noManageEmployees') : employee.status === 'LEFT' ? t('held.left') : model.edit ? t('held.editing') : null
  const error = (field: string) => (editing?.field === field ? say(t, editing.problem) : null)
  const draft = editing?.draft
  return (
    <div className="fw-pp-split">
      <div className="fw-pp-stack">
        <Card
          padded
          header={t('profile.identity')}
          headingLevel={2}
          description={t('profile.identityWhy')}
          headerAction={
            !editing ? (
              <Button size="sm" heldReason={editHeldWords} onClick={() => actions?.onEdit?.('identity')}>
                <Pencil size={13} aria-hidden /> {t('edit.edit')}
              </Button>
            ) : undefined
          }
        >
          {draft ? (
            <form
              className="fw-pp-form"
              onSubmit={(event) => {
                event.preventDefault()
                actions?.onApply?.()
              }}
            >
              <Field label={t('field.firstName')} required htmlFor={`${id}-first`} error={error('firstName')}>
                <Input id={`${id}-first`} value={draft.firstName} maxLength={80} onChange={(event) => actions?.onDraft?.({ firstName: event.target.value })} />
              </Field>
              <Field label={t('field.lastName')} required htmlFor={`${id}-last`} error={error('lastName')}>
                <Input id={`${id}-last`} value={draft.lastName} maxLength={80} onChange={(event) => actions?.onDraft?.({ lastName: event.target.value })} />
              </Field>
              <Field label={t('field.displayName')} required hint={t('field.displayNameHint')} htmlFor={`${id}-floor`} error={error('displayName')}>
                <Input id={`${id}-floor`} value={draft.displayName} maxLength={40} onChange={(event) => actions?.onDraft?.({ displayName: event.target.value })} />
              </Field>
              <Field label={t('field.employeeCode')} hint={t('field.employeeCodeHint')} htmlFor={`${id}-code`} error={error('employeeCode') ?? (editing?.codeTaken ? t('refusal.CODE_TAKEN') : null)}>
                <Input id={`${id}-code`} value={draft.employeeCode} maxLength={24} onChange={(event) => actions?.onDraft?.({ employeeCode: event.target.value })} onBlur={() => actions?.onCodeLeft?.()} />
              </Field>
              <Field label={t('field.kind')} required htmlFor={`${id}-kind`}>
                <Select id={`${id}-kind`} value={draft.kind} onChange={(event) => actions?.onDraft?.({ kind: event.target.value as EditDraft['kind'], ...(event.target.value === 'AGENCY' ? {} : { agency: null }) })}>
                  {EMPLOYEE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`kind.${kind}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              {draft.kind === 'AGENCY' && <AgencyField t={t} id={`${id}-agency`} agency={draft.agency} agencies={model.agencies} can={model.can} error={error('agencyPartyId')} onPick={(agency) => actions?.onDraft?.({ agency })} onFind={actions?.onFindAgency} />}
              <Field label={t('field.locale')} hint={t('field.localeHint')} htmlFor={`${id}-locale`}>
                <Select id={`${id}-locale`} value={draft.locale} onChange={(event) => actions?.onDraft?.({ locale: event.target.value })}>
                  {[...new Set([draft.locale, ...LOCALE_CHOICES])].map((code) => (
                    <option key={code} value={code}>
                      {languageText(t, code)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('field.startDate')} required htmlFor={`${id}-start`} error={error('startDate')}>
                <DateField id={`${id}-start`} value={draft.startDate} onChange={(next) => actions?.onDraft?.({ startDate: next })} />
              </Field>
              <Field label={t('field.endDate')} required={draft.kind === 'AGENCY'} htmlFor={`${id}-end`} error={error('endDate')}>
                <DateField id={`${id}-end`} value={draft.endDate} clearable clearLabel={t('field.clearDate')} onChange={(next) => actions?.onDraft?.({ endDate: next })} />
              </Field>
              <button type="submit" hidden aria-hidden tabIndex={-1} />
            </form>
          ) : (
            <KeyValue
              columns={3}
              items={[
                { label: t('field.firstName'), value: employee.firstName },
                { label: t('field.lastName'), value: employee.lastName },
                { label: t('field.displayName'), value: employee.displayName },
                { label: t('field.employeeCode'), value: employee.employeeCode ?? t('record.noCode') },
                { label: t('field.kind'), value: t(`kind.${employee.kind}`), hint: employee.agency ? employee.agency.name : undefined },
                { label: t('field.companySite'), value: `${employee.companyCode} · ${employee.site.code} ${employee.site.name}` },
                { label: t('field.locale'), value: languageText(t, employee.locale) },
                { label: t('field.startDate'), value: dayText(employee.startDate, place) },
                { label: t('field.endDate'), value: dayText(employee.endDate, place) },
              ]}
            />
          )}
          {editing && <EditBar model={model} actions={actions} t={t} />}
        </Card>

        <Card padded header={t('notKept.title')} headingLevel={2}>
          <div className="fw-pp-card-body">
            <Banner tone="info" title={t('notKept.lead')}>
              {value.notKept.map((code) => t(`notKept.${code}`)).join(' · ')}
            </Banner>
            <p className="fw-pp-hint">
              {t('notKept.keepers')} <LawRef law={t('notKept.law')} plain={t('notKept.lawPlain')} labels={ds.lawRef} />
            </p>
            <p className="fw-pp-hint">
              {t('notKept.retention')}{' '}
              <Link className="fw-pp-link" href={`${model.prefix}/admin/privacy`}>
                {t('notKept.retentionLink')}
              </Link>
            </p>
          </div>
        </Card>

        <FloorSignIn model={model} value={value} actions={actions} place={place} />
      </div>
      <Side model={model} value={value} actions={actions} place={place} />
    </div>
  )
}

function FloorSignIn({ model, value, actions, place }: { model: EmployeeRecordModel; value: EmployeeRecord; actions?: EmployeeRecordActions; place: Place }) {
  const t = useWords()
  const createHeld = !model.can.manageWorkers ? t('held.noManageWorkers') : !model.can.manageEmployees ? t('held.noManageEmployees') : value.employee.status === 'LEFT' ? t('held.left') : null
  return (
    <Card padded header={t('floor.title')} headingLevel={2} description={t('floor.why')}>
      <div className="fw-pp-card-body">
        {value.floorSignIns.length === 0 ? (
          <EmptyState
            title={t('floor.none')}
            description={t('floor.noneBody')}
            action={
              <Button size="sm" heldReason={createHeld} onClick={() => actions?.onCreateSignIn?.()}>
                {t('floor.create')}
              </Button>
            }
          />
        ) : (
          value.floorSignIns.map((signIn) => (
            <div key={signIn.workerId} className="fw-pp-stack tight">
              <KeyValue
                columns={3}
                items={[
                  { label: t('floor.site'), value: `${signIn.site.code} · ${signIn.displayName}`, hint: signIn.status === 'INACTIVE' ? t('floor.inactive') : undefined },
                  { label: t('floor.badge'), value: signIn.badge.state === 'ACTIVE' ? t('floor.badgeSince', { day: signIn.badge.since ? formatDate(signIn.badge.since, place) : '—' }) : t('floor.badgeNone'), hint: signIn.badge.hint ? t('floor.badgeHint', { hint: signIn.badge.hint }) : undefined },
                  { label: t('floor.pin'), value: signIn.pin === 'LOCKED' && signIn.lockedUntil ? t('floor.pinLockedUntil', { time: formatDateTime(signIn.lockedUntil, place) }) : t(`pin.${signIn.pin}`) },
                  {
                    label: t('floor.notice'),
                    value:
                      signIn.notice.state === 'MISSING' ? (
                        <Link className="fw-pp-link" href={`${model.prefix}/admin/privacy`}>
                          {t('noticeState.MISSING')}
                        </Link>
                      ) : signIn.notice.state === 'ACKNOWLEDGED' ? (
                        t('floor.noticeAck', { label: signIn.notice.label ?? '' })
                      ) : (
                        t('noticeState.NONE_IN_FORCE')
                      ),
                  },
                  { label: t('floor.roles'), value: signIn.floorRoles.length > 0 ? signIn.floorRoles.map((role) => role.name).join(', ') : '—' },
                  { label: t('floor.office'), value: value.officeAccount ? t('floor.officeLinked') : t('floor.officeNone') },
                ]}
              />
              <span className="fw-pp-actions">
                <Button size="sm" onClick={() => actions?.onBadge?.()}>
                  <IdCard size={13} aria-hidden /> {t('list.printBadge')}
                </Button>
                {model.can.users ? (
                  <Button size="sm" asChild>
                    <Link href={`${model.prefix}/admin/users/floor/${encodeURIComponent(signIn.workerId)}`}>
                      {t('floor.manage')} <ExternalLink size={12} aria-hidden />
                    </Link>
                  </Button>
                ) : (
                  <Button size="sm" heldReason={t('held.noUsers')}>
                    {t('floor.manage')}
                  </Button>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </Card>
  )
}

/** The side panel (design "Side panel": status and the next step at a glance; each line links to the tab that fixes it). */
function Side({ model, value, actions, place }: { model: EmployeeRecordModel; value: EmployeeRecord; actions?: EmployeeRecordActions; place: Place }) {
  const t = useWords()
  const employee = value.employee
  const base = `${model.prefix}/people/employees/${encodeURIComponent(employee.id)}`
  const fixAt: Record<NextStep, string> = { NOTICE_NOT_ACKNOWLEDGED: `${model.prefix}/admin/privacy`, AGENCY_ENDING: base, LEAVING: base, NO_EMPLOYEE_CODE: base, STARTING: base }
  return (
    <div className="fw-pp-stack">
      <Card padded header={t('side.title')} headingLevel={2}>
        <div className="fw-pp-card-body">
          <span className="fw-pp-chips">
            <LifecyclePill lifecycle={employee.lifecycle} />
          </span>
          {value.nextSteps.length === 0 ? (
            <p className="fw-pp-hint">{t('side.nothing')}</p>
          ) : (
            <ul className="fw-pp-plain">
              {value.nextSteps.map((step) => (
                <li key={step.code}>
                  <Link className="fw-pp-link" href={fixAt[step.code]}>
                    {t(`next.${step.code}`, { count: step.days ?? 0 })}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <KeyValue
            columns={1}
            dense
            items={[
              { label: t('col.team'), value: employee.team ? `${employee.team.code} · ${employee.team.name}` : t('team.none') },
              { label: t('col.lead'), value: employee.isLead ? t('team.isLead') : (employee.lead?.name ?? '—') },
              { label: t('col.homeLine'), value: employee.homeLine ? `${employee.homeLine.code} · ${employee.homeLine.name}` : t('line.none') },
            ]}
          />
          {employee.kind === 'AGENCY' && employee.endDate && (
            <p className="fw-pp-text">
              {t('side.contractEnds', { day: dayText(employee.endDate, place) })} <Countdown to={zonedInstant(employee.endDate, '23:59', model.timeZone)} label={(left) => t('side.in', { left })} doneLabel={t('side.ended')} />
            </p>
          )}
          {value.lastChange && (
            <p className="fw-pp-hint">
              {t('side.lastChange', { by: value.lastChange.by ?? t('side.system') })} <AsOf at={value.lastChange.at} kind="event" />
            </p>
          )}
        </div>
      </Card>
      {value.leaving?.status === 'OPEN' && (
        <LeaverCard
          leaver={{ ...value.leaving, employee: { id: employee.id, name: employee.name, displayName: employee.displayName, employeeCode: employee.employeeCode, kind: employee.kind, site: employee.site, companyId: employee.companyId }, openSteps: value.leaving.steps.filter((step) => step.status === 'OPEN').length }}
          prefix={model.prefix}
          today={value.today}
          timeZone={model.timeZone}
          can={model.can}
          record={{ userId: value.officeAccount?.userId ?? null, workerIds: value.floorSignIns.map((signIn) => signIn.workerId) }}
          actions={{ onStepDone: (_, step) => actions?.onStepDone?.(step), onStepSkip: (_, step) => actions?.onStepSkip?.(step), onCancelLeaving: () => actions?.onCancelLeaving?.() }}
        />
      )}
    </div>
  )
}

// ---- Job & team -----------------------------------------------------------------------------------------------------------------

function Job({ model, value, actions, manage, place }: { model: EmployeeRecordModel; value: EmployeeRecord; actions?: EmployeeRecordActions; manage: boolean; place: Place }) {
  const t = useWords()
  const id = useId()
  const employee = value.employee
  const editing = model.edit?.section === 'job' ? model.edit : null
  const draft = editing?.draft
  const lines = model.lines.filter((line) => line.siteId === employee.site.id)
  const editHeldWords = !manage ? t('held.noManageEmployees') : employee.status === 'LEFT' ? t('held.left') : model.edit ? t('held.editing') : null
  const error = (field: string) => (editing?.field === field ? say(t, editing.problem) : null)
  const hours = hoursText(employee.weeklyMinutes, place.locale)
  const loanHeld = !model.can.manageLoans ? t('held.noManageLoans') : employee.status === 'LEFT' ? t('held.left') : null
  return (
    <div className="fw-pp-two">
      <Card
        padded
        header={t('job.title')}
        headingLevel={2}
        description={t('job.why')}
        headerAction={
          !editing ? (
            <Button size="sm" heldReason={editHeldWords} onClick={() => actions?.onEdit?.('job')}>
              <Pencil size={13} aria-hidden /> {t('edit.edit')}
            </Button>
          ) : undefined
        }
      >
        {draft ? (
          <form
            className="fw-pp-form"
            onSubmit={(event) => {
              event.preventDefault()
              actions?.onApply?.()
            }}
          >
            <Field label={t('field.department')} htmlFor={`${id}-dept`} error={error('department')}>
              <Input id={`${id}-dept`} value={draft.department} maxLength={80} onChange={(event) => actions?.onDraft?.({ department: event.target.value })} />
            </Field>
            <Field label={t('field.jobRole')} hint={t('job.roleHint')} htmlFor={`${id}-role`} error={error('jobRole')}>
              <Input id={`${id}-role`} value={draft.jobRole} maxLength={80} onChange={(event) => actions?.onDraft?.({ jobRole: event.target.value })} />
            </Field>
            <Field label={t('col.homeLine')} htmlFor={`${id}-line`} error={error('homeLineId')} hint={lines.length === 0 ? t('job.noLines') : undefined}>
              <Select id={`${id}-line`} value={draft.homeLineId ?? ''} onChange={(event) => actions?.onDraft?.({ homeLineId: event.target.value || null })}>
                <option value="">{t('line.none')}</option>
                {lines.map((line) => (
                  <option key={line.id} value={line.id}>
                    {`${line.code} · ${line.name}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('col.contract')} htmlFor={`${id}-contract`}>
              <Select id={`${id}-contract`} value={draft.contract ?? ''} onChange={(event) => actions?.onDraft?.({ contract: (event.target.value || null) as EditDraft['contract'] })}>
                <option value="">{t('contract.none')}</option>
                <option value="FULL_TIME">{t('contract.FULL_TIME')}</option>
                <option value="PART_TIME">{t('contract.PART_TIME')}</option>
              </Select>
            </Field>
            <Field label={t('field.hours')} hint={t('field.hoursHint')} htmlFor={`${id}-hours`} error={error('weeklyMinutes')}>
              <Input id={`${id}-hours`} inputMode="decimal" value={draft.hours} maxLength={5} onChange={(event) => actions?.onDraft?.({ hours: event.target.value })} />
            </Field>
            <button type="submit" hidden aria-hidden tabIndex={-1} />
          </form>
        ) : (
          <KeyValue
            columns={2}
            items={[
              { label: t('field.department'), value: employee.department ?? '—' },
              { label: t('field.jobRole'), value: employee.jobRole ?? '—', hint: t('job.roleSheetLater') },
              { label: t('col.homeLine'), value: employee.homeLine ? `${employee.homeLine.code} · ${employee.homeLine.name}` : t('line.none') },
              { label: t('col.team'), value: employee.team ? `${employee.team.code} · ${employee.team.name}` : t('team.none'), hint: employee.team ? t('job.teamSince', { day: dayText(employee.team.since, place) }) : undefined },
              { label: t('col.lead'), value: employee.isLead ? t('team.isLead') : (employee.lead?.name ?? '—') },
              { label: t('col.contract'), value: employee.contract ? t(`contract.${employee.contract}`) : t('contract.none'), hint: hours ? t('contract.hours', { hours }) : undefined },
              { label: t('job.defaultShift'), value: employee.defaultShift ? `${employee.defaultShift.code} · ${employee.defaultShift.name}` : t('job.noShift') },
              ...(employee.kind === 'AGENCY' ? [{ label: t('field.agency'), value: employee.agency?.name ?? '—', hint: t('job.contractEnd', { day: dayText(employee.endDate, place) }) }] : []),
            ]}
          />
        )}
        {editing && <EditBar model={model} actions={actions} t={t} />}
        {!editing && (
          <span className="fw-pp-actions">
            <Button size="sm" heldReason={!model.can.manageTeams ? t('held.noManageTeams') : employee.status === 'LEFT' ? t('held.left') : null} onClick={() => actions?.onTeamChange?.()}>
              <ArrowRightLeft size={13} aria-hidden /> {t('record.changeTeam')}
            </Button>
          </span>
        )}
      </Card>

      <Card
        padded
        header={t('loans.title')}
        headingLevel={2}
        description={t('loans.why')}
        headerAction={
          <Button size="sm" heldReason={loanHeld} onClick={() => actions?.onLoan?.()}>
            {t('list.loan')}
          </Button>
        }
      >
        {value.loans.length === 0 ? (
          <p className="fw-pp-hint">{t('loans.none')}</p>
        ) : (
          <SummaryTable
            label={t('loans.title')}
            columns={[t('loans.when'), t('loans.fromTo'), t('loans.reason'), t('loans.by'), t('loans.state')]}
            stackOnPhone
            rows={value.loans.map((loan) => ({
              id: loan.id,
              cells: [
                `${formatDateTime(loan.startsAt, place)} – ${formatDateTime(loan.endsAt, place)}`,
                <Link key="line" className="fw-pp-link" href={`${model.prefix}/people/employees?view=teams&line=${encodeURIComponent(loan.toLine.id)}`}>
                  {`${loan.fromLine?.code ?? t('line.none')} → ${loan.toLine.code}${loan.toTeam ? ` (${loan.toTeam.code})` : ''}`}
                </Link>,
                loan.reason,
                loan.decidedBy ?? '—',
                <span key="state" className="fw-pp-row">
                  <Pill tone={loan.state === 'RUNNING' ? 'warning' : loan.state === 'PLANNED' ? 'info' : 'neutral'}>{t(`loanState.${loan.state}`)}</Pill>
                  {loan.state === 'RUNNING' && model.can.manageLoans && (
                    <Button size="sm" variant="quiet" onClick={() => actions?.onEndLoan?.(loan.id)}>
                      {t('loans.endNow')}
                    </Button>
                  )}
                  {loan.state === 'PLANNED' && model.can.manageLoans && (
                    <Button size="sm" variant="quiet" onClick={() => actions?.onRemoveLoan?.(loan.id)}>
                      {t('loans.remove')}
                    </Button>
                  )}
                </span>,
              ],
            }))}
          />
        )}
      </Card>
    </div>
  )
}

// ---- Documents ------------------------------------------------------------------------------------------------------------------

function Documents({ model, value, place }: { model: EmployeeRecordModel; value: EmployeeRecord; place: Place }) {
  const t = useWords()
  const acknowledged = value.floorSignIns.filter((signIn) => signIn.notice.state === 'ACKNOWLEDGED')
  const leaving = value.leaving
  return (
    <Card padded header={t('documents.title')} headingLevel={2} description={t('documents.why')} headerAction={<Button size="sm" heldReason={t('documents.uploadHeld')}><Upload size={13} aria-hidden /> {t('documents.upload')}</Button>}>
      <div className="fw-pp-card-body">
        {acknowledged.length === 0 && !leaving ? (
          <p className="fw-pp-hint">{t('documents.none')}</p>
        ) : (
          <SummaryTable
            label={t('documents.title')}
            columns={[t('documents.what'), t('documents.where'), t('documents.when')]}
            stackOnPhone
            rows={[
              ...acknowledged.map((signIn) => ({
                id: `notice-${signIn.workerId}`,
                cells: [
                  t('documents.notice', { label: signIn.notice.label ?? '' }),
                  <Link key="where" className="fw-pp-link" href={`${model.prefix}/admin/privacy`}>
                    {t('documents.privacy')}
                  </Link>,
                  signIn.site.code,
                ],
              })),
              ...(leaving
                ? [
                    {
                      id: `leaving-${leaving.id}`,
                      cells: [t('documents.leaving'), t(`caseStatus.${leaving.status}`), formatDateTime(leaving.startedAt, place)],
                    },
                  ]
                : []),
            ]}
          />
        )}
        <p className="fw-pp-hint">{t('documents.noPayslips')}</p>
        <p className="fw-pp-hint">{t('documents.later')}</p>
      </div>
    </Card>
  )
}

// ---- Activity -------------------------------------------------------------------------------------------------------------------

/** A recorded value in our words: a type, a language, a contract, a day, hours, a purpose; any other text as it was typed. */
function valueWords(t: Translate, field: string, value: string | null, place: Place): string {
  if (value === null || value === '') return '—'
  if (field === 'kind' && (EMPLOYEE_KINDS as readonly string[]).includes(value)) return t(`kind.${value}`)
  if (field === 'locale') return languageText(t, value)
  if (field === 'contract' && (value === 'FULL_TIME' || value === 'PART_TIME')) return t(`contract.${value}`)
  if (field === 'weeklyMinutes' && /^\d+$/.test(value)) return t('contract.hours', { hours: hoursText(Number(value), place.locale) ?? value })
  if ((field === 'startDate' || field === 'endDate' || field === 'lastWorkingDay') && /^\d{4}-\d{2}-\d{2}$/.test(value)) return dayText(value, place)
  if (field === 'purpose' && (value === 'ATTENDANCE' || value === 'PERFORMANCE')) return t(`purpose.${value}`)
  return value
}

function Activity({ model, value, place }: { model: EmployeeRecordModel; value: EmployeeRecord; place: Place }) {
  const t = useWords()
  const [filter, setFilter] = useState<'all' | 'changes' | 'views'>('all')
  if (!model.can.audit) {
    return (
      <Card padded header={t('activity.title')} headingLevel={2}>
        <div className="fw-pp-card-body">
          <Banner tone="info" title={t('activity.held')} />
          {value.lastChange && <p className="fw-pp-hint">{t('side.lastChange', { by: value.lastChange.by ?? t('side.system') })} {formatDateTime(value.lastChange.at, place)}</p>}
        </div>
      </Card>
    )
  }
  const audit = model.audit
  const entries = (audit?.items ?? []).filter((entry) => (filter === 'views' ? entry.action === 'people.openPersonFigures' : filter === 'changes' ? entry.action !== 'people.openPersonFigures' : true))
  return (
    <Card
      padded
      header={t('activity.title')}
      headingLevel={2}
      description={t('activity.intro')}
      headerAction={
        <SegmentedControl
          size="sm"
          ariaLabel={t('activity.filter')}
          value={filter}
          onChange={(next) => setFilter(next as typeof filter)}
          options={[
            { value: 'all', label: t('activity.all') },
            { value: 'changes', label: t('activity.changes') },
            { value: 'views', label: t('activity.views') },
          ]}
        />
      }
    >
      {audit?.problem ? (
        <EmptyState title={t('activity.failed')} description={t(audit.problem)} />
      ) : !audit?.items ? (
        <p className="fw-pp-hint" role="status">
          {t('record.loading')}
        </p>
      ) : entries.length === 0 ? (
        <p className="fw-pp-hint">{filter === 'views' ? t('activity.noViews') : t('activity.none')}</p>
      ) : (
        <Timeline
          label={t('activity.title')}
         
          steps={entries.map((entry) => {
            const changes = activityChanges(entry.before, entry.after)
            return {
              key: entry.id,
              label: `${t(activityAction(entry.action))} · ${entry.actorName ?? (entry.audience === 'SYSTEM' ? t('side.system') : t('activity.someone'))}`,
              tone: entry.action === 'people.openPersonFigures' ? 'warning' : 'neutral',
              at: entry.at,
              detail: (
                <span className="fw-pp-stack tight">
                  {changes.map((change) => (
                    <span key={change.field} className="fw-pp-sub">
                      {`${t(`field.${change.field}`)}: ${valueWords(t, change.field, change.before, place)} → ${valueWords(t, change.field, change.after, place)}`}
                    </span>
                  ))}
                  {entry.reason && <span className="fw-pp-sub">{t('activity.reason', { reason: entry.reason })}</span>}
                </span>
              ),
            }
          })}
        />
      )}
      <p className="fw-pp-hint">{t('activity.comments')}</p>
    </Card>
  )
}
