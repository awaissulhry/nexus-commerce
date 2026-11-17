'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Building2, CalendarDays, FileText, Plus, UserRound } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, type MenuItemDef } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useT } from '../../../../../lib/i18n/provider'
import { TaskNewDialog } from '../../../../../record-panels/view/TaskNewDialog'
import type { ApiFile } from '../../../../../record-panels/api'
import type { TaskItem } from '../../../../../record-panels/tasks/model'
import type { ProjectPage, ProjectView } from '../../api'
import { listHref, partyHref, type Phrase } from '../../model'
import { NoticeLine, ProjectsMessages, StatusPill, TargetDate, useWords } from '../../parts'
import { bandRows, changeHeld, primaryOf, RECORD_NS, type BandLine } from '../model'
import { PROJECT_KEYS, ProjectFrame } from '../ProjectFrame'
import type { ProjectRecordActions, ProjectRecordModel } from '../view-model'
import { CloseDialog } from './CloseDialog'
import { EditDialog } from './EditDialog'

export type { ProjectRecordActions, ProjectRecordModel } from '../view-model'

/** The slots the page fills: the thread (the office's OfficeRecordThread docked), People (B-TH-250), Linked (B-TH-251), the news. */
export interface ProjectRecordSlots {
  readonly thread?: ReactNode
  readonly people?: ReactNode
  readonly linked?: ReactNode
  readonly news?: ReactNode
  /** What the print view shows of the thread (the record panels' print form). */
  readonly printThread?: ReactNode
}

/**
 * SCR-701 — a project's page (B-TH-249; PROJ.record, PROJ.thread; the generic record page grown): the band in the shell's band row
 * (‹ Projects, "<number> · <name>", ONE status pill, the outside company or "Office only", the lead, the target date with its words,
 * the season; Reopen on a closed project; ⋯ Edit details, Put on hold / Resume, Close…, Reopen, Copy link, Keyboard), the thread
 * ~2/3 as the page's main column with the closed banner and one notice above it, the side column ~1/3: Details, People, Linked,
 * News of linked records, Tasks, Files. No tabs; one thread. A project the person may not read is "not found" (W38).
 */
export function ProjectRecordView({ model, actions, thread, people, linked, news, printThread }: { model: ProjectRecordModel; actions?: ProjectRecordActions } & ProjectRecordSlots) {
  return (
    <ProjectsMessages also={[RECORD_NS, 'search', 'records']}>
      <Page model={model} actions={actions} thread={thread} people={people} linked={linked} news={news} printThread={printThread} />
    </ProjectsMessages>
  )
}

