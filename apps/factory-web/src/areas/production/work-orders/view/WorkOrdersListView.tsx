'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, MoreHorizontal, PauseCircle, Plus, Rocket, Search, XCircle } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, Modal, ProgressBar } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { WorkOrderRow } from '../../_shared/api'
import { LIST_VIEWS, percentOf, progressPhrase, STATUS_TONE, TILES, type ListView } from '../../_shared/model'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import type { ListEdit, ListQuick } from '../../../../list-frame/w2b/model'
import type { WorkOrdersListActions, WorkOrdersListModel } from '../list-model'
import { NewWorkOrderDialog } from './NewWorkOrderDialog'
import { bulkHoldHeld, DAILY_NAMESPACE, HOLDABLE } from '../daily/model'
import { HoldDialog } from '../daily/view/DailyDialogs'
import { ReadinessPill, say } from '../daily/view/DailyParts'
import '../../_shared/production.css'

export type { WorkOrdersListActions, WorkOrdersListModel } from '../list-model'

/**
 * SCR-069 — Work orders (Production; design production.workorders, 00 §2.1 list frame): the tiles (each a saved view),
 * the shared list frame (search by number, batch or style; Rows ▾ views; select-all, shift range, x; Export N, Edit N
 * and Release N while rows are selected; live changes behind "N updates · Show"; B-W2b-13: Table · Board · Calendar ·
 * Cards, the due quick filter, the due date and priority edited in the grid), each number a real link to the work order
 * studio, progress from the floor (cut / bundled / sewn / finished), due dates with days late, and the New work order
 * dialog (`c`). Totals per work order only: no person's output anywhere (Statuto dei Lavoratori art. 4). No money.
 */
export function WorkOrdersListView({ model, actions }: { model: WorkOrdersListModel; actions?: WorkOrdersListActions }) {
  return (
    <WithMessages namespaces={['production', DAILY_NAMESPACE, 'lists']}>
      <WorkOrdersList model={model} actions={actions} />
    </WithMessages>
  )
}

const RELEASABLE = 'DRAFT'

