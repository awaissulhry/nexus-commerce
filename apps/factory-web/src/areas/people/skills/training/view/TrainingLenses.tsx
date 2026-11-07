'use client'

import { useMemo, useRef, useState } from 'react'
import { BookOpen, ClipboardList, FilePlus2, ListChecks, Plus, Settings2, Signature } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import type { Course, Courses, InstructionEntry, InstructionList, InstructionView, Requirements } from '../api'
import { LAWS } from '../constants'
import { archiveHeld, COURSE_LIST_STATUSES, courseName, entryState, hoursText, INSTRUCTION_VIEWS, needRowsOf, type CourseListStatus, type NeedRow, type TrainingAddress, type TrainingCan } from '../model'
import type { Section } from '../use-training'
import { Law, SectionFailed, SectionHead, SectionLoading, useDay, useLanguage, useTrainingWords } from './parts'

/**
 * The three training lenses of People › Skills & training (B-W2b-146; design people.skills sections "Course catalogue",
 * "Who needs what", "Instruction register"), each on the shared list frame. A list carries counts, never a figure about one
 * person: names come inside one record (a role's or a machine type's people) and in the instruction register, a legal
 * register (art. 37 c.5) the safety readers keep.
 */

export interface LensActions {
  onAddress?: (change: Partial<TrainingAddress>) => void
  onRetry?: () => void
  onCourse?: (id: string | 'new') => void
  onStandard?: () => void
  onArchiveMany?: (courses: Course[]) => void
  onNeed?: (id: string) => void
  onClassCourses?: (classId: string) => void
  onInstruction?: () => void
  onEntry?: (entry: InstructionEntry) => void
  onPaperMany?: (entries: InstructionEntry[]) => void
  onHelp?: () => void
}

const TRAINING_KEYS = (t: (key: string) => string): ListKey[] => [
  { keys: ['r'], does: t('keys.record') },
  { keys: ['Enter'], does: t('keys.open') },
]

// ---- Course catalogue ------------------------------------------------------------------------------------------------------