function Page({ model, actions, thread, people, linked, news, printThread }: { model: ProjectRecordModel; actions?: ProjectRecordActions } & ProjectRecordSlots) {
  const { t, say, shared } = useWords(RECORD_NS)
  const back = <Link href={listHref(model.prefix)}>{t('band.back')}</Link>
  const page = model.page

  if (page.status !== 'ready') {
    const notFound = page.status === 'error' && page.problem === 'problem.notFound'
    return (
      <ProjectFrame band={{ back, title: page.status === 'loading' ? t('page.reading') : notFound ? t('page.notFoundTitle') : t('page.failedTitle'), moreLabel: t('band.moreLabel') }} thread={null} threadLabel={t('frame.threadLabelPlain')} side={null} sideLabel={t('frame.sideLabel')}>
        {page.status === 'loading' ? (
          <Card padded aria-busy="true">
            <Skeleton height={24} />
            <Skeleton height={320} />
          </Card>
        ) : notFound ? (
          <Card padded>
            <EmptyState
              title={t('page.notFoundTitle')}
              description={shared('problem.notFound')}
              action={
                <Button asChild variant="primary">
                  <Link href={listHref(model.prefix)}>{t('page.toList')}</Link>
                </Button>
              }
            />
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              title={t('page.failedTitle')}
              description={shared(page.problem)}
              action={
                <Button variant="primary" onClick={() => actions?.onRetry?.()}>
                  {shared('common.retry')}
                </Button>
              }
            />
          </Card>
        )}
      </ProjectFrame>
    )
  }

  const data = page.data
  const project = data.project
  const state = { offline: model.offline, busy: model.busy }
  const label = `${project.number} · ${project.name}`
  const run: Record<BandLine, (() => void) | undefined> = {
    edit: actions?.onEdit,
    hold: actions?.onHold,
    resume: actions?.onResume,
    close: actions?.onClose,
    reopen: actions?.onReopen,
    copy: actions?.onCopyLink,
  }
  const more: MenuItemDef[] = bandRows(project, state).map((row) => {
    const held = say(row.held)
    return { id: row.id, label: t(`band.more.${row.id}`), disabled: !!held, description: held ?? undefined, onSelect: () => run[row.id]?.() }
  })
  const reopenHeld = say(changeHeld(project, state, false))
  // Reopen is the band's one step on a closed project, for who keeps projects (without the right the ⋯ line says why).
  const primary =
    primaryOf(project) === 'reopen' && project.may.manage ? (
      <Button size="sm" variant="primary" heldReason={reopenHeld} onClick={() => actions?.onReopen?.()}>
        {t('band.more.reopen')}
      </Button>
    ) : undefined
  const meta = (
    <>
      <span className="fw-prjr-meta-item">
        <Building2 size={13} aria-hidden />
        {project.party ? model.can.parties ? <Link href={partyHref(model.prefix, project.party.id)}>{project.party.name}</Link> : project.party.name : <Tag tone="neutral">{shared('common.officeOnly')}</Tag>}
      </span>
      <span className="fw-prjr-meta-item">
        <UserRound size={13} aria-hidden /> {t('band.lead', { name: project.lead.name })}
      </span>
      <span className="fw-prjr-meta-item">
        <CalendarDays size={13} aria-hidden /> <TargetDate targetDate={project.targetDate} target={project.target} />
      </span>
      {project.seasonCode && <span className="fw-prjr-meta-item">{t('band.season', { season: project.seasonCode })}</span>}
    </>
  )

  const notices = (
    <>
      {project.status === 'CLOSED' && <ClosedBanner project={project} reopenHeld={project.may.manage ? reopenHeld : null} mayReopen={project.may.manage} onReopen={actions?.onReopen} />}
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} ns={RECORD_NS} />
    </>
  )

  const side = (
    <>
      <DetailsCard data={data} prefix={model.prefix} parties={model.can.parties} />
      {people}
      <div id="linked" className="fw-prjr-slot">
        {linked}
      </div>
      {news}
      <TasksCard model={model} data={data} actions={actions} closed={project.status === 'CLOSED'} />
      <FilesCard model={model} data={data} actions={actions} />
    </>
  )

  // An office-only project has nobody to reply to: the keys list leaves "R" out.
  const keys = project.party ? PROJECT_KEYS : PROJECT_KEYS.filter((entry) => entry.words !== 'keys.reply')

  return (
    <>
      <ProjectFrame
        band={{
          back,
          title: (
            <span className="fw-prjr-title">
              {project.number} <span className="fw-prjr-title-name">· {project.name}</span>
            </span>
          ),
          status: <StatusPill status={project.status} />,
          meta,
          primary,
          more,
          moreLabel: t('band.moreLabel'),
        }}
        thread={thread ?? null}
        threadLabel={t('frame.threadLabel', { project: label })}
        notices={notices}
        side={side}
        sideLabel={t('frame.sideLabel')}
        keys={keys}
        printThread={printThread}
        detailsOpen={model.detailsOpen}
      />
      {model.dialog?.kind === 'close' && <CloseDialog project={project} draft={model.dialog.draft} busy={model.dialog.busy} problem={model.dialog.problem} offline={model.offline} actions={actions?.close} />}
      {model.dialog?.kind === 'edit' && <EditDialog project={project} state={model.dialog} offline={model.offline} actions={actions?.edit} />}
      {model.dialog?.kind === 'task' && actions?.task && (
        <TaskNewDialog
          recordLabel={project.number}
          people={model.dialog.people}
          me={model.me}
          busy={model.dialog.busy}
          held={model.offline ? say({ key: 'held.offline' }) : null}
          {...(model.dialog.initial ? { initial: model.dialog.initial } : {})}
          onRetryPeople={actions.task.onRetryPeople}
          onCreate={actions.task.onCreate}
          onClose={actions.task.onCancel}
        />
      )}
    </>
  )
}

