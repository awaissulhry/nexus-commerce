'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { CheckCheck, Download, FileText, MoreHorizontal, Scissors } from 'lucide-react'
import { Banner, EmptyState, Menu, ProgressBar, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill } from '@nexus/ui/primitives'
import { Countdown } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { JobChip, JobRow, JobsRead } from '../api'
import { acceptableOf, cardStepOf, dueOf, jobHref, operationsOf, personHeld, sheetHref, STATE_TONE, type PersonFacts, type Words } from '../model'
import { useJobWords } from '../words'
import { AcceptDialog, BulkAcceptDialog, DeclineDialog, type AcceptModel, type BulkAcceptModel, type DeclineModel } from './Dialogs'
import '../jobs.css'

/**
 * SCR-192 › Jobs (design portal.supplier.jobs: sec:chips "Which jobs", sec:job-cards "Your jobs"): the chips with counts
 * (big, one row, sideways on a phone), the jobs in the shared list frame — on a phone the frame's cards, big text and ONE
 * button each (accept, confirm the kit, report, send back), a progress bar of finished of total, the due-back countdown —,
 * select-all, shift range, x / Space, the bulk actions while rows are selected (Accept N as asked, Export N), the keys only
 * in the footer's info icon. Accept / Decline straight from a New card (its ⋯ on a desktop). No price anywhere (C2).
 */

export interface JobsListViewModel {
  state: 'loading' | 'error' | 'ready'
  read: JobsRead | null
  /** The chip asked in the address (null: the API's default). */
  chip: JobChip | null
  q: string
  prefix: string
  today: string
  selected: readonly string[]
  facts: PersonFacts
  /** Live: the list changed since it was read. */
  updates: number
  accept: AcceptModel | null
  decline: DeclineModel | null
  bulk: BulkAcceptModel | null
  /** What the last act came to (a banner over the list). */
  notice: { tone: 'success' | 'warning' | 'danger'; words: Words } | null
  /** No connection: what is shown was read at this time. */
  offlineSince: string | null
  keysOpen?: boolean
}

export interface JobsListActions {
  onChip?: (chip: JobChip) => void
  onSearch?: (q: string) => void
  onSelect?: (ids: string[]) => void
  onOpen?: (row: JobRow) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onAccept?: (row: JobRow) => void
  onDecline?: (row: JobRow) => void
  onBulkAccept?: (ids: readonly string[]) => void
  onExport?: (ids: readonly string[] | null) => void
  onDismissNotice?: () => void
  accept?: { onDraft?: (draft: AcceptModel['draft']) => void; onSend?: () => void; onDecline?: () => void; onClose?: () => void }
  decline?: { onDraft?: (draft: DeclineModel['draft']) => void; onSend?: () => void; onClose?: () => void }
  bulk?: { onSend?: () => void; onClose?: () => void }
}