export function CoursesLens({ section, can, address, actions }: { section: Section<Courses>; can: TrainingCan; address: TrainingAddress; actions?: LensActions | undefined }) {
  const t = useTrainingWords()
  const locale = useLocale()
  const [selected, setSelected] = useState<string[]>([])
  const answer = section.status === 'ready' ? section.value : null
  const rows = answer?.courses ?? null
  const manage = can.manage && (answer?.canAdd ?? true)
  const open = useRef(actions?.onCourse)
  open.current = actions?.onCourse

  const columns = useMemo<ColDef<Course>[]>(() => {
    // The name opens the Course pop-up (Enter on the row does too).
    const NameCell = ({ data }: ICellRendererParams<Course>) =>
      data ? (
        <span className="fw-tr-cell">
          <button type="button" className="fw-tr-link" onClick={() => open.current?.(data.id)}>
            {courseName(data, locale)}
          </button>
          <span className="fw-tr-code">{data.code}</span>
        </span>
      ) : null
    const LawCell = ({ data }: ICellRendererParams<Course>) => (data ? <Law law={data.legalBasis} plain="law.course" /> : null)
    return [
      { colId: 'course', headerName: t('courses.col.course'), minWidth: 250, flex: 2, valueGetter: (params) => (params.data ? courseName(params.data, locale) : ''), cellRenderer: NameCell },
      { colId: 'type', headerName: t('courses.col.type'), minWidth: 150, flex: 0.9, valueGetter: (params) => (params.data ? t(`type.${params.data.type}`) : '') },
      { colId: 'hours', headerName: t('courses.col.hours'), minWidth: 70, flex: 0.4, type: 'numericColumn', valueGetter: (params) => (params.data ? hoursText(params.data.hours, locale) : '') },
      {
        colId: 'refresher',
        headerName: t('courses.col.refresher'),
        minWidth: 150,
        flex: 0.9,
        valueGetter: (params) => {
          const course = params.data
          if (!course) return ''
          if (course.refresherMonths === null) return t('courses.noRefresher')
          return course.refresherHours ? t('courses.everyHours', { count: course.refresherMonths, hours: hoursText(course.refresherHours, locale) }) : t('courses.every', { count: course.refresherMonths })
        },
      },
      { colId: 'inPerson', headerName: t('courses.col.inPerson'), minWidth: 100, flex: 0.5, valueGetter: (params) => (params.data ? t(params.data.inPersonRequired ? 'common.yes' : 'common.no') : '') },
      { colId: 'provider', headerName: t('courses.col.provider'), minWidth: 130, flex: 0.8, valueGetter: (params) => (params.data ? (params.data.provider ?? '—') : '') },
      { colId: 'law', headerName: t('courses.col.law'), minWidth: 200, flex: 1.1, valueGetter: (params) => params.data?.legalBasis ?? '', cellRenderer: LawCell },
      {
        colId: 'asked',
        headerName: t('courses.col.asked'),
        minWidth: 150,
        flex: 0.8,
        valueGetter: (params) => (params.data ? t('courses.askedBy', { roles: params.data.requiredBy.roleSheets, machines: params.data.requiredBy.machineClasses }) : ''),
      },
      { colId: 'scope', headerName: t('courses.col.scope'), minWidth: 100, flex: 0.5, valueGetter: (params) => (params.data ? (params.data.companyId === null ? t('courses.group') : (params.data.company?.code ?? '')) : '') },
      ...(address.status !== 'ACTIVE' ? [{ colId: 'status', headerName: t('courses.col.status'), minWidth: 110, flex: 0.5, valueGetter: (params: { data?: Course }) => (params.data ? t(`status.${params.data.status}`) : '') } as ColDef<Course>] : []),
    ]
  }, [t, locale, address.status, open])

  const head = (
    <SectionHead id="fw-tr-courses" title={t('courses.title')} note={<Law law={answer?.law.training ?? LAWS.training} plain="law.training" />}>
      <Button size="sm" heldReason={manage ? null : t('held.manage')} onClick={() => actions?.onStandard?.()}>
        <ListChecks size={13} aria-hidden /> {t('courses.standard')}
      </Button>
      <Button size="sm" variant="primary" heldReason={manage ? null : t('held.manage')} onClick={() => actions?.onCourse?.('new')}>
        <Plus size={13} aria-hidden /> {t('courses.add')}
      </Button>
    </SectionHead>
  )
  if (section.status === 'error') return <>{head}<SectionFailed title={t('courses.failed')} problem={section.problem} onRetry={actions?.onRetry} /></>
  if (!answer || !rows) return <>{head}<SectionLoading rows={6} /></>

  const picked = rows.filter((row) => selected.includes(row.id))
  const filtered = address.status !== 'ACTIVE' || address.q !== ''
  return (
    <>
      {head}
      <ListFrame<Course>
        label={t('courses.label')}
        title={t('courses.title')}
        listKey="people.skills.courses"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        rowKind="text"
        count={t('courses.count', { count: rows.length })}
        search={<Input key={address.q} type="search" size="sm" aria-label={t('courses.search')} placeholder={t('courses.search')} defaultValue={address.q} onKeyDown={(event) => event.key === 'Enter' && actions?.onAddress?.({ q: event.currentTarget.value })} onBlur={(event) => event.currentTarget.value !== address.q && actions?.onAddress?.({ q: event.currentTarget.value })} />}
        tools={
          <Select size="sm" aria-label={t('courses.statusFilter')} value={address.status} onChange={(event) => actions?.onAddress?.({ status: event.target.value as CourseListStatus })}>
            {COURSE_LIST_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`courses.status.${status}`)}
              </option>
            ))}
          </Select>
        }
        selection={
          manage
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <Button size="sm" aria-label={t('courses.archiveCount', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneArchivable') : null} onClick={() => actions?.onArchiveMany?.(picked)}>
                    <SelectionLabel>{t('courses.archiveCount', { count: picked.length })}</SelectionLabel>
                  </Button>
                ),
              }
            : undefined
        }
        isRowSelectable={manage ? (row) => (row.status !== 'ACTIVE' ? t('held.archivedRow') : archiveHeld(row) ? t(archiveHeld(row)!) : null) : undefined}
        keys={TRAINING_KEYS(t)}
        onHelp={actions?.onHelp}
        onOpen={(row) => actions?.onCourse?.(row.id)}
        more={answer.complete ? null : { label: t('common.more'), onMore: () => undefined, held: t('courses.moreHeld') }}
        state={
          rows.length === 0 ? (
            filtered ? (
              <EmptyState icon={<BookOpen size={22} aria-hidden />} title={t('courses.noneFiltered')} />
            ) : (
              <EmptyState
                icon={<BookOpen size={22} aria-hidden />}
                title={t('courses.emptyTitle')}
                description={t('courses.empty')}
                action={
                  <Button size="sm" variant="primary" heldReason={manage ? null : t('held.manage')} onClick={() => actions?.onStandard?.()}>
                    <ListChecks size={13} aria-hidden /> {t('courses.standard')}
                  </Button>
                }
              />
            )
          ) : undefined
        }
        cards={{ fields: { course: { role: 'title' }, type: { role: 'subtitle' }, hours: { role: 'field', label: t('courses.col.hours') }, refresher: { role: 'field', label: t('courses.col.refresher') } } }}
      />
      <p className="fw-tr-muted">{t('courses.foot')}</p>
    </>
  )
}