/** "Closed on 12 Dec by Marco · Done · <outcome line>" with Reopen for who keeps projects (PROJ.record-F04). */
function ClosedBanner({ project, reopenHeld, mayReopen, onReopen }: { project: ProjectView; reopenHeld: string | null; mayReopen: boolean; onReopen?: () => void }) {
  const { t, shared, day } = useWords(RECORD_NS)
  const params = {
    date: day(project.closedAt),
    by: project.closedBy?.name ?? '',
    outcome: project.outcome ? shared(`outcome.${project.outcome}`) : '',
    note: project.outcomeNote ?? '',
  }
  return (
    <Banner
      tone="neutral"
      title={t(project.closedBy ? 'closed.banner' : 'closed.bannerNoBy', params)}
      action={
        mayReopen ? (
          <Button size="sm" heldReason={reopenHeld} onClick={() => onReopen?.()}>
            {t('band.more.reopen')}
          </Button>
        ) : undefined
      }
    >
      {t(mayReopen ? 'closed.body' : 'closed.bodyReadOnly')}
    </Banner>
  )
}

/** Details: number, the outside company (set once) or Office only, lead, target date, season, goal, who made it, who may open it. */
function DetailsCard({ data, prefix, parties }: { data: ProjectPage; prefix: string; parties: boolean }) {
  const { t, shared, day, when } = useWords(RECORD_NS)
  const project = data.project
  return (
    <Card className="fw-prjr-section" header={t('details.title')} headingLevel={2}>
      <div className="fw-prjr-section-body">
        <KeyValue
          className="fw-prjr-kv"
          dense
          labelCase="sentence"
          items={[
            { label: t('details.number'), value: <span className="fw-prj-num">{project.number}</span> },
            {
              label: shared('field.partyId'),
              value: project.party ? parties ? <Link href={partyHref(prefix, project.party.id)}>{project.party.name}</Link> : project.party.name : shared('common.officeOnly'),
              hint: project.party ? t('details.partyFixed', { party: project.party.name }) : t('details.officeOnlyHint'),
            },
            { label: shared('field.leadId'), value: project.lead.name },
            { label: shared('field.targetDate'), value: <TargetDate targetDate={project.targetDate} target={project.target} /> },
            { label: shared('field.seasonCode'), value: project.seasonCode ?? '—' },
            {
              label: t('details.made'),
              value: project.createdBy ? t('details.madeBy', { name: project.createdBy.name, date: day(project.createdAt) }) : day(project.createdAt),
            },
            ...(project.lastMessageAt ? [{ label: t('details.lastMessage'), value: when(project.lastMessageAt) }] : []),
          ]}
        />
        <div>
          <h3 className="fw-prjr-line-hint">{shared('field.goal')}</h3>
          {project.goal ? <p className="fw-prjr-goal">{project.goal}</p> : <p className="fw-prjr-hint">{t('details.noGoal')}</p>}
        </div>
        <p className="fw-prjr-hint">{shared('common.openToOffice')}</p>
      </div>
    </Card>
  )
}

/** A task's due date in words (the API's word: overdue, today, soon), or the day, or nothing. */
function dueWords(task: TaskItem): Phrase | null {
  if (!task.due) return task.dueDate ? { key: 'tasks.due.on', params: { date: task.dueDate } } : null
  if (task.due.word === 'OVERDUE') return { key: 'tasks.due.overdue', params: { count: Math.abs(task.due.days) } }
  if (task.due.word === 'TODAY') return { key: 'tasks.due.today' }
  if (task.due.word === 'SOON') return { key: 'tasks.due.soon', params: { count: task.due.days } }
  return { key: 'tasks.due.on', params: { date: task.due.date } }
}

