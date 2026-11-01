'use client'

import { useId, type ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, Printer } from 'lucide-react'
import { Banner, DateField, DateTimeField, Field, Modal } from '@nexus/ui/components'
import { LabelPreview } from '@nexus/ui/components/LabelPreview/index'
import { ReviewChangesModal } from '@nexus/ui/patterns'
import { Button, Checkbox, Input, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useDsLabels } from '../../../../lib/i18n/ds-labels'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { EMPLOYEE_KINDS, type Ref, type SiteLine, type Team } from '../../_shared/api'
import type { PeopleCan } from '../../_shared/model'
import { languageText, say, useWords, type Translate } from '../../_shared/parts'
import { badgeLayout, badgeSheetHref, type BadgeWords } from '../badges/badge'
import { BadgeQr } from '../badges/view/BadgeQr'
import type { DialogActions, EmployeesDialog, NewDraft, Person } from '../view-model'

/**
 * Every pop-up of People › Employees and of an employee's record (design people.employees pop:new-employee, pop:loan,
 * pop:leaver, pop:badges, pop:team-change, and the Teams view's Add team; a leaver step skipped or a leaving cancelled
 * with its reason; floor workers linked to new records). Each one held with its reason while it may not run; Esc closes
 * and the focus returns to the opener (DS Modal). It fetches nothing: the container sends and answers.
 */

export interface DialogsModel {
  dialog: EmployeesDialog | null
  can: PeopleCan
  prefix: string
  origin: string
  companyName: string
  sites: Ref[]
  lines: SiteLine[]
  teams: Team[]
  today: string
  timeZone: string
}

export function EmployeeDialogs({ model, actions }: { model: DialogsModel; actions?: DialogActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'new':
      return <NewEmployeeDialog model={model} dialog={dialog} actions={actions} />
    case 'loan':
      return <LoanDialog model={model} dialog={dialog} actions={actions} />
    case 'leaver':
      return <LeaverDialog model={model} dialog={dialog} actions={actions} />
    case 'badges':
      return <BadgesDialog model={model} people={dialog.people} actions={actions} />
    case 'teamChange':
      return <TeamChangeDialog model={model} dialog={dialog} actions={actions} />
    case 'addTeam':
      return <AddTeamDialog model={model} dialog={dialog} actions={actions} />
    case 'skip':
    case 'cancelLeaving':
      return <ReasonDialog dialog={dialog} actions={actions} />
    case 'link':
      return <LinkDialog dialog={dialog} actions={actions} />
  }
}

function Footer({ t, held, busy, label, actions }: { t: Translate; held: string | null; busy: boolean; label: string; actions?: DialogActions }) {
  return (
    <>
      <span className="fw-pp-grow" />
      <Button size="sm" onClick={() => actions?.onClose?.()}>
        {t('common.cancel')}
      </Button>
      <Button size="sm" variant="primary" heldReason={held} onClick={() => !held && actions?.onSubmit?.()}>
        {busy ? <Spinner size={12} /> : null} {label}
      </Button>
    </>
  )
}

/** Enter in the last field submits (design "Enter in the last field creates"). */
function Form({ children, onSubmit, held }: { children: ReactNode; onSubmit?: () => void; held: string | null }) {
  return (
    <form
      className="fw-pp-dialog"
      onSubmit={(event) => {
        event.preventDefault()
        if (!held) onSubmit?.()
      }}
    >
      {children}
      <button type="submit" hidden aria-hidden tabIndex={-1} />
    </form>
  )
}

// ---- New employee --------------------------------------------------------------------------------------------------------------

/** Why Create is held, or null (a message key). */
export function newDraftHeld(draft: NewDraft): string | null {
  if (!draft.firstName.trim() || !draft.lastName.trim()) return 'held.names'
  if (!draft.siteId) return 'held.site'
  if (!draft.startDate) return 'held.start'
  if (draft.kind === 'AGENCY' && !draft.agency) return 'held.agency'
  if (draft.kind === 'AGENCY' && !draft.endDate) return 'held.agencyEnd'
  if (draft.endDate && draft.startDate && draft.endDate < draft.startDate) return 'held.endBeforeStart'
  if (draft.employeeCode.trim() && !/^[A-Za-z0-9._\-/]+$/.test(draft.employeeCode.trim())) return 'problem.field.employeeCode'
  return null
}