// ---- Who needs what --------------------------------------------------------------------------------------------------------

export function NeedsLens({ section, actions }: { section: Section<Requirements>; actions?: LensActions | undefined }) {
  const t = useTrainingWords()
  const locale = useLocale()
  const answer = section.status === 'ready' ? section.value : null
  const rows = useMemo(() => (answer ? needRowsOf(answer, locale) : null), [answer, locale])
  const names = useMemo(() => new Map((answer?.courses ?? []).map((course) => [course.id, courseName(course, locale)])), [answer, locale])
  const open = useRef(actions?.onNeed)
  open.current = actions?.onNeed

  const columns = useMemo<ColDef<NeedRow>[]>(() => {
    const WhoCell = ({ data }: ICellRendererParams<NeedRow>) =>
      data ? (
        <span className="fw-tr-cell">
          <button type="button" className="fw-tr-link" onClick={() => open.current?.(data.id)}>
            {data.label}
          </button>
          <span className="fw-tr-code">{data.code}</span>
        </span>
      ) : null
    const StateCell = ({ data }: ICellRendererParams<NeedRow>) =>
      data ? (
        <span className="fw-tr-row">
          <span className="fw-tr-num">{t('needs.met', { count: data.met })}</span>
          {data.due > 0 && <Pill tone="warning">{t('needs.due', { count: data.due })}</Pill>}
          {data.overdue > 0 && <Pill tone="danger">{t('needs.overdue', { count: data.overdue })}</Pill>}
        </span>
      ) : null
    return [
      { colId: 'who', headerName: t('needs.col.who'), minWidth: 220, flex: 1.4, valueGetter: (params) => params.data?.label ?? '', cellRenderer: WhoCell },
      { colId: 'kind', headerName: t('needs.col.kind'), minWidth: 140, flex: 0.7, valueGetter: (params) => (params.data ? t(`needs.kind.${params.data.kind}`) : '') },
      { colId: 'site', headerName: t('needs.col.site'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data ? (params.data.site ?? t('needs.allSites')) : '') },
      {
        colId: 'courses',
        headerName: t('needs.col.courses'),
        minWidth: 260,
        flex: 2,
        valueGetter: (params) => (params.data ? params.data.courses.map((line) => `${names.get(line.courseId) ?? '—'} (${line.withinDays === null ? t('needs.before') : t('needs.within', { count: line.withinDays })})`).join(' · ') || t('needs.noCourses') : ''),
        tooltipValueGetter: (params) => (params.data ? params.data.courses.map((line) => names.get(line.courseId) ?? '').join(', ') : null),
      },
      { colId: 'people', headerName: t('needs.col.people'), minWidth: 100, flex: 0.5, type: 'numericColumn', valueGetter: (params) => params.data?.people ?? null },
      { colId: 'state', headerName: t('needs.col.state'), minWidth: 220, flex: 1, valueGetter: (params) => (params.data ? `${params.data.met}/${params.data.due}/${params.data.overdue}` : ''), cellRenderer: StateCell },
    ]
  }, [t, names, open])

  const head = (
    <SectionHead id="fw-tr-needs" title={t('needs.title')} note={<Law law={answer?.law.training ?? LAWS.training} plain="law.needs" />}>
      {answer && (
        <span className="fw-tr-muted">
          {t('needs.overall', { needs: answer.overall.needs, met: answer.overall.met, due: answer.overall.due, overdue: answer.overall.overdue })}
        </span>
      )}
    </SectionHead>
  )
  if (section.status === 'error') return <>{head}<SectionFailed title={t('needs.failed')} problem={section.problem} onRetry={actions?.onRetry} /></>
  if (!answer || !rows) return <>{head}<SectionLoading rows={5} /></>
  return (
    <>
      {head}
      <ListFrame<NeedRow>
        label={t('needs.label')}
        title={t('needs.title')}
        listKey="people.skills.needs"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        rowKind="text"
        count={t('needs.count', { count: rows.length })}
        keys={TRAINING_KEYS(t)}
        onHelp={actions?.onHelp}
        onOpen={(row) => actions?.onNeed?.(row.id)}
        state={rows.length === 0 ? <EmptyState icon={<ClipboardList size={22} aria-hidden />} title={t('needs.emptyTitle')} description={t('needs.empty')} /> : undefined}
        cards={{ fields: { who: { role: 'title' }, kind: { role: 'subtitle' }, people: { role: 'field', label: t('needs.col.people') }, state: { role: 'field', label: t('needs.col.state'), draw: (row: NeedRow) => t('needs.cardState', { met: row.met, due: row.due, overdue: row.overdue }) }, courses: { role: 'hidden' }, site: { role: 'hidden' } } }}
      />
      <p className="fw-tr-muted">
        <Settings2 size={12} aria-hidden /> {t('needs.foot')}
      </p>
    </>
  )
}