/** Tasks: the open and overdue counts, the open tasks (each opens in Home › My tasks), + Add task (the ONE New task dialog). */
function TasksCard({ model, data, actions, closed }: { model: ProjectRecordModel; data: ProjectPage; actions?: ProjectRecordActions; closed: boolean }) {
  const { t, say, shared } = useWords(RECORD_NS)
  const tr = useT('records')
  const held = closed ? say({ key: 'held.closed' }) : model.addTaskHeld ? tr(model.addTaskHeld) : model.offline ? say({ key: 'held.offline' }) : null
  const tasks = model.tasks
  return (
    <Card
      className="fw-prjr-section"
      header={t('tasks.title')}
      headingLevel={2}
      headerAction={
        <Button size="sm" heldReason={held} onClick={() => actions?.task?.onOpen()}>
          <Plus size={14} aria-hidden /> {t('tasks.add')}
        </Button>
      }
    >
      <div className="fw-prjr-section-body">
        <span className="fw-prjr-counts">
          <Tag tone="neutral">{t('tasks.open', { count: data.tasks.open })}</Tag>
          {data.tasks.overdue > 0 && <Tag tone="danger">{t('tasks.overdue', { count: data.tasks.overdue })}</Tag>}
        </span>
        {tasks === null ? (
          <p className="fw-prjr-hint">{t('tasks.noHome')}</p>
        ) : tasks.status === 'loading' ? (
          <Skeleton height={18} />
        ) : tasks.status === 'error' ? (
          <Banner
            tone="danger"
            title={tr(tasks.problem)}
            action={
              <Button size="sm" onClick={() => actions?.task?.onRetry()}>
                {shared('common.retry')}
              </Button>
            }
          />
        ) : tasks.data.length === 0 ? (
          <p className="fw-prjr-hint">{t('tasks.none')}</p>
        ) : (
          <ul className="fw-prjr-list">
            {tasks.data.map((task) => {
              const due = dueWords(task)
              const overdue = task.due?.word === 'OVERDUE'
              return (
                <li key={task.id} className="fw-prjr-item">
                  <span className="fw-prjr-item-main">
                    <Link href={`${model.prefix}/home/tasks?open=${encodeURIComponent(task.id)}`}>{task.title}</Link>
                    <span className="fw-prjr-item-meta">{task.assignee ? task.assignee.name : t('tasks.nobody')}</span>
                  </span>
                  {due && (
                    <span className="fw-prjr-item-side">
                      <Tag tone={overdue ? 'danger' : task.due?.word === 'TODAY' || task.due?.word === 'SOON' ? 'warning' : 'neutral'}>{say(due)}</Tag>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Card>
  )
}

const FILES_SHOWN = 5

/** The latest available files, newest first. */
export function latestFiles(files: readonly ApiFile[], take = FILES_SHOWN): ApiFile[] {
  return files
    .filter((file) => file.status === 'AVAILABLE')
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, take)
}

/** Files: the count, the latest few with their audience mark (Office, or shared with the outside company); the rest in the thread. */
function FilesCard({ model, data, actions }: { model: ProjectRecordModel; data: ProjectPage; actions?: ProjectRecordActions }) {
  const { t, shared, locale } = useWords(RECORD_NS)
  const party = data.project.party
  const files = model.files
  return (
    <Card className="fw-prjr-section" header={t('files.title', { count: data.files.count })} headingLevel={2}>
      <div className="fw-prjr-section-body">
        {files === null ? (
          <p className="fw-prjr-hint">{t('files.noRight')}</p>
        ) : files.status === 'loading' ? (
          <Skeleton height={18} />
        ) : files.status === 'error' ? (
          <Banner
            tone="danger"
            title={t(files.problem)}
            action={
              <Button size="sm" onClick={() => actions?.files?.onRetry()}>
                {shared('common.retry')}
              </Button>
            }
          />
        ) : latestFiles(files.data).length === 0 ? (
          <p className="fw-prjr-hint">{t('files.none')}</p>
        ) : (
          <ul className="fw-prjr-list">
            {latestFiles(files.data).map((file) => {
              const shown = party && file.visibility.includes('PARTNER')
              return (
                <li key={file.id} className="fw-prjr-item">
                  <span className="fw-prjr-item-main">
                    <Button size="sm" variant="quiet" inline onClick={() => actions?.files?.onOpen(file.id)} aria-label={t('files.open', { name: file.originalName })}>
                      <FileText size={13} aria-hidden /> <span className="fw-prjr-item-title">{file.originalName}</span>
                    </Button>
                    <span className="fw-prjr-item-meta">{formatDate(file.createdAt, { locale })}</span>
                  </span>
                  <span className="fw-prjr-item-side">
                    <Tag tone={shown ? 'info' : 'neutral'}>{shown ? t('files.shared', { party: party?.name ?? '' }) : t('files.office')}</Tag>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        {data.files.count > 0 && <p className="fw-prjr-hint">{t('files.inThread')}</p>}
      </div>
    </Card>
  )
}
