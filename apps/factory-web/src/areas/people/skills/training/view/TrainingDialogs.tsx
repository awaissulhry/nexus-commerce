'use client'

import { type ReactNode } from 'react'
import Link from 'next/link'
import { Plus, Trash2 } from 'lucide-react'
import { Banner, Field, FileRow, KeyValue, MultiSelect, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, FileDropzone, Modal, ReviewChangesPanel } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import { LANGUAGES } from '../../../_shared/parts'
import type { Course, CoursePreview, ImpactLine, PersonNeed } from '../api'
import { COURSE_TYPES, LAWS, LIMITS } from '../constants'
import {
  archiveHeld,
  classLinesHeld,
  closable,
  closeHeld,
  courseHeld,
  courseName,
  expiryOf,
  hoursText,
  impactWords,
  instructionHeld,
  languageWarning,
  recordHeld,
  recordPerson,
  standardHeld,
  type ClassLine,
  type CourseDraft,
  type InstructionDraft,
  type RecordDraft,
  type RecordPerson,
  type StandardRow,
  type TrainingCan,
} from '../model'
import type { PersonOption, TrainingDialog, TrainingDialogActions } from '../use-training'
import { Law, ProblemBanner, useDay, useLanguage, useTrainingWords } from './parts'

export interface TrainingDialogsModel {
  dialog: TrainingDialog | null
  can: TrainingCan
  /** The catalogue's ACTIVE courses (Record training, a machine type's lines); null while they are read. */
  courses: readonly Course[] | null
  people: readonly PersonOption[]
  /** The machine types an instruction entry may name (who needs what's list). */
  machineClasses: readonly { id: string; code: string; label: Record<string, string> }[]
  today: string
  canAddGroupWide: boolean
  /** The address of Plant › Risk assessment when it is built (a role's courses are edited in its role sheet). */
  riskHref: string | null
  prefix: string
}

/** Every pop-up of the training part: one view; the state and commands are `use-training.ts`. */
export function TrainingDialogs({ model, actions }: { model: TrainingDialogsModel; actions?: TrainingDialogActions | undefined }) {
  const dialog = model.dialog
  if (!dialog) return null
  if (dialog.kind === 'course') return <CourseDialog model={model} dialog={dialog} actions={actions} />
  if (dialog.kind === 'standard') return <StandardDialog model={model} dialog={dialog} actions={actions} />
  if (dialog.kind === 'need') return <NeedDialog model={model} dialog={dialog} actions={actions} />
  if (dialog.kind === 'classCourses') return <ClassCoursesDialog model={model} dialog={dialog} actions={actions} />
  if (dialog.kind === 'record') return <RecordDialog model={model} dialog={dialog} actions={actions} />
  if (dialog.kind === 'instruction') return <InstructionDialog model={model} dialog={dialog} actions={actions} />
  return <EntryDialog dialog={dialog} actions={actions} />
}

type Of<K extends TrainingDialog['kind']> = Extract<TrainingDialog, { kind: K }>

function Cancel({ onClose }: { onClose?: (() => void) | undefined }) {
  const t = useTrainingWords()
  return (
    <Button variant="quiet" onClick={onClose}>
      {t('common.cancel')}
    </Button>
  )
}

const typeOptions = (t: (key: string) => string) =>
  COURSE_TYPES.map((type) => (
    <option key={type} value={type}>
      {t(`type.${type}`)}
    </option>
  ))

// ---- Course (catalogue row; "14 due dates move") -----------------------------------------------------------------------------