// ---- Instruction register ---------------------------------------------------------------------------------------------------

export function InstructionLens({ section, can, address, today, actions }: { section: Section<InstructionList>; can: TrainingCan; address: TrainingAddress; today: string; actions?: LensActions | undefined }) {
  const t = useTrainingWords()
  const locale = useLocale()
  const day = useDay()
  const language = useLanguage()
  const [selected, setSelected] = useState<string[]>([])
  const answer = section.status === 'ready' ? section.value : null
  const rows = answer?.entries ?? null
  const add = can.instruct && (answer?.canAdd ?? true)
  const open = useRef(actions?.onEntry)
  open.current = actions?.onEntry

  const columns = useMemo<ColDef<InstructionEntry>[]>(() => {
    const StateCell = ({ data }: ICellRendererParams<InstructionEntry>) => {
      if (!data) return null
      const state = entryState(data)
      const tone = state === 'voided' ? 'neutral' : state === 'waiting' ? 'warning' : 'success'
      return (
        <Tag tone={tone}>
          {state === 'pin' && <Signature size={11} aria-hidden />} {t(`entry.state.${state}`)}
        </Tag>
      )
    }
    return [
      { colId: 'date', headerName: t('entries.col.date'), minWidth: 120, flex: 0.6, valueGetter: (params) => params.data?.instructedOn ?? '', valueFormatter: (params) => day(params.value as string) },
      {
        colId: 'person',
        headerName: t('entries.col.person'),
        minWidth: 170,
        flex: 1,
        valueGetter: (params) => params.data?.employee.name ?? '',
        cellRenderer: ({ data }: ICellRendererParams<InstructionEntry>) =>
          data ? (
            <button type="button" className="fw-tr-link" onClick={() => open.current?.(data)}>
              {data.employee.name}
            </button>
          ) : null,
      },
      { colId: 'task', headerName: t('entries.col.task'), minWidth: 230, flex: 1.6, valueGetter: (params) => (params.data ? [params.data.task, params.data.machineClass ? (locale === 'it' ? params.data.machineClass.label.it : params.data.machineClass.label.en) : null, params.data.machine?.assetNumber ?? null].filter(Boolean).join(' · ') : '') },
      { colId: 'instructor', headerName: t('entries.col.instructor'), minWidth: 160, flex: 0.9, valueGetter: (params) => params.data?.instructor.name ?? '' },
      { colId: 'minutes', headerName: t('entries.col.minutes'), minWidth: 100, flex: 0.4, type: 'numericColumn', valueGetter: (params) => params.data?.minutes ?? null },
      { colId: 'signed', headerName: t('entries.col.signed'), minWidth: 170, flex: 0.8, valueGetter: (params) => (params.data ? t(`entry.state.${entryState(params.data)}`) : ''), cellRenderer: StateCell },
      { colId: 'language', headerName: t('entries.col.language'), minWidth: 150, flex: 0.7, valueGetter: (params) => (params.data ? `${language(params.data.language)}${params.data.languageChecked ? '' : ` · ${t('entries.notChecked')}`}` : '') },
    ]
  }, [t, locale, day, language, open])

  const head = (
    <SectionHead id="fw-tr-instruction" title={t('entries.title')} note={<Law law={answer?.law.instruction ?? LAWS.instruction} plain="law.instruction" />}>
      <Button size="sm" variant="primary" heldReason={add ? null : t('held.instruct')} onClick={() => actions?.onInstruction?.()}>
        <FilePlus2 size={13} aria-hidden /> {t('entries.add')}
      </Button>
    </SectionHead>
  )
  if (section.status === 'error') return <>{head}<SectionFailed title={t('entries.failed')} problem={section.problem} onRetry={actions?.onRetry} /></>
  if (!answer || !rows) return <>{head}<SectionLoading rows={6} /></>

  const picked = rows.filter((row) => selected.includes(row.id))
  const paperable = picked.filter((row) => row.canChange && !row.signed && !row.voided)
  return (
    <>
      {head}
      <ListFrame<InstructionEntry>
        label={t('entries.label')}
        title={t('entries.title')}
        listKey={null}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        rowKind="text"
        count={t('entries.count', { count: rows.length })}
        search={<Input key={address.q} type="search" size="sm" aria-label={t('entries.search')} placeholder={t('entries.search')} defaultValue={address.q} onKeyDown={(event) => event.key === 'Enter' && actions?.onAddress?.({ q: event.currentTarget.value })} onBlur={(event) => event.currentTarget.value !== address.q && actions?.onAddress?.({ q: event.currentTarget.value })} />}
        tools={
          <Select size="sm" aria-label={t('entries.viewFilter')} value={address.entries} onChange={(event) => actions?.onAddress?.({ entries: event.target.value as InstructionView })}>
            {INSTRUCTION_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`entries.view.${view}`)}
              </option>
            ))}
          </Select>
        }
        selection={
          can.instruct
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <Button size="sm" aria-label={t('entries.paperCount', { count: paperable.length })} heldReason={paperable.length === 0 ? t('held.nonePaper') : null} onClick={() => actions?.onPaperMany?.(paperable)}>
                    <SelectionLabel>{t('entries.paperCount', { count: paperable.length })}</SelectionLabel>
                  </Button>
                ),
              }
            : undefined
        }
        isRowSelectable={can.instruct ? (row) => (row.voided ? t('held.voidedRow') : row.signed ? t('held.signedRow') : !row.canChange ? t('held.instruct') : null) : undefined}
        keys={TRAINING_KEYS(t)}
        onHelp={actions?.onHelp}
        onOpen={(row) => actions?.onEntry?.(row)}
        more={answer.complete ? null : { label: t('common.more'), onMore: () => undefined, held: t('entries.moreHeld') }}
        state={rows.length === 0 ? <EmptyState icon={<Signature size={22} aria-hidden />} title={address.entries !== 'all' || address.q ? t('entries.noneFiltered') : t('entries.empty')} /> : undefined}
        cards={{ fields: { person: { role: 'title' }, date: { role: 'subtitle' }, task: { role: 'field', label: t('entries.col.task') }, signed: { role: 'field', label: t('entries.col.signed') } } }}
      />
      <p className="fw-tr-muted">{t('entries.foot', { date: day(today) })}</p>
    </>
  )
}