export function JobsListView({ model, actions }: { model: JobsListViewModel; actions?: JobsListActions }) {
  const words = useJobWords()
  const { t, day, say } = words
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const read = model.read
  const rows = read?.items ?? null
  const chip = read?.chip ?? model.chip

  const columns = useMemo((): ColDef<JobRow>[] => {
    const open = (event: React.MouseEvent, row: JobRow) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
      event.preventDefault()
      latest.current.actions?.onOpen?.(row)
    }
    const JobCell = ({ data }: ICellRendererParams<JobRow>) =>
      data ? (
        <a className="fw-pjob-rowlink" href={jobHref(latest.current.model.prefix, data.id)} onClick={(event) => open(event, data)}>
          <span className="fw-pjob-number">{data.number}</span>
          <span className="fw-pjob-sub">{operationsOf(data)}</span>
        </a>
      ) : null
    const StyleCell = ({ data }: ICellRendererParams<JobRow>) =>
      data ? (
        <span className="fw-pjob-two">
          <span>{data.workOrder.style.name || data.workOrder.style.code}</span>
          <span className="fw-pjob-sub" title={t('card.styleOf', { code: data.workOrder.style.code, workOrder: data.workOrder.number })}>{t('card.styleOf', { code: data.workOrder.style.code, workOrder: data.workOrder.number })}</span>
        </span>
      ) : null
    const progress = (data: JobRow) => (
      <span className="fw-pjob-progress">
        <span className="fw-pjob-sub">{t('card.finishedOf', { done: data.finished, total: data.pieces })}</span>
        <ProgressBar value={data.pieces > 0 ? Math.round((data.finished / data.pieces) * 100) : 0} tone={data.finished >= data.pieces && data.pieces > 0 ? 'complete' : 'partial'} ariaLabel={t('card.finishedOf', { done: data.finished, total: data.pieces })} />
      </span>
    )
    const ProgressCell = ({ data }: ICellRendererParams<JobRow>) => (data ? progress(data) : null)
    const KitCell = ({ data }: ICellRendererParams<JobRow>) => (data ? <span className={data.kitDate ? undefined : 'fw-pjob-sub'}>{data.kitDate ? day(data.kitDate) : t('col.kitNone')}</span> : null)
    const due = (data: JobRow) => {
      const line = dueOf(data, latest.current.model.today)
      return (
        <span className="fw-pjob-two">
          <span>{data.dueBack ? day(data.dueBack) : t('due.none')}</span>
          {data.proposedDate ? (
            <span className="fw-pjob-sub">{t('card.proposed', { date: day(data.proposedDate) })}</span>
          ) : line.key === 'due.in' && data.dueBack ? (
            <Countdown className="fw-pjob-sub" to={`${data.dueBack}T23:59:59Z`} label={(left) => t('due.inLeft', { left })} doneLabel={t('due.today')} announce={false} />
          ) : line.key === 'due.none' || line.key === 'due.ended' ? null : (
            <span className={line.tone === 'danger' ? 'fw-pjob-late' : 'fw-pjob-sub'}>{t(line.key, { count: line.days })}</span>
          )}
        </span>
      )
    }
    const DueCell = ({ data }: ICellRendererParams<JobRow>) => (data ? due(data) : null)
    const StatusCell = ({ data }: ICellRendererParams<JobRow>) => (data ? <Pill tone={STATE_TONE[data.state]}>{t(`state.${data.state}`)}</Pill> : null)
    const step = (data: JobRow): ReactNode => {
      const now = latest.current.model
      const next = cardStepOf(data, now.prefix)
      if (!next) return <span className="fw-pjob-sub">{t(`next.${data.nextStep}`)}</span>
      if (next.kind === 'accept') {
        const held = say(personHeld(now.facts, 'accept'))
        return (
          <Button size="sm" variant="primary" heldReason={held} onClick={() => latest.current.actions?.onAccept?.(data)}>
            {t(`next.${data.nextStep}`)}
          </Button>
        )
      }
      return (
        <Button asChild size="sm" variant="primary">
          <a href={next.href}>{t(`next.${data.nextStep}`)}</a>
        </Button>
      )
    }
    const StepCell = ({ data }: ICellRendererParams<JobRow>) => (data ? <span className="fw-pjob-step">{step(data)}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<JobRow>) => {
      if (!data) return null
      const now = latest.current.model
      const answering = data.nextStep === 'ACCEPT'
      const acceptHeld = say(personHeld(now.facts, 'accept'))
      const declineHeld = say(personHeld(now.facts, 'decline'))
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), href: jobHref(now.prefix, data.id) },
        ...(answering
          ? [
              { id: 'accept', label: t('row.accept'), disabled: acceptHeld !== null, description: acceptHeld ?? undefined, onSelect: () => latest.current.actions?.onAccept?.(data) },
              { id: 'decline', label: t('row.decline'), disabled: declineHeld !== null, description: declineHeld ?? undefined, onSelect: () => latest.current.actions?.onDecline?.(data) },
            ]
          : []),
        { id: 'sheet', label: t('row.sheet'), href: sheetHref(now.prefix, data.id), target: '_blank', icon: <FileText size={14} aria-hidden /> },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<JobRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<JobRow> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      // The phone card's title is the column's text: the job and what it is.
      { ...column('job', t('col.job'), JobCell, { flex: 1.2, minWidth: 160 }), valueGetter: ({ data }) => (data ? `${data.number} · ${operationsOf(data)}` : '') },
      { ...column('style', t('col.style'), StyleCell, { flex: 1.1, minWidth: 150 }), valueGetter: ({ data }) => (data ? data.workOrder.style.name || data.workOrder.style.code : '') },
      { ...column('progress', t('col.progress'), ProgressCell, { flex: 1, minWidth: 140 }), valueGetter: ({ data }) => (data ? t('card.finishedOf', { done: data.finished, total: data.pieces }) : '') },
      { ...column('kit', t('col.kit'), KitCell, { flex: 0.6, minWidth: 100 }), valueGetter: ({ data }) => (data?.kitDate ? day(data.kitDate) : t('col.kitNone')) },
      { ...column('due', t('col.due'), DueCell, { flex: 0.8, minWidth: 130 }), valueGetter: ({ data }) => (data?.dueBack ? day(data.dueBack) : t('due.none')) },
      { ...column('status', t('col.status'), StatusCell, { flex: 0.8, minWidth: 140 }), valueGetter: ({ data }) => (data ? t(`state.${data.state}`) : '') },
      { ...column('step', t('col.step'), StepCell, { flex: 1, minWidth: 190 }), valueGetter: ({ data }) => (data ? t(`next.${data.nextStep}`) : '') },
      { ...column('actions', t('col.actions'), MoreCell, { width: 72, minWidth: 72, maxWidth: 72 }), pinned: 'right', suppressHeaderMenuButton: true },
    ]
  }, [t, day, say])

  const selected = model.selected
  const reach = rows ? acceptableOf(rows, selected) : []
  const bulkHeldWords = personHeld(model.facts, 'accept') ?? (reach.length === 0 ? { key: 'held.noneToAccept' } : null)
  const count = selected.length
  const bulk = (
    <>
      <Button size="sm" variant="primary" heldReason={say(bulkHeldWords)} onClick={() => actions?.onBulkAccept?.(reach.map((row) => row.id))} aria-label={t('bulk.accept', { count: reach.length, of: count })}>
        <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.accept', { count: reach.length, of: count })}</SelectionLabel>
      </Button>
      <Button size="sm" onClick={() => actions?.onExport?.(selected)} aria-label={t('bulk.export', { count })}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count })}</SelectionLabel>
      </Button>
    </>
  )

  const searching = model.q.trim() !== ''
  const state: ReactNode =
    model.state === 'error' ? (
      <EmptyState title={t('list.failed')} description={t('list.failedBody')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
    ) : rows !== null && rows.length === 0 ? (
      searching ? (
        <EmptyState title={t('list.none')} description={t('list.noMatch', { q: model.q.trim() })} action={<Button size="sm" onClick={() => actions?.onSearch?.('')}>{t('list.clear')}</Button>} />
      ) : (read?.chips ?? []).every((entry) => entry.count === 0) ? (
        <EmptyState icon={<Scissors size={24} aria-hidden />} title={t('list.empty')} description={t('list.emptyBody')} />
      ) : (
        <EmptyState title={t('list.none')} description={t(`list.noneIn.${chip}`)} />
      )
    ) : undefined

  const ownKeys: ListKey[] = [{ keys: ['↵'], does: t('keys.open') }]

  return (
    <div className="fw-pjob">
      {model.offlineSince ? <Banner tone="warning" title={t('offline.since', { time: words.at(model.offlineSince) })}>{t('offline.held')}</Banner> : null}
      {model.notice ? (
        <Banner
          tone={model.notice.tone}
          title={say(model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('notice.hide')}
            </Button>
          }
        />
      ) : null}
      <div className="fw-pjob-chips" role="group" aria-label={t('chips.label')}>
        {read
          ? read.chips.map((entry) => (
              <FilterChip key={entry.chip} pressed={entry.chip === chip} onClick={() => actions?.onChip?.(entry.chip)} aria-label={t('chips.chip', { name: t(`chip.${entry.chip}`), count: entry.count })}>
                {t(`chip.${entry.chip}`)} <span className="fw-pjob-chip-count">{entry.count}</span>
              </FilterChip>
            ))
          : null}
      </div>
      {read && !read.complete ? <Banner tone="info" title={t('list.capped')} /> : null}
      <ListFrame<JobRow>
        label={t('list.label')}
        title={t('list.title')}
        listKey={null}
        rows={model.state === 'error' ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('list.count', { count: rows.length }) : ''}
        search={
          <Input
            type="search"
            aria-label={t('list.search')}
            placeholder={t('list.searchHint')}
            defaultValue={model.q}
            onKeyDown={(event) => {
              if (event.key === 'Enter') actions?.onSearch?.((event.target as HTMLInputElement).value)
              if (event.key === 'Escape' && (event.target as HTMLInputElement).value === '') (event.target as HTMLInputElement).blur()
            }}
            onBlur={(event) => {
              if (event.target.value.trim() !== model.q.trim()) actions?.onSearch?.(event.target.value)
            }}
          />
        }
        selection={{ selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        rowKind="two-line"
        cards={{
          hrefOf: (row) => jobHref(model.prefix, row.id),
          fields: {
            job: { role: 'title', draw: (row) => <span className="fw-pjob-card-title">{row.number} · {operationsOf(row)}</span> },
            style: { role: 'subtitle' },
            progress: { draw: (row) => (
              <span className="fw-pjob-progress">
                <span>{t('card.finishedOf', { done: row.finished, total: row.pieces })}</span>
                <ProgressBar value={row.pieces > 0 ? Math.round((row.finished / row.pieces) * 100) : 0} tone={row.finished >= row.pieces && row.pieces > 0 ? 'complete' : 'partial'} ariaLabel={t('card.finishedOf', { done: row.finished, total: row.pieces })} />
              </span>
            ) },
            status: { role: 'aside' },
            step: { label: '', draw: (row) => <span className="fw-pjob-card-step">{columnsStep(row)}</span> },
          },
        }}
        keysOpen={model.keysOpen}
      />
      {model.accept ? <AcceptDialog model={model.accept} onDraft={actions?.accept?.onDraft} onSend={actions?.accept?.onSend} onDecline={actions?.accept?.onDecline} onClose={actions?.accept?.onClose} /> : null}
      {model.decline ? <DeclineDialog model={model.decline} onDraft={actions?.decline?.onDraft} onSend={actions?.decline?.onSend} onClose={actions?.decline?.onClose} /> : null}
      {model.bulk ? <BulkAcceptDialog model={model.bulk} onSend={actions?.bulk?.onSend} onClose={actions?.bulk?.onClose} /> : null}
    </div>
  )

  function columnsStep(row: JobRow): ReactNode {
    const next = cardStepOf(row, model.prefix)
    if (!next) return <span className="fw-pjob-sub">{t(`next.${row.nextStep}`)}</span>
    if (next.kind === 'accept') {
      return (
        <Button variant="primary" block heldReason={say(personHeld(model.facts, 'accept'))} onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          actions?.onAccept?.(row)
        }}>
          {t(`next.${row.nextStep}`)}
        </Button>
      )
    }
    return (
      <Button asChild variant="primary" block>
        <a href={next.href} onClick={(event) => event.stopPropagation()}>{t(`next.${row.nextStep}`)}</a>
      </Button>
    )
  }
}