function CourseFields({ draft, isNew, canGroup, onDraft }: { draft: CourseDraft; isNew: boolean; canGroup: boolean; onDraft: (change: Partial<CourseDraft>) => void }) {
  const t = useTrainingWords()
  return (
    <div className="fw-tr-form">
      {isNew && (
        <div className="fw-tr-grid2">
          <Field label={t('course.code')} required hint={t('course.codeHint')}>
            <Input value={draft.code} maxLength={LIMITS.code} onChange={(event) => onDraft({ code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('course.type')} required>
            <Select value={draft.type} onChange={(event) => onDraft({ type: event.target.value as CourseDraft['type'] })}>
              {typeOptions(t)}
            </Select>
          </Field>
        </div>
      )}
      <div className="fw-tr-grid2">
        <Field label={t('course.nameIt')} required>
          <Input value={draft.nameIt} maxLength={LIMITS.name} onChange={(event) => onDraft({ nameIt: event.target.value })} />
        </Field>
        <Field label={t('course.nameEn')}>
          <Input value={draft.nameEn} maxLength={LIMITS.name} onChange={(event) => onDraft({ nameEn: event.target.value })} />
        </Field>
      </div>
      <div className="fw-tr-grid3">
        <Field label={t('course.hours')} required hint={t('course.hoursHint')}>
          <Input inputMode="decimal" value={draft.hours} onChange={(event) => onDraft({ hours: event.target.value })} />
        </Field>
        <Field label={t('course.refresherMonths')} hint={t('course.refresherHint')}>
          <Input inputMode="numeric" value={draft.refresherMonths} onChange={(event) => onDraft({ refresherMonths: event.target.value })} />
        </Field>
        <Field label={t('course.refresherHours')}>
          <Input inputMode="decimal" value={draft.refresherHours} onChange={(event) => onDraft({ refresherHours: event.target.value })} />
        </Field>
      </div>
      <div className="fw-tr-grid2">
        <Field label={t('course.provider')}>
          <Input value={draft.provider} maxLength={LIMITS.provider} onChange={(event) => onDraft({ provider: event.target.value })} />
        </Field>
        <Field label={t('course.law')} hint={isNew ? t('course.lawHint') : undefined}>
          <Input value={draft.legalBasis} maxLength={LIMITS.legalBasis} onChange={(event) => onDraft({ legalBasis: event.target.value })} />
        </Field>
      </div>
      <Checkbox checked={draft.inPersonRequired} onChange={(event) => onDraft({ inPersonRequired: event.target.checked })} label={t('course.inPerson')} />
      {isNew && canGroup && <Checkbox checked={draft.groupWide} onChange={(event) => onDraft({ groupWide: event.target.checked })} label={t('course.groupWide')} />}
      <p className="fw-tr-muted">{t('course.noLaw')}</p>
    </div>
  )
}

/** A field's value in words for the review ("12,5 h", "every 24 months", "Yes"). */
function useFieldWords(): (field: string, value: unknown) => string {
  const t = useTrainingWords()
  const locale = useLocale()
  return (field, value) => {
    if (value === null || value === undefined || value === '') return '—'
    if (field === 'hours' || field === 'refresherHours') return t('common.hours', { hours: hoursText(String(value), locale) })
    if (field === 'refresherMonths') return t('courses.every', { count: Number(value) })
    if (typeof value === 'boolean') return t(value ? 'common.yes' : 'common.no')
    if (typeof value === 'object') return Object.values(value as Record<string, string>).join(' · ')
    return String(value)
  }
}

function CourseReview({ preview }: { preview: CoursePreview }) {
  const t = useTrainingWords()
  const day = useDay()
  const words = useFieldWords()
  const refresher = preview.refresher
  const warnings: ReactNode[] = []
  if (refresher) {
    warnings.push(refresher.wouldMove > 0 ? t('review.wouldMove', { count: refresher.wouldMove }) : t('review.noneMove'))
    if (refresher.ownDate > 0) warnings.push(t('review.ownDate', { count: refresher.ownDate }))
  }
  return (
    <div className="fw-tr-form">
      <ReviewChangesPanel
        label={t('review.label')}
        changes={preview.changes.map((change) => ({ id: change.field, what: t(`field.${change.field}`), now: words(change.field, change.from), next: words(change.field, change.to) }))}
        warnings={warnings}
        ack={false}
        onAckChange={() => undefined}
      />
      {refresher && refresher.people.length > 0 && (
        <SummaryTable
          label={t('review.peopleLabel')}
          columns={[t('review.col.person'), t('review.col.completed'), t('review.col.until'), t('review.col.withNew')]}
          rows={refresher.people.map((person) => ({ id: person.employeeId, cells: [person.name, day(person.completedOn), day(person.validUntil), day(person.withNewPeriod)] }))}
          stackOnPhone
        />
      )}
      <p className="fw-tr-muted">{t('review.recordsKeep')}</p>
    </div>
  )
}

function CourseDialog({ model, dialog, actions }: { model: TrainingDialogsModel; dialog: Of<'course'>; actions?: TrainingDialogActions | undefined }) {
  const t = useTrainingWords()
  const locale = useLocale()
  const isNew = dialog.courseId === null
  const course = dialog.record?.course ?? null
  const manage = isNew ? model.can.manage : (course?.canManage ?? false)
  const archived = course?.status === 'ARCHIVED'
  const held = !manage ? 'held.manage' : archived ? 'held.archivedEdit' : dialog.busy ? 'held.busy' : courseHeld(dialog.draft, isNew)
  const title = isNew ? t('course.newTitle') : course ? t('course.title', { course: courseName(course, locale) }) : t('course.loadingTitle')
  const statusHeld = course ? archiveHeld(course) : 'held.manage'
  const onDraft = (change: Partial<CourseDraft>) => actions?.onPatch({ draft: { ...dialog.draft, ...change }, problem: null })
  return (
    <Modal
      open
      onClose={() => actions?.onClose()}
      title={title}
      size="lg"
      footer={
        <>
          {!isNew && course && (
            <Button variant="quiet" heldReason={dialog.busy ? t('held.busy') : statusHeld ? t(statusHeld) : null} onClick={() => actions?.onCourseStatus(archived ? 'restore' : 'archive')}>
              {t(archived ? 'course.restore' : 'course.archive')}
            </Button>
          )}
          {dialog.preview ? (
            <Button variant="quiet" onClick={() => actions?.onCourseBack()}>
              {t('common.back')}
            </Button>
          ) : (
            <Cancel onClose={actions?.onClose} />
          )}
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => (dialog.preview ? actions?.onCourseSave() : actions?.onCoursePreview())}>
            {dialog.busy ? <Spinner size={14} /> : null} {isNew ? t('course.add') : dialog.preview ? t('course.save') : t('course.review')}
          </Button>
        </>
      }
    >
      <div className="fw-tr-form">
        <ProblemBanner problem={dialog.problem} />
        {dialog.loading ? (
          <p className="fw-tr-muted" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        ) : dialog.preview ? (
          <CourseReview preview={dialog.preview} />
        ) : (
          <>
            {archived && <Banner tone="info" title={t('course.archivedNote')} />}
            <CourseFields draft={dialog.draft} isNew={isNew} canGroup={model.canAddGroupWide} onDraft={onDraft} />
            {dialog.record && (
              <KeyValue
                dense
                items={[
                  { label: t('course.askedRoles'), value: dialog.record.askedBy.roleSheets.length ? dialog.record.askedBy.roleSheets.map((role) => `${role.code} · ${role.site.code} (${role.withinDays === null ? t('needs.before') : t('needs.within', { count: role.withinDays })})`).join(', ') : t('course.nobody') },
                  { label: t('course.askedMachines'), value: dialog.record.askedBy.machineClasses.length ? dialog.record.askedBy.machineClasses.map((entry) => `${entry.label[locale] ?? entry.code} (${entry.withinDays === null ? t('needs.before') : t('needs.within', { count: entry.withinDays })})`).join(', ') : t('course.nobody') },
                  { label: t('course.people'), value: t('course.peopleCounts', { people: dialog.record.people.people, met: dialog.record.people.met, due: dialog.record.people.due, overdue: dialog.record.people.overdue }) },
                  { label: t('course.lawLabel'), value: <Law law={course?.legalBasis ?? LAWS.training} plain="law.course" /> },
                ]}
              />
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

// ---- Start from the standard list --------------------------------------------------------------------------------------------

function StandardDialog({ model, dialog, actions }: { model: TrainingDialogsModel; dialog: Of<'standard'>; actions?: TrainingDialogActions | undefined }) {
  const t = useTrainingWords()
  const locale = useLocale()
  const held = dialog.busy ? 'held.busy' : standardHeld(dialog.rows)
  const taken = dialog.rows.filter((row) => row.take && !row.taken).length
  const set = (index: number, change: Partial<StandardRow>) => actions?.onPatch({ rows: dialog.rows.map((row, at) => (at === index ? { ...row, ...change } : row)), problem: null })
  return (
    <Modal
      open
      onClose={() => actions?.onClose()}
      title={t('standard.title')}
      size="xl"
      footer={
        <>
          <Cancel onClose={actions?.onClose} />
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onStandardAdd()}>
            {dialog.busy ? <Spinner size={14} /> : null} {t('standard.add', { count: taken })}
          </Button>
        </>
      }
    >
      <div className="fw-tr-form">
        <ProblemBanner problem={dialog.problem} />
        <p className="fw-tr-muted">{t('standard.intro')}</p>
        {!dialog.list ? (
          <p className="fw-tr-muted" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        ) : (
          <SummaryTable
            label={t('standard.label')}
            columns={[t('standard.col.take'), t('standard.col.course'), t('standard.col.law'), t('standard.col.hours'), t('standard.col.refresher')]}
            widths={['12%', '34%', '24%', '15%', '15%']}
            density="roomy"
            stackOnPhone
            rows={dialog.rows.map((row, index) => ({
              id: row.code,
              cells: [
                <Checkbox key="take" checked={row.take && !row.taken} disabled={row.taken} onChange={(event) => set(index, { take: event.target.checked })} label={row.taken ? t('standard.taken') : t('standard.takeOne')} />,
                <span key="name" className="fw-tr-stack">
                  <span>{locale === 'it' ? row.nameIt : row.nameEn}</span>
                  <span className="nds-summary-sub">{t(`type.${row.type}`)}</span>
                </span>,
                <Law key="law" law={row.legalBasis} plain="law.course" />,
                <Input key="hours" size="sm" fieldClassName="fw-tr-fill" className="fw-tr-fill" inputMode="decimal" aria-label={t('standard.hoursOf', { course: locale === 'it' ? row.nameIt : row.nameEn })} value={row.hours} disabled={!row.take || row.taken} onChange={(event) => set(index, { hours: event.target.value })} />,
                <Input key="months" size="sm" fieldClassName="fw-tr-fill" className="fw-tr-fill" inputMode="numeric" aria-label={t('standard.monthsOf', { course: locale === 'it' ? row.nameIt : row.nameEn })} value={row.refresherMonths} disabled={!row.take || row.taken} onChange={(event) => set(index, { refresherMonths: event.target.value })} />,
              ],
            }))}
          />
        )}
        {model.canAddGroupWide && <Checkbox checked={dialog.groupWide} onChange={(event) => actions?.onPatch({ groupWide: event.target.checked })} label={t('course.groupWide')} />}
        <p className="fw-tr-muted">{t('course.noLaw')}</p>
      </div>
    </Modal>
  )
}

// ---- One role's or machine type's people (inside one record) -------------------------------------------------------------------

function NeedPeople({ people, courses }: { people: readonly PersonNeed[]; courses: Map<string, string> }) {
  const t = useTrainingWords()
  const day = useDay()
  if (people.length === 0) return <p className="fw-tr-muted">{t('need.nobody')}</p>
  return (
    <SummaryTable
      label={t('need.peopleLabel')}
      columns={[t('need.col.person'), t('need.col.since'), t('need.col.courses')]}
      widths={['28%', '18%', undefined]}
      align={[undefined, undefined, 'left']}
      stackOnPhone
      rows={people.map((person) => ({
        id: person.employeeId,
        cells: [
          person.name,
          day(person.since),
          <span key="c" className="fw-tr-row">
            {person.courses.map((line) => (
              <Pill key={line.courseId} tone={line.state === 'MET' ? 'success' : line.state === 'OVERDUE' ? 'danger' : 'warning'}>
                {`${courses.get(line.courseId) ?? '—'}: ${t(`need.state.${line.state}`, { date: day(line.dueOn) })}`}
              </Pill>
            ))}
          </span>,
        ],
      }))}
    />
  )
}

function NeedDialog({ model, dialog, actions }: { model: TrainingDialogsModel; dialog: Of<'need'>; actions?: TrainingDialogActions | undefined }) {
  const t = useTrainingWords()
  const locale = useLocale()
  const role = dialog.role
  const machine = dialog.machine
  const refs = role?.refs ?? machine?.refs ?? []
  const courses = new Map(refs.map((course) => [course.id, courseName(course, locale)]))
  const lines = role?.courses ?? machine?.courses ?? []
  const title = role ? t('need.roleTitle', { role: courseName(role.roleSheet, locale), site: role.roleSheet.site.code }) : machine ? t('need.classTitle', { machine: machine.machineClass.label[locale] ?? machine.machineClass.code }) : t('common.loading')
  return (
    <Modal
      open
      onClose={() => actions?.onClose()}
      title={title}
      size="lg"
      footer={
        <>
          {machine && (
            <Button heldReason={machine.canManage ? null : t('held.manageClasses')} onClick={() => actions?.onClassCourses(machine.machineClass.id)}>
              {t('need.changeCourses')}
            </Button>
          )}
          {role && model.riskHref && (
            <Button asChild>
              <Link href={model.riskHref}>{t('need.openRoleSheet')}</Link>
            </Button>
          )}
          <Button variant="primary" onClick={() => actions?.onClose()}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="fw-tr-form">
        <ProblemBanner problem={dialog.problem} />
        {!role && !machine && !dialog.problem && (
          <p className="fw-tr-muted" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        )}
        {(role || machine) && (
          <>
            <p className="fw-tr-muted">{role ? t(model.riskHref ? 'need.roleOwner' : 'need.roleOwnerLater') : t('need.classOwner')}</p>
            <SummaryTable
              label={t('need.coursesLabel')}
              columns={[t('need.col.course'), t('need.col.when'), t('need.col.counts')]}
              stackOnPhone
              rows={lines.map((line) => ({ id: line.courseId, cells: [courses.get(line.courseId) ?? '—', line.withinDays === null ? t('needs.before') : t('needs.within', { count: line.withinDays }), t('course.peopleCounts', { people: line.people, met: line.met, due: line.due, overdue: line.overdue })] }))}
            />
            <NeedPeople people={role?.people ?? machine?.people ?? []} courses={courses} />
            <Law law={LAWS.training} plain="law.needs" />
          </>
        )}
      </div>
    </Modal>
  )
}

// ---- A machine type's courses ("What this changes") ------------------------------------------------------------------------------

function impactText(t: (key: string, params?: Record<string, string | number>) => string, line: ImpactLine, courses: Map<string, string>): string {
  const words = impactWords(line)
  const course = line.courseId ? (courses.get(line.courseId) ?? '—') : '—'
  const names = line.names && line.names.length > 0 ? ` (${line.names.map((entry) => entry.name).join(', ')}${line.people > line.names.length ? t('impact.more', { count: line.people - line.names.length }) : ''})` : ''
  return `${t(words.key, { ...words.params, course })}${names}`
}

function ClassCoursesDialog({ model, dialog, actions }: { model: TrainingDialogsModel; dialog: Of<'classCourses'>; actions?: TrainingDialogActions | undefined }) {
  const t = useTrainingWords()
  const locale = useLocale()
  const needs = dialog.needs
  const offered = (model.courses ?? []).filter((course) => course.companyId === null)
  const refs = new Map([...(needs?.refs ?? []), ...(dialog.preview?.refs ?? [])].map((course) => [course.id, courseName(course, locale)]))
  for (const course of offered) refs.set(course.id, courseName(course, locale))
  const held = !needs ? 'held.busy' : !needs.canManage ? 'held.manageClasses' : dialog.busy ? 'held.busy' : classLinesHeld(dialog.lines)
  const setLine = (index: number, change: Partial<ClassLine>) => actions?.onPatch({ lines: dialog.lines.map((line, at) => (at === index ? { ...line, ...change } : line)), preview: null, problem: null })
  const title = needs ? t('classCourses.title', { machine: needs.machineClass.label[locale] ?? needs.machineClass.code }) : t('common.loading')
  return (
    <Modal
      open
      onClose={() => actions?.onClose()}
      title={title}
      size="lg"
      footer={
        <>
          {dialog.preview ? (
            <Button variant="quiet" onClick={() => actions?.onClassBack()}>
              {t('common.back')}
            </Button>
          ) : (
            <Cancel onClose={actions?.onClose} />
          )}
          <Button variant="primary" heldReason={held ? t(held) : dialog.preview?.changes.nothing ? t('held.nothing') : null} onClick={() => (dialog.preview ? actions?.onClassApply() : actions?.onClassPreview())}>
            {dialog.busy ? <Spinner size={14} /> : null} {dialog.preview ? t('classCourses.apply') : t('classCourses.review')}
          </Button>
        </>
      }
    >
      <div className="fw-tr-form">
        <ProblemBanner problem={dialog.problem} />
        {!needs ? (
          <p className="fw-tr-muted" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        ) : dialog.preview ? (
          <ReviewChangesPanel
            label={t('classCourses.reviewLabel')}
            changes={[
              ...dialog.preview.changes.added.map((id) => ({ id: `a:${id}`, what: refs.get(id) ?? '—', now: t('classCourses.notAsked'), next: t('classCourses.asked') })),
              ...dialog.preview.changes.removed.map((id) => ({ id: `r:${id}`, what: refs.get(id) ?? '—', now: t('classCourses.asked'), next: t('classCourses.notAsked') })),
              ...dialog.preview.changes.changed.map((line) => ({ id: `c:${line.courseId}`, what: refs.get(line.courseId) ?? '—', now: line.withinDays.from === null ? t('needs.before') : t('needs.within', { count: line.withinDays.from }), next: line.withinDays.to === null ? t('needs.before') : t('needs.within', { count: line.withinDays.to }) })),
            ]}
            warnings={dialog.preview.changes.nothing ? [t('classCourses.nothing')] : dialog.preview.impact.map((line) => impactText(t, line, refs))}
            ack={false}
            onAckChange={() => undefined}
          />
        ) : (
          <>
            <p className="fw-tr-muted">{t('classCourses.intro', { count: needs.people.length })}</p>
            <div className="fw-tr-lines">
              {dialog.lines.map((line, index) => (
                <div key={`${index}:${line.courseId}`} className="fw-tr-line">
                  <Field label={t('classCourses.course')}>
                    <Select value={line.courseId} onChange={(event) => setLine(index, { courseId: event.target.value })}>
                      <option value="">{t('classCourses.choose')}</option>
                      {[...refs].map(([id, name]) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('classCourses.within')} hint={t('classCourses.withinHint')}>
                    <Input inputMode="numeric" value={line.withinDays} onChange={(event) => setLine(index, { withinDays: event.target.value })} />
                  </Field>
                  <Field label={t('classCourses.note')}>
                    <Input value={line.note} maxLength={LIMITS.note} onChange={(event) => setLine(index, { note: event.target.value })} />
                  </Field>
                  <Button variant="quiet" aria-label={t('classCourses.remove', { course: refs.get(line.courseId) ?? '' })} onClick={() => actions?.onPatch({ lines: dialog.lines.filter((_, at) => at !== index), preview: null })}>
                    <Trash2 size={14} aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
            <span>
              <Button size="sm" heldReason={dialog.lines.length >= LIMITS.requirements ? t('held.linesMany') : null} onClick={() => actions?.onPatch({ lines: [...dialog.lines, { courseId: '', withinDays: '', note: '' }], preview: null })}>
                <Plus size={13} aria-hidden /> {t('classCourses.addLine')}
              </Button>
            </span>
            <p className="fw-tr-muted">{t('classCourses.groupOnly')}</p>
            <Law law={LAWS.machines} plain="law.machines" />
          </>
        )}
      </div>
    </Modal>
  )
}

// ---- Record training ----------------------------------------------------------------------------------------------------------------

function PersonLine({ person, draft, refresherMonths, onPerson }: { person: RecordPerson; draft: RecordDraft; refresherMonths: number | null; onPerson: (change: Partial<RecordPerson>) => void }) {
  const t = useTrainingWords()
  const day = useDay()
  const expected = expiryOf(draft.completedOn, refresherMonths)
  const other = person.validUntil !== '' && person.validUntil !== (expected ?? '')
  return (
    <div className="fw-tr-person">
      <strong>{person.name}</strong>
      <Select size="sm" aria-label={t('record.resultOf', { name: person.name })} value={person.result} onChange={(event) => onPerson({ result: event.target.value as RecordPerson['result'] })}>
        <option value="PASSED">{t('result.PASSED')}</option>
        <option value="FAILED">{t('result.FAILED')}</option>
      </Select>
      <Checkbox checked={person.languageChecked} onChange={(event) => onPerson({ languageChecked: event.target.checked })} label={t('record.understood')} />
      <span className="fw-tr-stack">
        {person.result === 'PASSED' ? (
          <>
            <DateField value={person.validUntil || expected || ''} min={draft.completedOn} onChange={(value) => onPerson({ validUntil: value === expected ? '' : value })} clearable={false} ariaLabel={t('record.untilOf', { name: person.name })} />
            {other ? <Input size="sm" aria-label={t('record.reasonOf', { name: person.name })} placeholder={t('record.reason')} value={person.validUntilReason} maxLength={LIMITS.reason} onChange={(event) => onPerson({ validUntilReason: event.target.value })} /> : <span className="fw-tr-muted">{expected ? t('record.fromPeriod', { date: day(expected) }) : t('record.noExpiry')}</span>}
          </>
        ) : (
          <span className="fw-tr-muted">{t('record.failedNoExpiry')}</span>
        )}
      </span>
    </div>
  )
}

function RecordDialog({ model, dialog, actions }: { model: TrainingDialogsModel; dialog: Of<'record'>; actions?: TrainingDialogActions | undefined }) {
  const t = useTrainingWords()
  const locale = useLocale()
  const day = useDay()
  const language = useLanguage()
  const draft = dialog.draft
  const course = (model.courses ?? []).find((entry) => entry.id === draft.courseId) ?? null
  const elsewhere = dialog.way === 'elsewhere'
  const held = !model.can.record ? 'held.record' : dialog.busy ? 'held.busy' : elsewhere ? recordHeld(draft, course, model.today) : closeHeld(dialog.session?.session ?? null, dialog.session?.attendances ?? [], model.today)
  const onDraft = (change: Partial<RecordDraft>) => actions?.onPatch({ draft: { ...draft, ...change }, problem: null })
  const onPerson = (index: number, change: Partial<RecordPerson>) => onDraft({ people: draft.people.map((person, at) => (at === index ? { ...person, ...change } : person)) })
  const pickPeople = (ids: string[]) =>
    onDraft({
      people: ids.flatMap((id) => {
        const kept = draft.people.find((person) => person.employeeId === id)
        if (kept) return [kept]
        const option = model.people.find((person) => person.employeeId === id)
        return option ? [recordPerson(option)] : []
      }),
    })
  const ready = dialog.session ? closable(dialog.session.attendances) : []
  const confirm = elsewhere ? t('record.confirm', { count: draft.people.length }) : t('record.closeConfirm', { count: ready.length })
  return (
    <Modal
      open
      onClose={() => actions?.onClose()}
      title={t('record.title')}
      size="xl"
      footer={
        <>
          <Cancel onClose={actions?.onClose} />
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => (elsewhere ? actions?.onRecord() : actions?.onCloseSession())}>
            {dialog.busy ? <Spinner size={14} /> : null} {confirm}
          </Button>
        </>
      }
    >
      <div className="fw-tr-form">
        <ProblemBanner problem={dialog.problem} />
        <SegmentedControl
          ariaLabel={t('record.way')}
          value={dialog.way}
          onChange={(way) => actions?.onRecordWay(way as 'elsewhere' | 'session')}
          options={[
            { value: 'elsewhere', label: t('record.elsewhere') },
            { value: 'session', label: t('record.fromFloor') },
          ]}
          size="sm"
        />
        {elsewhere ? (
          <>
            <div className="fw-tr-grid2">
              <Field label={t('record.course')} required>
                <Select
                  value={draft.courseId ?? ''}
                  onChange={(event) => {
                    const next = (model.courses ?? []).find((entry) => entry.id === event.target.value)
                    onDraft({ courseId: event.target.value || null, hours: next ? hoursText(next.hours, 'en') : draft.hours })
                  }}
                >
                  <option value="">{model.courses ? t('record.chooseCourse') : t('common.loading')}</option>
                  {(model.courses ?? []).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {`${courseName(entry, locale)} · ${entry.code}`}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('record.date')} required>
                <DateField value={draft.completedOn} max={model.today} onChange={(value) => onDraft({ completedOn: value })} />
              </Field>
            </div>
            <div className="fw-tr-grid3">
              <Field label={t('record.hours')} required>
                <Input inputMode="decimal" value={draft.hours} onChange={(event) => onDraft({ hours: event.target.value })} />
              </Field>
              <Field label={t('record.trainer')} required hint={t('record.trainerHint')}>
                <Input value={draft.trainerName} maxLength={LIMITS.trainerName} onChange={(event) => onDraft({ trainerName: event.target.value })} />
              </Field>
              <Field label={t('record.language')} required>
                <Select value={draft.language} onChange={(event) => onDraft({ language: event.target.value })}>
                  {LANGUAGES.map((code) => (
                    <option key={code} value={code}>
                      {language(code)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {course && <p className="fw-tr-muted">{course.refresherMonths === null ? t('record.courseNoRefresher') : t('record.courseRefresher', { count: course.refresherMonths, date: day(expiryOf(draft.completedOn, course.refresherMonths)) })}</p>}
            <Field label={t('record.people')} required hint={t('record.peopleHint')}>
              <MultiSelect options={model.people.map((person) => ({ value: person.employeeId, label: person.name }))} value={draft.people.map((person) => person.employeeId)} onChange={pickPeople} placeholder={t('record.pickNone')} formatLabel={(value) => t('record.picked', { count: value.length })} searchable width="auto" ariaLabel={t('record.people')} />
            </Field>
            {draft.people.length > 0 && (
              <div>
                {draft.people.map((person, index) => (
                  <PersonLine key={person.employeeId} person={person} draft={draft} refresherMonths={course?.refresherMonths ?? null} onPerson={(change) => onPerson(index, change)} />
                ))}
              </div>
            )}
            {languageWarning(draft.people) && <Banner tone="warning" title={t('record.languageWarning')} />}
            <Field label={t('record.certificate')} hint={model.can.upload ? t('record.certificateHint') : t('held.upload')}>
              {draft.certificate ? (
                <FileRow name={draft.certificate.name} size={draft.certificate.size} onRemove={() => onDraft({ certificate: null })} />
              ) : (
                <FileDropzone onFiles={(files) => onDraft({ certificate: files[0] ?? null })} accept=".pdf,.jpg,.jpeg,.png" maxBytes={25 * 1024 * 1024} disabled={!model.can.upload} />
              )}
            </Field>
            <Law law={LAWS.language} plain="law.language" />
          </>
        ) : (
          <>
            <p className="fw-tr-muted">{t('record.floorIntro')}</p>
            <Field label={t('record.session')}>
              <Select value={dialog.sessionId ?? ''} onChange={(event) => actions?.onSession(event.target.value || null)}>
                <option value="">{dialog.sessions === null ? t('common.loading') : dialog.sessions.length === 0 ? t('record.noSessions') : t('record.chooseSession')}</option>
                {(dialog.sessions ?? []).map((session) => (
                  <option key={session.id} value={session.id}>
                    {t('record.sessionLine', { course: courseName(session.course, locale), date: day(session.heldOn), site: session.site.code, signed: session.counts.signed, countersigned: session.counts.countersigned })}
                  </option>
                ))}
              </Select>
            </Field>
            {dialog.session && (
              <SummaryTable
                label={t('record.attendanceLabel')}
                columns={[t('record.col.person'), t('record.col.signed'), t('record.col.countersigned'), t('record.col.language'), t('record.col.result')]}
                stackOnPhone
                density="roomy"
                rows={dialog.session.attendances.map((entry) => ({
                  id: entry.id,
                  cells: [
                    entry.employee.name,
                    t(`sign.${entry.method}`),
                    entry.voided ? t('record.voided') : entry.countersign ? t('common.yes') : t('record.waiting'),
                    entry.languageUnderstood === null ? '—' : t(entry.languageUnderstood ? 'record.understoodYes' : 'record.understoodNo'),
                    ready.some((row) => row.id === entry.id) ? (
                      <Select key="r" size="sm" aria-label={t('record.resultOf', { name: entry.employee.name })} value={dialog.results[entry.id] ?? 'PASSED'} disabled={entry.languageUnderstood === false} onChange={(event) => actions?.onPatch({ results: { ...dialog.results, [entry.id]: event.target.value } })}>
                        <option value="PASSED">{t('result.PASSED')}</option>
                        <option value="FAILED">{t('result.FAILED')}</option>
                      </Select>
                    ) : (
                      '—'
                    ),
                  ],
                }))}
              />
            )}
            <p className="fw-tr-muted">{t('record.closeNote')}</p>
          </>
        )}
      </div>
    </Modal>
  )
}

// ---- Instruction register: Add entry -----------------------------------------------------------------------------------------------

function InstructionDialog({ model, dialog, actions }: { model: TrainingDialogsModel; dialog: Of<'instruction'>; actions?: TrainingDialogActions | undefined }) {
  const t = useTrainingWords()
  const locale = useLocale()
  const language = useLanguage()
  const draft = dialog.draft
  const held = !model.can.instruct ? 'held.instruct' : dialog.busy ? 'held.busy' : instructionHeld(draft, model.today)
  const onDraft = (change: Partial<InstructionDraft>) => actions?.onPatch({ draft: { ...draft, ...change }, problem: null })
  return (
    <Modal
      open
      onClose={() => actions?.onClose()}
      title={t('entry.title')}
      size="lg"
      footer={
        <>
          <Cancel onClose={actions?.onClose} />
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onInstruction()}>
            {dialog.busy ? <Spinner size={14} /> : null} {t('entry.add')}
          </Button>
        </>
      }
    >
      <div className="fw-tr-form">
        <ProblemBanner problem={dialog.problem} />
        <div className="fw-tr-grid2">
          <Field label={t('entry.person')} required>
            <Select value={draft.employeeId ?? ''} onChange={(event) => onDraft({ employeeId: event.target.value || null })}>
              <option value="">{t('entry.choosePerson')}</option>
              {model.people.map((person) => (
                <option key={person.employeeId} value={person.employeeId}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('entry.date')} required>
            <DateField value={draft.instructedOn} max={model.today} onChange={(value) => onDraft({ instructedOn: value })} />
          </Field>
        </div>
        <Field label={t('entry.task')} required hint={t('entry.taskHint')}>
          <Input value={draft.task} maxLength={LIMITS.task} onChange={(event) => onDraft({ task: event.target.value })} />
        </Field>
        <div className="fw-tr-grid2">
          <Field label={t('entry.machineClass')}>
            <Select value={draft.machineClassId ?? ''} onChange={(event) => onDraft({ machineClassId: event.target.value || null })}>
              <option value="">{t('entry.noMachine')}</option>
              {model.machineClasses.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label[locale] ?? entry.code}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('entry.minutes')} required>
            <Input inputMode="numeric" value={draft.minutes} onChange={(event) => onDraft({ minutes: event.target.value })} />
          </Field>
        </div>
        <div className="fw-tr-grid2">
          <Field label={t('entry.instructor')} required>
            <Select value={draft.instructorEmployeeId ?? ''} onChange={(event) => onDraft({ instructorEmployeeId: event.target.value || null })}>
              <option value="">{t('entry.someoneElse')}</option>
              {model.people
                .filter((person) => person.employeeId !== draft.employeeId)
                .map((person) => (
                  <option key={person.employeeId} value={person.employeeId}>
                    {person.name}
                  </option>
                ))}
            </Select>
          </Field>
          {!draft.instructorEmployeeId && (
            <Field label={t('entry.instructorName')} required>
              <Input value={draft.instructorName} maxLength={LIMITS.trainerName} onChange={(event) => onDraft({ instructorName: event.target.value })} />
            </Field>
          )}
        </div>
        <div className="fw-tr-grid2">
          <Field label={t('entry.language')} required>
            <Select value={draft.language} onChange={(event) => onDraft({ language: event.target.value })}>
              {LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {language(code)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('entry.signs')}>
            <SegmentedControl
              ariaLabel={t('entry.signs')}
              value={draft.signs}
              onChange={(signs) => onDraft({ signs: signs as InstructionDraft['signs'] })}
              options={[
                { value: 'floor', label: t('entry.signsFloor') },
                { value: 'paper', label: t('entry.signsPaper') },
              ]}
              size="sm"
            />
          </Field>
        </div>
        <Checkbox checked={draft.languageChecked} onChange={(event) => onDraft({ languageChecked: event.target.checked })} label={t('entry.languageChecked')} />
        <p className="fw-tr-muted">{t(draft.signs === 'floor' ? 'entry.floorNote' : 'entry.paperNote')}</p>
        <Law law={LAWS.instruction} plain="law.instruction" />
      </div>
    </Modal>
  )
}

/** One entry of the register: what it says, Signed on paper while it waits, Void with the reason. */
function EntryDialog({ dialog, actions }: { dialog: Of<'voidEntry'>; actions?: TrainingDialogActions | undefined }) {
  const t = useTrainingWords()
  const day = useDay()
  const language = useLanguage()
  const entry = dialog.entry
  const voidHeld = !entry.canChange ? 'held.instruct' : entry.voided ? 'held.voidedRow' : dialog.reason.trim().length < 3 ? 'held.reason' : dialog.busy ? 'held.busy' : null
  return (
    <Modal
      open
      onClose={() => actions?.onClose()}
      title={t('entry.recordTitle', { name: entry.employee.name })}
      size="md"
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onClose()}>
            {t('common.close')}
          </Button>
          {!entry.signed && !entry.voided && (
            <Button heldReason={entry.canChange ? null : t('held.instruct')} onClick={() => actions?.onPaper(entry)}>
              {t('entry.paper')}
            </Button>
          )}
          <Button variant="danger" heldReason={voidHeld ? t(voidHeld) : null} onClick={() => actions?.onVoid()}>
            {t('entry.void')}
          </Button>
        </>
      }
    >
      <div className="fw-tr-form">
        <ProblemBanner problem={dialog.problem} />
        <KeyValue
          dense
          items={[
            { label: t('entries.col.date'), value: day(entry.instructedOn) },
            { label: t('entries.col.task'), value: entry.task },
            { label: t('entries.col.instructor'), value: entry.instructor.name },
            { label: t('entries.col.minutes'), value: String(entry.minutes) },
            { label: t('entries.col.language'), value: `${language(entry.language)}${entry.languageChecked ? '' : ` · ${t('entries.notChecked')}`}` },
            { label: t('entries.col.signed'), value: entry.signed ? t(`sign.${entry.signed.method}`) : entry.voided ? t('entry.state.voided') : t('entry.state.waiting') },
          ]}
        />
        {!entry.voided && (
          <Field label={t('entry.voidReason')} hint={t('entry.voidHint')}>
            <Input value={dialog.reason} maxLength={LIMITS.reason} onChange={(event) => actions?.onPatch({ reason: event.target.value, problem: null })} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
