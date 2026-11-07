'use client'

import { useMemo, useRef } from 'react'
import { FilePlus2, FileText, GraduationCap } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { DueCellValue, PersonTraining } from '../../../training/api'
import { LAWS } from '../../../training/constants'
import { courseName, entryState, hoursText, TRAINING_NAMESPACES } from '../../../training/model'
import { Law, SectionFailed, SectionHead, SectionLoading, TrainingDue, useDay, useLanguage, useTrainingWords } from '../../../training/view/parts'
import { TrainingDialogs, type TrainingDialogsModel } from '../../../training/view/TrainingDialogs'
import type { TrainingDialogActions } from '../../../training/use-training'

/** One row of the person's Safety training: a record that stands, or a course the role asks with nothing on record ("Needed"). */
export interface TrainingRow {
  id: string
  courseId: string
  course: string
  recordId: string | null
  completedOn: string | null
  hours: string | null
  trainer: string | null
  result: 'PASSED' | 'FAILED' | 'VOID' | null
  certificates: number
  languageChecked: boolean | null
  cell: DueCellValue | null
}

/** The rows: standing records newest first, then the Needed rows (design "Needed but missing courses … as 'Needed' rows"). */
export function trainingRowsOf(value: PersonTraining, locale: string): TrainingRow[] {
  const names = new Map(value.courses.map((course) => [course.id, courseName(course, locale)]))
  const cells = new Map(value.cells.map((cell) => [cell.courseId, cell]))
  const records = value.records
    .filter((record) => record.standing)
    .map((record): TrainingRow => ({ id: record.id, courseId: record.course.id, course: courseName(record.course, locale), recordId: record.id, completedOn: record.completedOn, hours: record.hours, trainer: record.trainerName, result: record.result, certificates: record.certificates.length, languageChecked: record.languageChecked, cell: cells.get(record.course.id)?.record?.id === record.id ? (cells.get(record.course.id) ?? null) : null }))
  const needed = value.cells
    .filter((cell) => cell.state === 'NEEDED' && !records.some((row) => row.courseId === cell.courseId && row.result === 'PASSED'))
    .map((cell): TrainingRow => ({ id: `needed:${cell.courseId}`, courseId: cell.courseId, course: names.get(cell.courseId) ?? '—', recordId: null, completedOn: null, hours: null, trainer: null, result: null, certificates: 0, languageChecked: null, cell }))
  return [...records.sort((a, b) => (b.completedOn ?? '').localeCompare(a.completedOn ?? '')), ...needed]
}

export interface EmployeeTrainingModel {
  /** safety.view: none → the sections say who sees them. */
  allowed: boolean
  loaded: { status: 'loading' } | { status: 'ready'; value: PersonTraining } | { status: 'error'; problem: string }
  prefix: string
  notice: { tone: 'success' | 'warning' | 'danger'; key: string; params?: Record<string, string | number> } | null
  dialogs: TrainingDialogsModel
}

export interface EmployeeTrainingActions {
  onRetry?: () => void
  onRecord?: (courseId: string | null) => void
  onInstruction?: () => void
  onDismissNotice?: () => void
  dialog?: TrainingDialogActions
}

/**
 * Employee › Skills & training, the W2b-2 sections (B-W2b-146; design people.employees rec:Employee/skills "Safety training"
 * and "Hands-on instruction"): the person's courses done and due (D.Lgs. 81/2008 art. 37) with the DueCell, the provider's
 * certificate, the language check (art. 37 c.13) and the Needed rows; a row opens its Certificate (PDF) in a new tab; then
 * the instruction at the workstation with how it was signed. Record training and Add entry open the Skills page's pop-ups.
 */
export function EmployeeTrainingView({ model, actions }: { model: EmployeeTrainingModel; actions?: EmployeeTrainingActions }) {
  return (
    <WithMessages namespaces={TRAINING_NAMESPACES}>
      <Sections model={model} actions={actions} />
    </WithMessages>
  )
}