function WorkOrdersList({ model, actions }: { model: WorkOrdersListModel; actions?: WorkOrdersListActions }) {
  const t = useT('production')
  const lists = useT('lists')
  const locale = useLocale()
  const [query, setQuery] = useState(model.q)
  useEffect(() => setQuery(model.q), [model.q])
  const typed = useRef(false)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onSearch?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  // c: a new work order (00 §3.17) — never while typing or inside a dialog. The list frame keeps / j k x Enter ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.newOrder || model.release || help) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        actions?.onNew?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const notDraft = picked.filter((row) => row.status !== RELEASABLE).length
  // B-W2a-46: the readiness word column, Hold N (wo-grid "'Hold' (W2a)"), notices of either catalogue.
  const tw = useT(DAILY_NAMESPACE)
  const notices = useScopedT('production')
  const readiness = model.readiness ?? null
  const daily = model.daily ?? null
  const holdWait = daily ? say(tw, bulkHoldHeld(picked, daily.can)) : null
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('list.keyNew') }]

  const columns = useMemo<ColDef<WorkOrderRow>[]>(() => {
    const href = (row: WorkOrderRow) => `${model.prefix}/production/work-orders/${row.id}`
    const NumberCell = ({ data }: ICellRendererParams<WorkOrderRow>) =>
      data ? (
        <span className="fw-pr-cell">
          <Link className="fw-pr-link" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-pr-cell-sub">{data.batchNumber ? t('list.batch', { batch: data.batchNumber }) : t('list.noBatch')}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<WorkOrderRow>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill> : null)
    const StyleCell = ({ data }: ICellRendererParams<WorkOrderRow>) =>
      data ? (
        <span className="fw-pr-cell">
          <span className="fw-pr-ellipsis">
            {data.styleCode}
            {data.revision !== null ? ` · ${t('list.rev', { revision: data.revision })}` : ''}
          </span>
          <span className="fw-pr-cell-sub">
            {data.styleName} · {data.colourways.join(', ')}
          </span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<WorkOrderRow>) =>
      data ? (
        <span className="fw-pr-cell">
          <span className="fw-pr-ellipsis">{[...new Set(data.orders.map((order) => order.partyName))].join(', ') || '—'}</span>
          <span className="fw-pr-cell-sub">{data.orders.map((order) => order.number).join(' · ')}</span>
        </span>
      ) : null
    const ProgressCell = ({ data }: ICellRendererParams<WorkOrderRow>) => {
      if (!data) return null
      const words = progressPhrase(data)
      const finished = data.progress ? percentOf(data.progress.finished ?? 0, data.pieces) : null
      return (
        <span className="fw-pr-progress">
          <ProgressBar value={data.status === 'DRAFT' ? null : finished} ariaLabel={t('list.progressLabel', { number: data.number })} height={6} />
          <span className="fw-pr-cell-sub">{t(words.key, words.params)}</span>
        </span>
      )
    }
    const DueCell = ({ data }: ICellRendererParams<WorkOrderRow>) =>
      data ? (
        data.dueDate ? (
          <span className="fw-pr-inline">
            {formatDate(`${data.dueDate}T12:00:00Z`, { locale })}
            {data.daysLate !== null && data.daysLate > 0 && <Tag tone="danger">{t('list.daysLate', { count: data.daysLate })}</Tag>}
          </span>
        ) : (
          <span>—</span>
        )
      ) : null
    const ReadinessCell = ({ data }: ICellRendererParams<WorkOrderRow>) => {
      if (!data) return null
      const row = readiness?.[data.id]
      return row ? <ReadinessPill word={row.word} date={row.date} /> : <span>—</span>
    }
    const MoreCell = ({ data }: ICellRendererParams<WorkOrderRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('list.open'), href: href(data) },
            { id: 'tab', label: t('list.openNewTab'), href: href(data), target: '_blank' },
            { id: 'cutting', label: t('tab.cutting'), href: `${href(data)}?tab=cutting` },
            { id: 'bundles', label: t('tab.bundles'), href: `${href(data)}?tab=bundles` },
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('col.number'), field: 'number', minWidth: 130, flex: 1, cellRenderer: NumberCell },
      { colId: 'status', headerName: t('col.status'), field: 'status', minWidth: 120, flex: 0.8, cellRenderer: StatusCell },
      { colId: 'style', headerName: t('col.style'), field: 'styleCode', minWidth: 180, flex: 1.5, cellRenderer: StyleCell },
      { colId: 'customer', headerName: t('col.customer'), minWidth: 160, flex: 1.4, cellRenderer: CustomerCell },
      { colId: 'pieces', headerName: t('col.pieces'), field: 'pieces', minWidth: 76, flex: 0.5, type: 'rightAligned' },
      { colId: 'progress', headerName: t('col.progress'), minWidth: 160, flex: 1.3, cellRenderer: ProgressCell },
      { colId: 'readiness', headerName: tw('readiness.column'), minWidth: 130, flex: 0.9, cellRenderer: ReadinessCell },
      { colId: 'due', headerName: t('col.due'), field: 'dueDate', minWidth: 132, flex: 0.9, cellRenderer: DueCell },
      { colId: 'priority', headerName: t('col.priority'), field: 'priority', minWidth: 84, flex: 0.5, type: 'rightAligned' },
      { colId: 'site', headerName: t('col.site'), field: 'siteCode', minWidth: 80, flex: 0.5 },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, tw, locale, model.prefix, readiness])

  // B-W2b-13 — the W2b list frame: board by state, calendar by due date, cards, the due quick filter, inline and bulk edit.
  const final = (row: WorkOrderRow) => (row.status === 'CLOSED' || row.status === 'CANCELLED' ? t('w2b.heldFinal') : null)
  const edit: ListEdit<WorkOrderRow> = {
    fields: {
      due: { kind: 'date', nullable: true, valueOf: (row) => row.dueDate, held: final },
      priority: { kind: 'integer', min: -1000, max: 1000, valueOf: (row) => row.priority, held: final },
    },
    versionOf: (row) => row.version,
    labelOf: (row) => row.number,
    onSaved: (id, after, version) => actions?.onSaved?.(id, after, version),
    bulk: { noun: { one: t('w2b.noun_one'), other: t('w2b.noun_other') } },
    held: model.can.manage ? null : t('held.noManage'),
  }
  const quick: ListQuick = {
    filters: [{ id: 'due', kind: 'date', label: t('w2b.quickDue'), choices: ['overdue', 'today', 'this-week', 'next-week', 'next-7-days', 'this-month'] }],
    values: { due: model.due ?? null },
    onChange: (_, value) => actions?.onDue?.(value as never),
  }
  const laneTotal = (status: WorkOrderRow['status']): number | null => {
    const counts = model.counts
    if (!counts) return null
    return status === 'DRAFT' ? counts.draft : status === 'RELEASED' ? counts.released : status === 'IN_PROGRESS' ? counts.inProgress : status === 'COMPLETED' ? counts.completed : status === 'ON_HOLD' ? (counts.onHold ?? null) : null
  }
  const shownStatuses = WORK_ORDER_STATUSES.filter((status) => model.view === 'all' || (items ?? []).some((row) => row.status === status) || ['DRAFT', 'RELEASED', 'IN_PROGRESS'].includes(status))

  const filtered = model.view !== 'all' || model.q.trim() !== ''
  const state = model.rows.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    model.q.trim() !== '' || !!model.due || (model.view !== 'all' && model.view !== 'open') ? (
      <EmptyState
        title={t('list.noMatch.title')}
        description={t('list.noMatch.body')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              actions?.onSearch?.('')
              actions?.onDue?.(null)
              actions?.onView?.('all')
            }}
          >
            {t('list.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        title={t('list.empty.title')}
        description={t(model.can.manage ? 'list.empty.body' : 'list.empty.bodyView')}
        action={
          model.can.manage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onNew?.(true)}>
              {t('list.new')}
            </Button>
          ) : undefined
        }
      />
    )
  ) : undefined

  const tileView = (TILES.find((tile) => tile.view === model.view)?.view ?? null) as ListView | null

  return (
    <div className="fw-pr">
      <div className="fw-pr-head">
        <div className="fw-pr-head-text">
          <span className="fw-pr-status" role="status">
            {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
            {' · '}
            {t(`live.${model.live}`)}
          </span>
        </div>
        <Button size="sm" variant="primary" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onNew?.(true)} aria-keyshortcuts="c">
          <Plus size={14} aria-hidden /> {t('list.new')}
        </Button>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={notices(model.notice.words.key, model.notice.words.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      <MetricStrip
        metrics={TILES.map((tile) => ({
          label: t(`tile.${tile.id}`),
          value: model.counts ? String(tile.count(model.counts)) : '—',
          onClick: () => actions?.onView?.(model.view === tile.view ? 'open' : tile.view),
          active: tileView === tile.view,
        }))}
      />

      <ListFrame<WorkOrderRow>
        label={t('list.tableLabel')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: items.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <Select size="sm" aria-label={t('list.viewLabel')} value={model.view} onChange={(event) => actions?.onView?.(event.target.value as ListView)}>
            {LIST_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`view.${view}`)}
              </option>
            ))}
          </Select>
        }
        selection={{
          selected,
          onChange: setSelected,
          exportSelected: true,
          actions: (
            <>
              {daily && (
                <Button
                  size="sm"
                  aria-label={tw('bulk.hold', { count: picked.length })}
                  heldReason={holdWait}
                  onClick={() => {
                    const open = picked.filter((row) => HOLDABLE.includes(row.status))
                    actions?.daily?.onDialog?.({ kind: 'hold', workOrderIds: open.map((row) => row.id), numbers: open.map((row) => row.number) })
                  }}
                >
                  <PauseCircle size={13} aria-hidden /> <SelectionLabel>{tw('bulk.hold', { count: picked.length })}</SelectionLabel>
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                aria-label={t('bulk.release', { count: picked.length })}
                heldReason={!model.can.release ? t('held.noRelease') : notDraft > 0 ? t('bulk.releaseHeld', { count: notDraft }) : null}
                onClick={() => actions?.onReleaseMany?.(picked.map((row) => row.id))}
              >
                <Rocket size={13} aria-hidden /> <SelectionLabel>{t('bulk.release', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
        modes={{
          mode: model.mode ?? 'table',
          onMode: (next) => actions?.onMode?.(next),
          board: {
            lanes: shownStatuses.map((status) => ({ id: status, label: t(`status.${status}`), total: laneTotal(status), tone: STATUS_TONE[status] === 'neutral' ? undefined : STATUS_TONE[status] })),
            laneOf: (row) => row.status,
            card: (row) => ({ title: `${row.styleCode} · ${row.styleName}`, fields: [{ label: t('col.pieces'), value: String(row.pieces) }, ...(row.dueDate ? [{ label: t('col.due'), value: formatDate(`${row.dueDate}T12:00:00Z`, { locale }) }] : [])], marks: row.daysLate ? [{ label: t('list.daysLate', { count: row.daysLate }), tone: 'danger' as const }] : [] }),
            heldReason: t('w2b.boardHeld'),
          },
          calendar: { dateOf: (row) => row.dueDate, label: t('w2b.dueDate'), field: 'due' },
        }}
        cards={{ hrefOf: (row) => `${model.prefix}/production/work-orders/${row.id}` }}
        edit={edit}
        quick={quick}
        {...(model.today ? { today: model.today } : {})}
      />
      {filtered && model.view !== 'open' && <p className="fw-pr-hint">{t('list.viewing', { view: t(`view.${model.view}`) })}</p>}

      {model.newOrder && <NewWorkOrderDialog model={model.newOrder} can={model.can} actions={actions} />}
      {model.release && <BulkReleaseDialog model={model} actions={actions} onDone={() => setSelected([])} />}
      {daily?.dialog?.kind === 'hold' && <HoldDialog numbers={daily.dialog.numbers} workOrderIds={daily.dialog.workOrderIds} daily={daily} actions={actions?.daily} />}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('list.keysTitle')} size="sm">
          <ul className="fw-pr-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}

/** Release N: a confirm with what it does, then each work order's answer (released with its batch, or what holds it). */
function BulkReleaseDialog({ model, actions, onDone }: { model: WorkOrdersListModel; actions?: WorkOrdersListActions; onDone: () => void }) {
  const t = useT('production')
  const release = model.release!
  const released = release.rows.filter((row) => release.results[row.id]?.state === 'released').length
  return (
    <Modal
      open
      onClose={() => {
        if (release.done) onDone()
        actions?.onCloseRelease?.()
      }}
      title={t('bulk.releaseTitle', { count: release.rows.length })}
      size="md"
      footer={
        release.done ? (
          <>
            <span className="grow" />
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onDone()
                actions?.onCloseRelease?.()
              }}
            >
              {t('common.done')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onCloseRelease?.()} heldReason={release.running ? t('held.busy') : null}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={release.running ? t('held.busy') : null} onClick={() => actions?.onRunRelease?.()}>
              {release.running ? <Spinner size={12} /> : <Rocket size={13} aria-hidden />} {t('bulk.releaseRun', { count: release.rows.length })}
            </Button>
          </>
        )
      }
    >
      <div className="fw-pr-dialog">
        <p className="fw-pr-hint">{release.done ? t('bulk.releaseDone', { released, count: release.rows.length }) : t('bulk.releaseBody')}</p>
        <ul className="fw-pr-checks" aria-live="polite">
          {release.rows.map((row) => {
            const result = release.results[row.id]
            return (
              <li key={row.id} className="fw-pr-check">
                {result?.state === 'released' ? (
                  <CheckCircle2 size={16} className="fw-pr-ico is-ok" aria-hidden />
                ) : result ? (
                  <XCircle size={16} className="fw-pr-ico is-blocked" aria-hidden />
                ) : (
                  <Rocket size={16} className="fw-pr-ico" aria-hidden />
                )}
                <span className="fw-pr-check-body">
                  <b>
                    {row.number} · {row.styleCode}
                  </b>
                  {result?.state === 'released' && <span>{t('bulk.released', { batch: result.batchNumber ?? '—' })}</span>}
                  {result?.state === 'held' && <span>{t('bulk.held', { checks: result.codes.map((code) => t(`check.name.${code}`)).join(', ') || t('check.name.other') })}</span>}
                  {result?.state === 'failed' && <span>{t(result.words.key, result.words.params)}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </Modal>
  )
}
