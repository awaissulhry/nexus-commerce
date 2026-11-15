'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlarmClock, Check, ExternalLink, MessageSquare, MoreHorizontal, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { Banner, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { inView, REMINDER_LIMITS, type ReminderView } from '@nexus/factory-domain/reminders/rules'
import { AsOf } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../record-panels/i18n'
import { whenWords } from '../../../../../shell/panels/remind-me/model'
import { SnoozeDialog } from '../../../today/view/SnoozeDialog'
import { doneable, viewCount, VIEWS, type ReminderRow, type RemindersModel } from '../model'
import '../reminders.css'

export interface RemindersActions {
  onView?: (view: ReminderView) => void
  onSelect?: (ids: string[]) => void
  onDone?: (row: ReminderRow) => void
  onUndo?: (row: ReminderRow) => void
  onRemove?: (row: ReminderRow) => void
  onPutOff?: (row: ReminderRow | null) => void
  /** Put off to a moment, or (null) until its record changes; resolves true when done. */
  onPutOffTo?: (row: ReminderRow, until: string | null) => Promise<boolean>
  onBulkDone?: () => void
  onBulkRemove?: () => void
  onUndoLast?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

const STATE_TONE = { WAITING: 'neutral', CAME_BACK: 'info', DONE: 'success' } as const

/**
 * Home › My tasks › Reminders (design home.tasks section reminders, W2b; COL-041): the records and messages I asked to see again,
 * on the shared list frame — the record (a real link), my note, when it comes back (or that it came back, or when it was done),
 * whether it is about a message; ⋯ Done · Snooze (put off) · Remove, Undo on a done one; select several for Done N · Remove N.
 * Open · Back · Waiting · Done as a segmented choice with counts. It draws ONE model.
 */
export function RemindersView({ model, actions }: { model: RemindersModel; actions?: RemindersActions }) {
  return (
    <WithMessages namespaces={['home-mywork', 'lists']}>
      <Reminders model={model} actions={actions} />
    </WithMessages>
  )
}

function Reminders({ model, actions }: { model: RemindersModel; actions?: RemindersActions }) {
  const t = useT('home-mywork')
  const locale = useLocale()
  const [ownView, setOwnView] = useState<ReminderView>(model.view)
  const [ownSelected, setOwnSelected] = useState<readonly string[]>(model.selected)
  const [ownPutOff, setOwnPutOff] = useState<string | null>(model.putOff)
  useEffect(() => setOwnPutOff(model.putOff), [model.putOff])
  const view = actions?.onView ? model.view : ownView
  const selected = actions?.onSelect ? model.selected : ownSelected
  const putOffId = actions?.onPutOff ? model.putOff : ownPutOff
  const held = model.held ? t(model.held) : null
  const list = model.list.status === 'ready' ? model.list.data : null
  // The container reads one list; the design index filters its made-up rows here (factory-domain's own rule).
  const rows = useMemo(() => (list ? (actions?.onView ? list.rows : list.rows.filter((row) => inView(row, view))) : []), [list, view, actions?.onView])
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const heldRef = useRef(held)
  heldRef.current = held
  const putOff = (row: ReminderRow | null) => (actions?.onPutOff ? actions.onPutOff(row) : setOwnPutOff(row?.id ?? null))
  const putOffRef = useRef(putOff)
  putOffRef.current = putOff

  const columns = useMemo<ColDef<ReminderRow>[]>(() => {
    const RecordCell = ({ data }: ICellRendererParams<ReminderRow>) =>
      data ? (
        <a className="fw-rem-record" href={data.href} title={t('reminders.open', { record: data.record.label })}>
          {data.record.label} <ExternalLink size={12} aria-hidden />
        </a>
      ) : null
    const NoteCell = ({ data }: ICellRendererParams<ReminderRow>) =>
      data ? (
        <span className="fw-rem-note">
          {data.messageId && (
            <span className="fw-rem-muted">
              <MessageSquare size={12} aria-hidden /> {t('set.message')}
            </span>
          )}
          <span>{data.note ?? t('reminders.noNote')}</span>
        </span>
      ) : null
    const WhenCell = ({ data }: ICellRendererParams<ReminderRow>) => {
      if (!data) return null
      const when = whenWords(data)
      return (
        <span className="fw-rem-when">
          {data.kind === 'ON_CHANGE' && data.state === 'WAITING' ? <RefreshCw size={12} aria-hidden /> : <AlarmClock size={12} aria-hidden />} {t(when.key, { at: when.at ? formatDateTime(when.at, { locale }) : '' })}
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<ReminderRow>) => (data ? <Tag tone={STATE_TONE[data.state]}>{t(`reminders.state.${data.state}`)}</Tag> : null)
    const ActionsCell = ({ data }: ICellRendererParams<ReminderRow>) => {
      if (!data) return null
      const hold = heldRef.current
      const item = (id: string, label: string, icon: ReactNode, run: () => void) => (hold ? { id, label, icon, disabled: true, description: hold } : { id, label, icon, onSelect: run })
      const items =
        data.state === 'DONE'
          ? [item('undo', t('reminders.undo'), <RotateCcw size={14} aria-hidden />, () => actionsRef.current?.onUndo?.(data)), item('remove', t('reminders.remove'), <Trash2 size={14} aria-hidden />, () => actionsRef.current?.onRemove?.(data))]
          : [
              item('done', t('reminders.done'), <Check size={14} aria-hidden />, () => actionsRef.current?.onDone?.(data)),
              item('putoff', t('reminders.putOff'), <AlarmClock size={14} aria-hidden />, () => putOffRef.current(data)),
              item('remove', t('reminders.remove'), <Trash2 size={14} aria-hidden />, () => actionsRef.current?.onRemove?.(data)),
            ]
      return <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('reminders.menu', { record: data.record.label }) }} items={items} />
    }
    return [
      { colId: 'record', headerName: t('reminders.col.record'), flex: 1, minWidth: 150, valueGetter: (params) => params.data?.record.label ?? '', cellRenderer: RecordCell },
      { colId: 'note', headerName: t('reminders.col.note'), flex: 2, minWidth: 220, valueGetter: (params) => params.data?.note ?? '', cellRenderer: NoteCell },
      { colId: 'when', headerName: t('reminders.col.when'), flex: 1, minWidth: 200, valueGetter: (params) => params.data?.cameBackAt ?? params.data?.remindAt ?? '', cellRenderer: WhenCell },
      { colId: 'state', headerName: t('reminders.col.state'), width: 130, valueGetter: (params) => (params.data ? t(`reminders.state.${params.data.state}`) : ''), cellRenderer: StateCell },
      { colId: 'actions', headerName: '', width: 64, maxWidth: 72, pinned: 'right', sortable: false, cellRenderer: ActionsCell },
    ]
    // The cells read the words and the language through the closure; the actions, the hold and Snooze through refs.
  }, [t, locale])