function NewEmployeeDialog({ model, dialog, actions }: { model: DialogsModel; dialog: Extract<EmployeesDialog, { kind: 'new' }>; actions?: DialogActions }) {
  const t = useWords()
  const locale = useLocale()
  const ds = useDsLabels(model.timeZone)
  const id = useId()
  const draft = dialog.draft
  const patch = (next: Partial<NewDraft>) => actions?.onNewDraft?.(next)
  const heldKey = !model.can.manageEmployees ? 'held.noManageEmployees' : newDraftHeld(draft)
  const held = heldKey ? t(heldKey) : dialog.busy ? t('held.busy') : null
  const error = (field: string) => (dialog.field === field ? say(t, dialog.problem) : null)
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('new.title')}
      size="lg"
      labels={ds.modal}
      footer={<Footer t={t} held={held} busy={dialog.busy} label={t('new.create')} actions={actions} />}
    >
      <Form held={held} onSubmit={actions?.onSubmit}>
        {dialog.problem && !dialog.field && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        <div className="fw-pp-form">
          <Field label={t('field.firstName')} required htmlFor={`${id}-first`} error={error('firstName')}>
            <Input id={`${id}-first`} autoFocus value={draft.firstName} maxLength={80} onChange={(event) => patch({ firstName: event.target.value })} />
          </Field>
          <Field label={t('field.lastName')} required htmlFor={`${id}-last`} error={error('lastName')}>
            <Input id={`${id}-last`} value={draft.lastName} maxLength={80} onChange={(event) => patch({ lastName: event.target.value })} />
          </Field>
          <Field label={t('field.employeeCode')} hint={t('field.employeeCodeHint')} htmlFor={`${id}-code`} error={error('employeeCode')}>
            <Input id={`${id}-code`} value={draft.employeeCode} maxLength={24} onChange={(event) => patch({ employeeCode: event.target.value })} />
          </Field>
          <Field label={t('field.kind')} required htmlFor={`${id}-kind`}>
            <Select id={`${id}-kind`} value={draft.kind} onChange={(event) => patch({ kind: event.target.value as NewDraft['kind'], ...(event.target.value === 'AGENCY' ? {} : { agency: null }) })}>
              {EMPLOYEE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          {draft.kind === 'AGENCY' && <AgencyField t={t} id={`${id}-agency`} agency={draft.agency} agencies={dialog.agencies} can={model.can} error={error('agencyPartyId')} onPick={(agency) => patch({ agency })} onFind={actions?.onFindAgency} />}
          <Field label={t('field.company')} htmlFor={`${id}-company`}>
            <Input id={`${id}-company`} value={model.companyName} readOnly />
          </Field>
          <Field label={t('field.site')} required htmlFor={`${id}-site`}>
            <Select id={`${id}-site`} value={draft.siteId ?? ''} onChange={(event) => patch({ siteId: event.target.value || null })}>
              <option value="">{t('field.chooseSite')}</option>
              {model.sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {`${site.code} · ${site.name}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('field.jobRole')} hint={t('field.jobRoleHint')} htmlFor={`${id}-role`} error={error('jobRole')}>
            <Input id={`${id}-role`} value={draft.jobRole} maxLength={80} onChange={(event) => patch({ jobRole: event.target.value })} />
          </Field>
          <Field label={t('field.startDate')} required htmlFor={`${id}-start`} error={error('startDate')}>
            <DateField id={`${id}-start`} value={draft.startDate} locale={INTL_LOCALE[locale]} onChange={(value) => patch({ startDate: value })} labels={ds.dateField} />
          </Field>
          <Field label={t('field.endDate')} required={draft.kind === 'AGENCY'} hint={t(draft.kind === 'AGENCY' ? 'field.endAgencyHint' : 'field.endHint')} htmlFor={`${id}-end`} error={error('endDate')}>
            <DateField id={`${id}-end`} value={draft.endDate} locale={INTL_LOCALE[locale]} clearable clearLabel={t('field.clearDate')} onChange={(value) => patch({ endDate: value })} labels={ds.dateField} />
          </Field>
          <Field label={t('field.locale')} hint={t('field.localeHint')} htmlFor={`${id}-locale`} error={error('locale')}>
            <Select id={`${id}-locale`} value={draft.locale} onChange={(event) => patch({ locale: event.target.value })}>
              {LOCALE_CHOICES.map((code) => (
                <option key={code} value={code}>
                  {languageText(t, code)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="wide fw-pp-stack tight">
            <Checkbox checked={draft.floorSignIn} disabled={!model.can.manageWorkers} label={t('new.floorSignIn')} onChange={(event) => patch({ floorSignIn: event.target.checked })} />
            <p className="fw-pp-hint">{model.can.manageWorkers ? t('new.floorSignInHint') : t('held.noManageWorkers')}</p>
          </div>
        </div>
      </Form>
    </Modal>
  )
}

/** The floor and documents languages offered (ISO 639; the record keeps any two- or three-letter code). */
export const LOCALE_CHOICES = ['it', 'en', 'ro', 'sq', 'ar', 'zh', 'ur', 'bn', 'es', 'fr', 'uk'] as const

export function AgencyField({ t, id, agency, agencies, can, error, onPick, onFind }: { t: Translate; id: string; agency: Ref | null; agencies: Ref[] | null; can: PeopleCan; error: string | null; onPick: (agency: Ref | null) => void; onFind?: (text: string) => void }) {
  if (!can.parties) {
    return (
      <Field label={t('field.agency')} required htmlFor={id} hint={t('held.noParties')} error={error}>
        <Input id={id} value={agency ? `${agency.code} · ${agency.name}` : ''} readOnly disabled />
      </Field>
    )
  }
  return (
    <Field label={t('field.agency')} required htmlFor={id} hint={agency ? `${agency.code} · ${agency.name}` : t('field.agencyHint')} error={error}>
      <span className="fw-pp-stack tight">
        <Input id={id} type="search" placeholder={t('field.agencySearch')} onChange={(event) => onFind?.(event.target.value)} />
        {agencies && agencies.length > 0 && (
          <Select aria-label={t('field.agencyPick')} value={agency?.id ?? ''} onChange={(event) => onPick(agencies.find((entry) => entry.id === event.target.value) ?? null)}>
            <option value="">{t('field.agencyPick')}</option>
            {agencies.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {`${entry.code} · ${entry.name}`}
              </option>
            ))}
          </Select>
        )}
        {agencies && agencies.length === 0 && <span className="fw-pp-hint">{t('field.agencyNone')}</span>}
      </span>
    </Field>
  )
}

// ---- Loan to another line ------------------------------------------------------------------------------------------------------

export function loanHeld(dialog: Extract<EmployeesDialog, { kind: 'loan' }>, can: PeopleCan): string | null {
  if (!can.manageLoans) return 'held.noManageLoans'
  if (!dialog.toLineId) return 'held.loanLine'
  if (!dialog.startsAt || !dialog.endsAt) return 'held.loanTimes'
  if (dialog.endsAt <= dialog.startsAt) return 'held.loanEndBeforeStart'
  if (!dialog.reason.trim()) return 'held.reason'
  return null
}

function LoanDialog({ model, dialog, actions }: { model: DialogsModel; dialog: Extract<EmployeesDialog, { kind: 'loan' }>; actions?: DialogActions }) {
  const t = useWords()
  const locale = useLocale()
  const ds = useDsLabels(model.timeZone)
  const id = useId()
  const place = { locale, timeZone: model.timeZone }
  const lines = model.lines.filter((line) => line.siteId === dialog.person.siteId && line.id !== dialog.person.homeLine?.id)
  const line = lines.find((entry) => entry.id === dialog.toLineId) ?? null
  const teams = model.teams.filter((team) => team.status === 'ACTIVE' && team.line?.id === dialog.toLineId)
  const heldKey = loanHeld(dialog, model.can)
  const held = heldKey ? t(heldKey) : dialog.busy ? t('held.busy') : null
  const sameDay = dialog.endsAt && dialog.startsAt && formatDate(dialog.endsAt, place) === formatDate(dialog.startsAt, place)
  const label = dialog.endsAt ? (sameDay ? t('loan.submitUntil', { time: formatTime(dialog.endsAt, place) }) : t('loan.submitUntilDay', { day: formatDate(dialog.endsAt, place) })) : t('loan.submit')
  const error = (field: string) => (dialog.field === field ? say(t, dialog.problem) : null)
  return (
    <Modal open onClose={() => actions?.onClose?.()} title={t('loan.title', { name: dialog.person.name })} size="md" labels={ds.modal} footer={<Footer t={t} held={held} busy={dialog.busy} label={label} actions={actions} />}>
      <Form held={held} onSubmit={actions?.onSubmit}>
        {dialog.problem && !dialog.field && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        <p className="fw-pp-hint">{t('loan.from', { line: dialog.person.homeLine ? `${dialog.person.homeLine.code} · ${dialog.person.homeLine.name}` : t('loan.noHomeLine') })}</p>
        <div className="fw-pp-form">
          <Field label={t('loan.toLine')} required htmlFor={`${id}-line`} error={error('toLineId')} hint={lines.length === 0 ? t('loan.noLines') : undefined}>
            <Select id={`${id}-line`} autoFocus value={dialog.toLineId ?? ''} onChange={(event) => actions?.onLoan?.({ toLineId: event.target.value || null, toTeamId: null })}>
              <option value="">{t('loan.chooseLine')}</option>
              {lines.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`${entry.code} · ${entry.name}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('loan.toTeam')} htmlFor={`${id}-team`} hint={t('loan.toTeamHint')}>
            <Select id={`${id}-team`} value={dialog.toTeamId ?? ''} disabled={!line} onChange={(event) => actions?.onLoan?.({ toTeamId: event.target.value || null })}>
              <option value="">{t('loan.lineOnly')}</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {`${team.code} · ${team.name}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('loan.startsAt')} required htmlFor={`${id}-from`} error={error('startsAt')}>
            <DateTimeField id={`${id}-from`} value={dialog.startsAt} stepMinutes={15} locale={INTL_LOCALE[locale]} onChange={(value) => actions?.onLoan?.({ startsAt: value })} labels={ds.dateTimeField} />
          </Field>
          <Field label={t('loan.endsAt')} required htmlFor={`${id}-to`} error={error('endsAt')} hint={t('loan.endsAtHint')}>
            <DateTimeField id={`${id}-to`} value={dialog.endsAt} stepMinutes={15} locale={INTL_LOCALE[locale]} onChange={(value) => actions?.onLoan?.({ endsAt: value })} labels={ds.dateTimeField} />
          </Field>
          <Field label={t('field.reason')} required htmlFor={`${id}-reason`} error={error('reason')} className="wide">
            <Input id={`${id}-reason`} value={dialog.reason} maxLength={500} placeholder={t('loan.reasonExample')} onChange={(event) => actions?.onLoan?.({ reason: event.target.value })} />
          </Field>
        </div>
        <SkillCheck t={t} dialog={dialog} line={line} can={model.can} />
      </Form>
    </Modal>
  )
}

/** "Can do 3 of 5 operations on Line B": what is signed off in People › Skills (a person decides; never computed from work). */
function SkillCheck({ t, dialog, line, can }: { t: Translate; dialog: Extract<EmployeesDialog, { kind: 'loan' }>; line: SiteLine | null; can: PeopleCan }) {
  if (!line) return null
  if (!can.skills) return <p className="fw-pp-hint">{t('loan.skillHeld')}</p>
  if (dialog.check === 'loading') return <p className="fw-pp-hint" role="status"><Spinner size={12} /> {t('loan.skillReading')}</p>
  if (dialog.check === 'none' || dialog.check === null) return <p className="fw-pp-hint">{t('loan.skillUnread')}</p>
  const check = dialog.check
  if (check.kept === 0) return <Banner tone="info" title={t('loan.skillNothing', { line: line.code })} />
  const tail = [check.asTrainee > 0 ? t('loan.skillTrainee', { count: check.asTrainee }) : null, check.notKept > 0 ? t('loan.skillNotKept', { count: check.notKept }) : null].filter(Boolean).join(' · ')
  return <Banner tone={check.canDo < check.kept ? 'warning' : 'success'} title={t('loan.skillCanDo', { canDo: check.canDo, total: check.kept, line: line.code })}>{tail || null}</Banner>
}

// ---- Start leaver steps --------------------------------------------------------------------------------------------------------

function LeaverDialog({ model, dialog, actions }: { model: DialogsModel; dialog: Extract<EmployeesDialog, { kind: 'leaver' }>; actions?: DialogActions }) {
  const t = useWords()
  const locale = useLocale()
  const ds = useDsLabels(model.timeZone)
  const id = useId()
  const preview = dialog.preview
  const refusal = preview?.refusal ? t(`refusal.${preview.refusal.code}`) : null
  const heldKey = !model.can.manageLeavers ? 'held.noManageLeavers' : !dialog.lastWorkingDay ? 'held.lastDay' : dialog.reading || !preview ? 'held.reading' : null
  const held = heldKey ? t(heldKey) : refusal ?? (dialog.busy ? t('held.busy') : null)
  const c = preview?.consequences
  const consequences = c
    ? [
        c.floorSignIns > 0 ? t('leaver.badgeOff', { count: c.activeBadges }) : null,
        c.floorSignIns > 0 ? t('leaver.sessionsEnded') : null,
        c.officeAccount ? t('leaver.accessEnded') : null,
        c.openTasks + c.openMaintenanceJobs > 0 ? t('leaver.handOver', { tasks: c.openTasks, jobs: c.openMaintenanceJobs }) : t('leaver.nothingOpen'),
        c.shiftsAfter > 0 ? t('leaver.shiftsCleared', { count: c.shiftsAfter }) : null,
        c.loansAfter > 0 ? t('leaver.loansEnded', { count: c.loansAfter }) : null,
        t('leaver.payrollFlagged'),
        dialog.exitVisit ? t('leaver.exitVisit') : null,
      ].filter((line): line is string => line !== null)
    : []
  return (
    <Modal open onClose={() => actions?.onClose?.()} title={t('leaver.title', { name: dialog.person.name })} size="md" labels={ds.modal} footer={<Footer t={t} held={held} busy={dialog.busy} label={t('leaver.submit')} actions={actions} />}>
      <Form held={held} onSubmit={actions?.onSubmit}>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        <Field label={t('leaver.lastDay')} required htmlFor={`${id}-day`} hint={t('leaver.lastDayHint')}>
          <DateField id={`${id}-day`} value={dialog.lastWorkingDay} locale={INTL_LOCALE[locale]} onChange={(value) => actions?.onLeaver?.({ lastWorkingDay: value })} labels={ds.dateField} />
        </Field>
        <div className="fw-pp-stack tight">
          <Checkbox checked={dialog.exitVisit} label={t('leaver.exitVisitAsk')} onChange={(event) => actions?.onLeaver?.({ exitVisit: event.target.checked })} />
          <p className="fw-pp-hint">{t('leaver.exitVisitHint')}</p>
        </div>
        {refusal && <Banner tone="danger" title={refusal} />}
        {dialog.reading && (
          <p className="fw-pp-hint" role="status">
            <Spinner size={12} /> {t('leaver.reading')}
          </p>
        )}
        {consequences.length > 0 && !refusal && (
          <section className="fw-pp-stack tight" aria-label={t('leaver.consequences')}>
            <h3 className="fw-pp-h3">{t('leaver.consequences')}</h3>
            <ul className="fw-pp-list">
              {consequences.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="fw-pp-hint">{t('leaver.reversal', { day: dialog.lastWorkingDay ? formatDate(`${dialog.lastWorkingDay}T12:00:00Z`, { locale, timeZone: model.timeZone }) : '—' })}</p>
          </section>
        )}
      </Form>
    </Modal>
  )
}

// ---- Print badges --------------------------------------------------------------------------------------------------------------

export function badgeWords(t: Translate, companyName: string): BadgeWords {
  return { name: t('badge.name'), company: companyName, code: t('badge.code'), site: t('badge.site'), team: t('badge.team'), none: t('badge.none') }
}

function BadgesDialog({ model, people, actions }: { model: DialogsModel; people: Person[]; actions?: DialogActions }) {
  const t = useWords()
  const ds = useDsLabels(model.timeZone)
  const words = badgeWords(t, model.companyName)
  const href = badgeSheetHref(model.prefix, people.map((person) => person.id))
  const shown = people.slice(0, 12)
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('badges.title', { count: people.length })}
      size="lg"
      labels={ds.modal}
      footer={
        <>
          <span className="fw-pp-grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {t('common.close')}
          </Button>
          <Button size="sm" variant="primary" asChild>
            <Link href={href} target="_blank">
              <Printer size={13} aria-hidden /> {t('badges.print', { count: people.length })} <ExternalLink size={12} aria-hidden />
            </Link>
          </Button>
        </>
      }
    >
      <div className="fw-pp-dialog">
        <p className="fw-pp-hint">{t('badges.intro')}</p>
        <Banner tone="info" title={t('badges.printerHeld')}>
          {t('badges.signInCode')}
        </Banner>
        <div className="fw-pp-badges">
          {shown.map((person) => {
            const url = `${model.origin}${model.prefix}/people/employees/${encodeURIComponent(person.id)}`
            return (
              <LabelPreview
                key={person.id}
                layout={badgeLayout({ id: person.id, displayName: person.displayName, name: person.name, employeeCode: person.employeeCode, siteCode: person.siteCode, team: person.team?.code ?? null }, words, url)}
                scale={3}
                renderQr={(value) => <BadgeQr value={value} label={t('badge.qr', { name: person.displayName })} />}
                codeLabel={() => t('badge.qr', { name: person.displayName })}
              />
            )
          })}
        </div>
        {people.length > shown.length && <p className="fw-pp-hint">{t('badges.more', { count: people.length - shown.length })}</p>}
      </div>
    </Modal>
  )
}

// ---- Change team (ReviewChangesModal) ------------------------------------------------------------------------------------------

function TeamChangeDialog({ model, dialog, actions }: { model: DialogsModel; dialog: Extract<EmployeesDialog, { kind: 'teamChange' }>; actions?: DialogActions }) {
  const t = useWords()
  const ds = useDsLabels(model.timeZone)
  const id = useId()
  const sites = new Set(dialog.people.map((person) => person.siteId))
  const teams = model.teams.filter((team) => team.status === 'ACTIVE' && sites.has(team.site.id))
  const teamName = (ref: { code: string; name: string } | null | undefined) => (ref ? `${ref.code} · ${ref.name}` : t('team.none'))
  if (!dialog.reviewing) {
    const held = !model.can.manageTeams ? t('held.noManageTeams') : null
    return (
      <Modal open onClose={() => actions?.onClose?.()} title={t('teamChange.title', { count: dialog.people.length })} size="md" labels={ds.modal} footer={<Footer t={t} held={held} busy={false} label={t('teamChange.review')} actions={{ ...actions, onSubmit: actions?.onReview }} />}>
        <Form held={held} onSubmit={actions?.onReview}>
          <Field label={t('teamChange.to')} required htmlFor={`${id}-team`} hint={sites.size > 1 ? t('teamChange.manySites') : undefined}>
            <Select id={`${id}-team`} autoFocus value={dialog.teamId ?? ''} onChange={(event) => actions?.onTeam?.(event.target.value || null)}>
              <option value="">{t('teamChange.noTeam')}</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {`${team.code} · ${team.name}${team.line ? ` (${team.line.code})` : ''}`}
                </option>
              ))}
            </Select>
          </Field>
          <ul className="fw-pp-list">
            {dialog.people.slice(0, 8).map((person) => (
              <li key={person.id}>{`${person.name} — ${teamName(person.team)}`}</li>
            ))}
          </ul>
          {dialog.people.length > 8 && <p className="fw-pp-hint">{t('teamChange.more', { count: dialog.people.length - 8 })}</p>}
        </Form>
      </Modal>
    )
  }
  const rows = dialog.rows ?? []
  const changing = rows.filter((row) => row.change === 'MOVE' && !row.conflict)
  const conflicts = rows.filter((row) => row.conflict)
  const changes = rows.map((row) => ({
    id: row.employeeId,
    where: row.name ?? '—',
    what: t('teamChange.what'),
    now: row.from ? `${teamName(row.from.team)}${row.from.lead ? ` · ${t('teamChange.lead', { name: row.from.lead })}` : ''}` : t('team.none'),
    next: row.conflict ? t(`conflict.${row.conflict}`) : row.to ? `${teamName(row.to.team)}${row.to.lead ? ` · ${t('teamChange.lead', { name: row.to.lead })}` : ''}` : t('team.none'),
    note: row.conflict ? t('teamChange.refused') : row.change === 'NONE' ? t('teamChange.already') : row.leavesLead ? t('teamChange.leavesLead') : undefined,
  }))
  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.onClose?.()}
      changes={changes}
      state={dialog.state.phase === 'done' ? { phase: 'done', results: Object.fromEntries(Object.entries(dialog.state.results).map(([key, result]) => [key, { ...result, words: t(`teamChange.result.${result.words}`) }])) } : dialog.state.phase === 'failed' ? { phase: 'failed', error: t(dialog.state.error) } : dialog.state}
      title={t('teamChange.reviewTitle', { count: dialog.people.length })}
      summary={t('teamChange.summary')}
      metrics={[
        { label: t('teamChange.metricMoving'), value: String(changing.length) },
        { label: t('teamChange.metricAlready'), value: String(rows.filter((row) => row.change === 'NONE' && !row.conflict).length) },
        { label: t('teamChange.metricRefused'), value: String(conflicts.length) },
      ]}
      problems={conflicts.length > 0 ? [t('teamChange.conflictsHold', { count: conflicts.length })] : changing.length === 0 ? [t('teamChange.nothing')] : []}
      saveLabel={t('teamChange.apply', { count: changing.length })}
      onSave={() => actions?.onSubmit?.()}
      onRetry={() => actions?.onReview?.()}
      onDone={() => actions?.onClose?.()}
      doneVerb={ds.reviewDoneVerb}
      labels={ds.review}
    />
  )
}

// ---- Add a team ----------------------------------------------------------------------------------------------------------------

function AddTeamDialog({ model, dialog, actions }: { model: DialogsModel; dialog: Extract<EmployeesDialog, { kind: 'addTeam' }>; actions?: DialogActions }) {
  const t = useWords()
  const ds = useDsLabels(model.timeZone)
  const id = useId()
  const lines = model.lines.filter((line) => line.siteId === dialog.siteId)
  const heldKey = !model.can.manageTeams ? 'held.noManageTeams' : !dialog.siteId ? 'held.site' : !dialog.code.trim() || !dialog.name.trim() ? 'held.teamNames' : null
  const held = heldKey ? t(heldKey) : dialog.busy ? t('held.busy') : null
  const error = (field: string) => (dialog.field === field ? say(t, dialog.problem) : null)
  return (
    <Modal open onClose={() => actions?.onClose?.()} title={t('addTeam.title')} size="md" labels={ds.modal} footer={<Footer t={t} held={held} busy={dialog.busy} label={t('addTeam.submit')} actions={actions} />}>
      <Form held={held} onSubmit={actions?.onSubmit}>
        {dialog.problem && !dialog.field && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        <div className="fw-pp-form">
          <Field label={t('field.site')} required htmlFor={`${id}-site`}>
            <Select id={`${id}-site`} value={dialog.siteId ?? ''} onChange={(event) => actions?.onAddTeam?.({ siteId: event.target.value || null, lineId: null })}>
              <option value="">{t('field.chooseSite')}</option>
              {model.sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {`${site.code} · ${site.name}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('addTeam.line')} htmlFor={`${id}-line`} hint={t('addTeam.lineHint')}>
            <Select id={`${id}-line`} value={dialog.lineId ?? ''} onChange={(event) => actions?.onAddTeam?.({ lineId: event.target.value || null })}>
              <option value="">{t('addTeam.noLine')}</option>
              {lines.map((line) => (
                <option key={line.id} value={line.id}>
                  {`${line.code} · ${line.name}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('addTeam.code')} required htmlFor={`${id}-code`} error={error('code')} hint={t('addTeam.codeHint')}>
            <Input id={`${id}-code`} autoFocus value={dialog.code} maxLength={16} onChange={(event) => actions?.onAddTeam?.({ code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('addTeam.name')} required htmlFor={`${id}-name`} error={error('name')}>
            <Input id={`${id}-name`} value={dialog.name} maxLength={80} onChange={(event) => actions?.onAddTeam?.({ name: event.target.value })} />
          </Field>
        </div>
      </Form>
    </Modal>
  )
}

// ---- a step skipped, a leaving cancelled: the reason ---------------------------------------------------------------------------

function ReasonDialog({ dialog, actions }: { dialog: Extract<EmployeesDialog, { kind: 'skip' | 'cancelLeaving' }>; actions?: DialogActions }) {
  const t = useWords()
  const ds = useDsLabels()
  const id = useId()
  const held = !dialog.reason.trim() ? t('held.reason') : dialog.busy ? t('held.busy') : null
  const skip = dialog.kind === 'skip'
  const title = skip ? t('skip.title', { step: t(`step.${dialog.step.kind}`) }) : t('cancelLeaving.title', { name: dialog.leaver.employee.name })
  return (
    <Modal open onClose={() => actions?.onClose?.()} title={title} size="sm" labels={ds.modal} footer={<Footer t={t} held={held} busy={dialog.busy} label={skip ? t('skip.submit') : t('cancelLeaving.submit')} actions={actions} />}>
      <Form held={held} onSubmit={actions?.onSubmit}>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        <p className="fw-pp-hint">{skip ? t('skip.body') : t('cancelLeaving.body')}</p>
        <Field label={t('field.reason')} required htmlFor={`${id}-reason`}>
          <Textarea id={`${id}-reason`} autoFocus rows={3} value={dialog.reason} maxLength={500} onChange={(event) => actions?.onReason?.(event.target.value)} labels={ds.textarea} />
        </Field>
      </Form>
    </Modal>
  )
}

// ---- floor workers with no employee record: make their records -----------------------------------------------------------------

function LinkDialog({ dialog, actions }: { dialog: Extract<EmployeesDialog, { kind: 'link' }>; actions?: DialogActions }) {
  const t = useWords()
  const ds = useDsLabels()
  const held = dialog.workers.length === 0 ? t('held.noneToLink') : dialog.busy ? t('held.busy') : null
  return (
    <Modal open onClose={() => actions?.onClose?.()} title={t('link.title', { count: dialog.workers.length })} size="md" labels={ds.modal} footer={<Footer t={t} held={held} busy={dialog.busy} label={t('link.submit', { count: dialog.workers.length })} actions={actions} />}>
      <div className="fw-pp-dialog">
        <p className="fw-pp-hint">{t('link.body')}</p>
        <ul className="fw-pp-list">
          {dialog.workers.slice(0, 10).map((worker) => (
            <li key={worker.id}>{`${worker.displayName} · ${worker.site.code}${worker.employeeCode ? ` · ${worker.employeeCode}` : ''}`}</li>
          ))}
        </ul>
        {dialog.workers.length > 10 && <p className="fw-pp-hint">{t('teamChange.more', { count: dialog.workers.length - 10 })}</p>}
        {dialog.refused.length > 0 && (
          <Banner tone="danger" title={t('link.refused', { count: dialog.refused.length })}>
            <ul className="fw-pp-list">
              {dialog.refused.map((entry) => (
                <li key={entry.name}>{`${entry.name}: ${say(t, entry.words)}`}</li>
              ))}
            </ul>
          </Banner>
        )}
      </div>
    </Modal>
  )
}