function Sections({ model, actions }: { model: EmployeeTrainingModel; actions?: EmployeeTrainingActions | undefined }) {
  const t = useTrainingWords()
  const locale = useLocale()
  const day = useDay()
  const language = useLanguage()
  const value = model.loaded.status === 'ready' ? model.loaded.value : null
  const rows = useMemo(() => (value ? trainingRowsOf(value, locale) : null), [value, locale])
  const left = value?.employee.status === 'LEFT'
  const record = useRef(actions?.onRecord)
  record.current = actions?.onRecord

  const columns = useMemo<ColDef<TrainingRow>[]>(() => {
    const today = value?.today ?? ''
    const DueRenderer = ({ data }: ICellRendererParams<TrainingRow>) => (data?.cell ? <TrainingDue cell={data.cell} today={today} /> : data?.result === 'FAILED' ? <Tag tone="danger">{t('result.FAILED')}</Tag> : null)
    const CertificateRenderer = ({ data }: ICellRendererParams<TrainingRow>) =>
      data?.recordId ? (
        <a href={`${model.prefix}/people/skills/certificate?record=${encodeURIComponent(data.recordId)}&person=${encodeURIComponent(value?.employee.id ?? '')}`} target="_blank" rel="noopener noreferrer" className="fw-tr-cell">
          <FileText size={13} aria-hidden /> <span>{data.certificates > 0 ? t('employee.certificates', { count: data.certificates }) : t('employee.register')}</span>
        </a>
      ) : null
    return [
      {
        colId: 'course',
        headerName: t('employee.col.course'),
        minWidth: 200,
        flex: 1.4,
        valueGetter: (params) => params.data?.course ?? '',
        // A Needed row's course opens Record training for it (Enter on the row does too).
        cellRenderer: ({ data }: ICellRendererParams<TrainingRow>) =>
          data ? (
            data.recordId ? (
              data.course
            ) : (
              <button type="button" className="fw-tr-link" onClick={() => record.current?.(data.courseId)}>
                {data.course}
              </button>
            )
          ) : null,
      },
      { colId: 'date', headerName: t('employee.col.date'), minWidth: 120, flex: 0.6, valueGetter: (params) => (params.data?.completedOn ? day(params.data.completedOn) : '—') },
      { colId: 'hours', headerName: t('employee.col.hours'), minWidth: 80, flex: 0.4, type: 'numericColumn', valueGetter: (params) => (params.data?.hours ? hoursText(params.data.hours, locale) : '') },
      { colId: 'trainer', headerName: t('employee.col.trainer'), minWidth: 160, flex: 0.9, valueGetter: (params) => params.data?.trainer ?? '' },
      { colId: 'result', headerName: t('employee.col.result'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data?.result ? t(`result.${params.data.result}`) : t('employee.needed')) },
      { colId: 'certificate', headerName: t('employee.col.certificate'), minWidth: 170, flex: 0.8, valueGetter: (params) => (params.data?.recordId ? String(params.data.certificates) : ''), cellRenderer: CertificateRenderer },
      { colId: 'expiry', headerName: t('employee.col.expiry'), minWidth: 190, flex: 1, valueGetter: (params) => (params.data?.cell ? t(`due.${params.data.cell.state}`) : ''), cellRenderer: DueRenderer },
      { colId: 'language', headerName: t('employee.col.language'), minWidth: 130, flex: 0.6, valueGetter: (params) => (params.data?.languageChecked === null || params.data?.languageChecked === undefined ? '' : t(params.data.languageChecked ? 'common.yes' : 'employee.notChecked')) },
    ]
  }, [t, locale, day, value, model.prefix, record])

  if (!model.allowed) {
    return (
      <Card padded>
        <EmptyState icon={<GraduationCap size={22} aria-hidden />} title={t('employee.restrictedTitle')} description={t('employee.restricted')} />
      </Card>
    )
  }

  const recordHeld = !value ? t('common.loading') : left ? t('held.left') : !value.canRecord ? t('held.record') : null
  const instructHeld = !value ? t('common.loading') : left ? t('held.left') : !value.canInstruct ? t('held.instruct') : null
  return (
    <div className="fw-tr-stack">
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.close')}
            </Button>
          }
        />
      )}
      <SectionHead id="fw-tr-person-training" title={t('employee.trainingTitle')} note={<Law law={value?.law.training ?? LAWS.training} plain="law.training" />}>
        {value && (value.counts.overdue > 0 || value.counts.dueSoon > 0) && (
          <span className="fw-tr-row">
            {value.counts.overdue > 0 && <Pill tone="danger">{t('employee.overdue', { count: value.counts.overdue })}</Pill>}
            {value.counts.dueSoon > 0 && <Pill tone="warning">{t('employee.dueSoon', { count: value.counts.dueSoon })}</Pill>}
          </span>
        )}
        <Button size="sm" variant="primary" heldReason={recordHeld} onClick={() => actions?.onRecord?.(null)}>
          <GraduationCap size={13} aria-hidden /> {t('band.record')}
        </Button>
      </SectionHead>
      {model.loaded.status === 'error' ? (
        <SectionFailed title={t('employee.failed')} problem={model.loaded.problem} onRetry={actions?.onRetry} />
      ) : !rows ? (
        <SectionLoading rows={4} />
      ) : (
        <ListFrame<TrainingRow>
          label={t('employee.trainingLabel')}
          title={t('employee.trainingTitle')}
          listKey={null}
          rows={rows}
          rowId={(row) => row.id}
          columns={columns}
          rowKind="text"
          count={t('employee.count', { count: rows.length })}
          onOpen={(row) => (row.recordId ? window.open(`${model.prefix}/people/skills/certificate?record=${encodeURIComponent(row.recordId)}&person=${encodeURIComponent(value?.employee.id ?? '')}`, '_blank', 'noopener') : actions?.onRecord?.(row.courseId))}
          keys={[{ keys: ['Enter'], does: t('keys.openRecord') }]}
          state={rows.length === 0 ? <EmptyState icon={<GraduationCap size={22} aria-hidden />} title={t('employee.none')} /> : undefined}
          cards={{ fields: { course: { role: 'title' }, date: { role: 'subtitle' }, expiry: { role: 'field', label: t('employee.col.expiry'), draw: (row: TrainingRow) => (row.cell ? t(`due.${row.cell.state}`) : '—') }, result: { role: 'field', label: t('employee.col.result') } } }}
        />
      )}

      <SectionHead id="fw-tr-person-instruction" title={t('employee.instructionTitle')} note={<Law law={LAWS.instruction} plain="law.instruction" />}>
        <Button size="sm" heldReason={instructHeld} onClick={() => actions?.onInstruction?.()}>
          <FilePlus2 size={13} aria-hidden /> {t('entries.add')}
        </Button>
      </SectionHead>
      {value && value.instruction.length === 0 && <p className="fw-tr-muted">{t('entries.empty')}</p>}
      {value && value.instruction.length > 0 && (
        <SummaryTable
          label={t('employee.instructionLabel')}
          columns={[t('entries.col.date'), t('entries.col.task'), t('entries.col.instructor'), t('entries.col.minutes'), t('entries.col.signed')]}
          widths={['16%', '36%', '20%', '10%', '18%']}
          align={[undefined, undefined, undefined, 'right', 'left']}
          stackOnPhone
          rows={value.instruction.map((entry) => ({
            id: entry.id,
            cells: [
              day(entry.instructedOn),
              [entry.task, entry.machineClass ? (locale === 'it' ? entry.machineClass.label.it : entry.machineClass.label.en) : null].filter(Boolean).join(' · '),
              entry.instructor.name,
              String(entry.minutes),
              <span key="s" className="fw-tr-stack">
                <Tag tone={entryState(entry) === 'waiting' ? 'warning' : entryState(entry) === 'voided' ? 'neutral' : 'success'}>{t(`entry.state.${entryState(entry)}`)}</Tag>
                <span className="fw-tr-muted">{language(entry.language)}</span>
              </span>,
            ],
          }))}
        />
      )}
      <TrainingDialogs model={model.dialogs} actions={actions?.dialog} />
    </div>
  )
}