  const picked = doneable(rows, selected)
  const putOffRow = putOffId ? (rows.find((row) => row.id === putOffId) ?? null) : null
  const counts = list?.counts ?? null

  return (
    <section className="fw-rem" aria-labelledby="fw-rem-title">
      <div className="fw-rem-head">
        <h2 id="fw-rem-title" className="fw-rem-h">
          {t('reminders.title')}
        </h2>
        {list && <AsOf at={list.asOf} now={model.now} />}
      </div>
      <p className="fw-rem-muted">{t('reminders.hint')}</p>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <span className="fw-rem-actions">
              {model.notice.undo && (
                <Button size="sm" variant="secondary" heldReason={held} onClick={() => actions?.onUndoLast?.()}>
                  <RotateCcw size={13} aria-hidden /> {t('reminders.undo')}
                </Button>
              )}
              {actions?.onDismissNotice && (
                <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                  {t('dismiss')}
                </Button>
              )}
            </span>
          }
        />
      )}
      <SegmentedControl
        ariaLabel={t('reminders.views')}
        size="sm"
        wrap
        value={view}
        onChange={(value) => (actions?.onView ? actions.onView(value as ReminderView) : setOwnView(value as ReminderView))}
        options={VIEWS.map((entry) => ({ value: entry, label: counts ? t('reminders.view.count', { view: t(`reminders.view.${entry}`), count: viewCount(entry, counts) }) : t(`reminders.view.${entry}`) }))}
      />
      <ListFrame<ReminderRow>
        label={t('reminders.title')}
        title={t('reminders.title')}
        rows={model.list.status === 'loading' ? null : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={list ? t('reminders.countRows', { count: rows.length }) : '—'}
        selection={{
          selected,
          onChange: (ids) => (actions?.onSelect ? actions.onSelect(ids) : setOwnSelected(ids)),
          actions: (
            <>
              <Button size="sm" variant="primary" aria-label={t('reminders.bulk.done', { count: picked.length })} heldReason={held ?? (picked.length === 0 ? t('reminders.held.noneOpen') : null)} onClick={() => actions?.onBulkDone?.()}>
                <Check size={13} aria-hidden /> <SelectionLabel>{t('reminders.bulk.done', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('reminders.bulk.remove', { count: selected.length })} heldReason={held ?? (selected.length > REMINDER_LIMITS.bulk ? t('reminders.held.tooMany', { count: REMINDER_LIMITS.bulk }) : null)} onClick={() => actions?.onBulkRemove?.()}>
                <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('reminders.bulk.remove', { count: selected.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        keys={[{ keys: ['e'], does: t('reminders.keys.done') }, { keys: ['h'], does: t('reminders.keys.putOff') }]}
        onOpen={(row) => window.location.assign(row.href)}
        state={
          model.list.status === 'error' ? (
            <EmptyState title={t('reminders.error')} description={t(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
          ) : list && rows.length === 0 ? (
            <EmptyState icon={<AlarmClock size={22} aria-hidden />} title={t(view === 'DONE' ? 'reminders.empty.done' : 'reminders.empty.title')} description={t('reminders.empty.body')} />
          ) : undefined
        }
        cards={{ hrefOf: (row) => row.href }}
      />
      {putOffRow && (
        <SnoozeDialog
          what={putOffRow.record.label}
          now={model.now}
          untilChange
          untilChangeLabel={t('remind.onChange')}
          maxDays={REMINDER_LIMITS.maxDays}
          held={held}
          onSnooze={async (until) => (actions?.onPutOffTo ? actions.onPutOffTo(putOffRow, until) : true)}
          onClose={() => putOff(null)}
        />
      )}
      <ReminderKeys rows={rows} held={held} onDone={(row) => actions?.onDone?.(row)} onPutOff={putOff} />
    </section>
  )
}

/** e finishes the focused row, h puts it off (never in a field, a menu or a dialog). */
function ReminderKeys({ rows, held, onDone, onPutOff }: { rows: readonly ReminderRow[]; held: string | null; onDone: (row: ReminderRow) => void; onPutOff: (row: ReminderRow) => void }) {
  const latest = useRef({ rows, held, onDone, onPutOff })
  latest.current = { rows, held, onDone, onPutOff }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'e' && event.key !== 'h')) return
      const target = event.target as HTMLElement | null
      if (!target || target.closest('input, textarea, select, [role="dialog"], [role="menu"]')) return
      const id = target.closest('.fw-rem [row-id]')?.getAttribute('row-id')
      const row = id ? latest.current.rows.find((entry) => entry.id === id) : undefined
      if (!row || row.state === 'DONE' || latest.current.held) return
      event.preventDefault()
      if (event.key === 'e') latest.current.onDone(row)
      else latest.current.onPutOff(row)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return null
}
