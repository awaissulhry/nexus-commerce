'use client'

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import Link from 'next/link'
import { AlarmClock, AlertTriangle, AtSign, Bell, BellOff, CheckCheck, CheckCircle2, Eye, Info, MailOpen, RotateCcw, Settings2, UserRound } from 'lucide-react'
import { AsOf, Banner, EmptyState, MetricStrip, Modal, type Metric } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { isListKey, listKeys, type ListKey } from '../../../../list-frame/model'
import { WithMessages } from '../../../../record-panels/i18n'
import { SnoozeDialog } from '../../today/view/SnoozeDialog'
import { SNOOZE_MAX_DAYS } from '../../today/snooze'
import {
  NOTIFICATION_TABS,
  pageKey,
  unreadOf,
  whenGroup,
  writeHeld,
  type DigestDraft,
  type NotificationCategory,
  type NotificationRow,
  type NotificationsDialog,
  type NotificationState,
  type NotificationsViewModel,
  type NotificationTab,
} from '../model'
import { sentenceWords } from '../words'
import { DigestDialog } from './DigestDialog'
import '../notifications.css'

export type { NotificationsViewModel } from '../model'

/** What the page asks of its container (Notifications.tsx). Absent in the design index: the view keeps its own state. */
export interface NotificationsActions {
  onTab?: (tab: NotificationTab) => void
  onState?: (state: NotificationState) => void
  onSelect?: (ids: string[]) => void
  /** Enter, the sentence: mark it read and open the record at its place. */
  onOpen?: (row: NotificationRow) => void
  onRetry?: () => void
  onMore?: () => void
  onShowFresh?: () => void
  onRead?: (ids: readonly string[], read: boolean) => Promise<boolean>
  onDone?: (ids: readonly string[]) => Promise<boolean>
  /** The notice's Undo after Done: these notifications back on the list. */
  onUndoDone?: (ids: readonly string[]) => Promise<boolean>
  /** Done view: back on the list. */
  onBack?: (ids: readonly string[]) => Promise<boolean>
  /** Snoozed view: awake now. */
  onWake?: (ids: readonly string[]) => Promise<boolean>
  /** H, Snooze N: the container opens the dialog for these rows (`what` names them). */
  onSnoozeAsk?: (ids: readonly string[], what: string) => void
  onSnooze?: (notificationIds: readonly string[], until: string | null) => Promise<boolean>
  onMute?: (row: NotificationRow) => void
  onAllRead?: () => Promise<boolean>
  onDigest?: () => void
  onRetryDigest?: () => void
  onSaveDigest?: (draft: DigestDraft) => void
  onCloseDialog?: () => void
  onDismissNotice?: () => void
}

/** The design's order of the state switch: To look at · Snoozed · Done. */
const STATE_ORDER: readonly NotificationState[] = ['OPEN', 'SNOOZED', 'DONE']

const ICON: Readonly<Record<NotificationCategory, typeof AtSign>> = { MENTION: AtSign, ASSIGNMENT: UserRound, APPROVAL: CheckCheck, ALERT: AlertTriangle, FOLLOWING: Eye, SYSTEM: Info }

/** The page's own keys, in the list footer's info icon (the frame adds j / k, Enter, x, ⇧-click, ?). */
export function notificationKeys(t: (key: string) => string): ListKey[] {
  return [
    { keys: ['e'], does: t('keys.done') },
    { keys: ['h'], does: t('keys.snooze') },
    { keys: ['m'], does: t('keys.mute') },
    { keys: ['⇧', 'e'], does: t('keys.allRead') },
  ]
}

/**
 * SCR-005 — Home › Notifications (design home.notifications, W2a): the band (when it was read, how many are unread;
 * Preferences = my daily digest, Mark all read), "Which ones" as tiles with their unread counts (All · Mentions ·
 * Assigned to me · Approvals · System), and the list in the shared list frame — each row its sentence in my language
 * (an amount only with its grain), its record as a real link, when (Today · Yesterday · Earlier), unread, snoozed or
 * done, "N together" for notifications of one record that came close together. Keys: Enter opens the record at its
 * place, e done, h snooze, m mute the record, ⇧E mark all read; select several → Mark read N · Done N · Snooze N. Quiet
 * by default: only what names me or what I follow. It draws ONE view model and fetches nothing (Notifications.tsx).
 */
export function NotificationsView({ model, actions }: { model: NotificationsViewModel; actions?: NotificationsActions }) {
  return (
    <WithMessages namespaces={['home-notifications', 'home', 'lists']}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: NotificationsViewModel; actions?: NotificationsActions }) {
  const t = useT('home-notifications')
  const lists = useT('lists')
  const locale = useLocale()
  // Without a container (the design index) the view keeps its own tab, state, selection and dialogs.
  const [ownTab, setOwnTab] = useState(model.tab)
  const [ownState, setOwnState] = useState(model.state)
  const [ownSelected, setOwnSelected] = useState<readonly string[]>(model.selected)
  const [ownDialog, setOwnDialog] = useState<NotificationsDialog | null>(model.dialog)
  const [help, setHelp] = useState(false)
  useEffect(() => setOwnSelected(model.selected), [model.selected])
  useEffect(() => setOwnDialog(model.dialog), [model.dialog])
  const tab = actions?.onTab ? model.tab : ownTab
  const state = actions?.onState ? model.state : ownState
  const selected = actions?.onSelect ? model.selected : ownSelected
  const setSelected = (ids: string[]) => (actions?.onSelect ? actions.onSelect(ids) : setOwnSelected(ids))
  const dialog = actions?.onCloseDialog ? model.dialog : ownDialog
  const closeDialog = () => (actions?.onCloseDialog ? actions.onCloseDialog() : setOwnDialog(null))

  const data = model.list.status === 'ready' ? model.list.data : null
  const rows = useMemo(() => data?.items ?? [], [data])
  const held = writeHeld({ live: model.live, busy: model.busy })
  const heldText = held ? t(held) : null
  const sentence = (row: NotificationRow) => sentenceWords(row, t, locale)

  const askSnooze = (ids: readonly string[]) => {
    const picked = rows.filter((row) => ids.includes(row.id))
    const what = picked.length === 1 ? picked[0]!.record.label : t('snooze.what', { count: picked.length })
    if (actions?.onSnoozeAsk) actions.onSnoozeAsk(ids, what)
    else setOwnDialog({ kind: 'snooze', ids: picked.flatMap((row) => row.group.ids), what })
  }

  // e / h / m on the row the focus is in, ⇧E for the whole tab (never while typing, in a menu or a dialog).
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (event: KeyboardEvent) => {
    if (dialog !== null || help) return
    if (!isListKey(event, event.target as HTMLElement | null)) return
    const wanted = pageKey(event)
    if (wanted === null) return
    if (wanted === 'allRead') {
      if (heldText || (unreadOf(model.counts, tab) ?? 0) === 0) return
      event.preventDefault()
      void actions?.onAllRead?.()
      return
    }
    const id = (document.activeElement as HTMLElement | null)?.closest('[row-id]')?.getAttribute('row-id') ?? null
    const row = id ? rowsRef.current.find((entry) => entry.id === id) : undefined
    if (!row || heldText) return
    event.preventDefault()
    if (wanted === 'done' && state !== 'DONE') void actions?.onDone?.([row.id])
    else if (wanted === 'snooze' && state !== 'DONE') askSnooze([row.id])
    else if (wanted === 'mute') actions?.onMute?.(row)
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyRef.current(event)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const columns = useMemo<ColDef<NotificationRow>[]>(() => {
    const WhatCell = ({ data: row }: ICellRendererParams<NotificationRow>) => {
      if (!row) return null
      const Icon = ICON[row.category]
      const onClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0 || !actions?.onOpen) return
        event.preventDefault()
        actions.onOpen(row)
      }
      return (
        <span className={row.read ? 'fw-ntf-what' : 'fw-ntf-what is-unread'}>
          <Icon size={16} className="fw-ntf-icon" aria-hidden />
          <span className="fw-ntf-what-text">
            <a className="fw-ntf-sentence" href={row.href} onClick={onClick}>
              {!row.read && <span className="fw-ntf-dot" aria-hidden />}
              {sentence(row)}
            </a>
            <span className="fw-ntf-sub">
              {t(`category.${row.category}`)}
              {row.group.count > 1 ? ` · ${t('together', { count: row.group.count })}` : ''}
            </span>
          </span>
        </span>
      )
    }
    const RecordCell = ({ data: row }: ICellRendererParams<NotificationRow>) =>
      row ? (
        <Link className="fw-ntf-record" href={row.recordHref} title={t('openRecord', { record: row.record.label })}>
          {row.record.label}
        </Link>
      ) : null
    const WhenCell = ({ data: row }: ICellRendererParams<NotificationRow>) => {
      if (!row) return null
      const group = whenGroup(row.createdAt, model.now)
      return (
        <span className="fw-ntf-when">
          <span>{t(`when.${group}`)}</span>
          <time className="fw-ntf-sub" dateTime={row.createdAt}>
            {group === 'EARLIER' ? formatDate(row.createdAt, { locale }) : formatTime(row.createdAt, { locale })}
          </time>
        </span>
      )
    }
    const StateCell = ({ data: row }: ICellRendererParams<NotificationRow>) => {
      if (!row) return null
      if (row.state === 'DONE') return <Tag tone="neutral">{row.doneAt ? t('stateWord.doneAt', { at: formatDateTime(row.doneAt, { locale }) }) : t('stateWord.done')}</Tag>
      if (row.state === 'SNOOZED' && row.snoozed) return <Tag tone="neutral">{row.snoozed.until ? t('stateWord.snoozedUntil', { at: formatDateTime(row.snoozed.until, { locale }) }) : t('stateWord.snoozedChange')}</Tag>
      return row.read ? <span className="fw-ntf-sub">{t('stateWord.read')}</span> : <Tag tone="info">{t('stateWord.unread')}</Tag>
    }
    return [
      { colId: 'what', headerName: t('col.what'), flex: 4, minWidth: 300, cellRenderer: WhatCell, valueGetter: (params) => (params.data ? sentence(params.data) : '') },
      { colId: 'record', headerName: t('col.record'), flex: 1, minWidth: 140, cellRenderer: RecordCell, valueGetter: (params) => params.data?.record.label ?? '' },
      { colId: 'when', headerName: t('col.when'), flex: 1, minWidth: 120, cellRenderer: WhenCell, valueGetter: (params) => params.data?.createdAt ?? '' },
      { colId: 'state', headerName: t('col.state'), flex: 1, minWidth: 150, cellRenderer: StateCell, valueGetter: (params) => params.data?.state ?? '' },
    ]
    // The cells read the words, the language, the clock and the opener through the closure: a change rebuilds them.
  }, [t, locale, model.now, actions])

  if (model.access === 'refused') {
    return (
      <div className="fw-ntf">
        <EmptyState icon={<Bell size={24} aria-hidden />} title={t('refused.title')} description={t('refused.body')} />
      </div>
    )
  }

  const unread = unreadOf(model.counts, tab)
  const total = model.counts ? (model.counts.complete ? model.counts.unread : null) : null
  const picked = rows.filter((row) => selected.includes(row.id))
  const count = picked.length

  // ---- the band: when it was read, how many are unread; Preferences and Mark all read -------------------------------------
  const band = (
    <div className="fw-ntf-band" role="group" aria-label={t('band.label')}>
      <div className="fw-ntf-status">
        {data ? <AsOf at={data.asOf} now={model.now} /> : model.list.status === 'loading' ? <span className="fw-ntf-muted">{t('band.reading')}</span> : null}
        <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        <strong aria-live="polite">{model.counts === null ? '—' : total === null ? t('band.unreadMore', { count: model.counts.unread }) : t('band.unread', { count: total })}</strong>
      </div>
      <div className="fw-ntf-actions">
        <Button onClick={() => (actions?.onDigest ? actions.onDigest() : setOwnDialog({ kind: 'digest', digest: { status: 'loading' }, saving: false, problem: null }))}>
          <Settings2 size={14} aria-hidden /> {t('band.preferences')}
        </Button>
        <Button variant="primary" heldReason={heldText ?? (unread === null ? t('held.unknown') : unread === 0 ? t('held.nothingUnread') : null)} onClick={() => void actions?.onAllRead?.()}>
          <MailOpen size={14} aria-hidden /> {t('band.allRead', { tab: t(`tab.${tab}.label`) })}
        </Button>
      </div>
    </div>
  )

  // ---- Which ones: the tabs as tiles with their unread counts ----------------------------------------------------------------
  const tiles: Metric[] = NOTIFICATION_TABS.map((entry) => {
    const value = unreadOf(model.counts, entry)
    return {
      label: t(`tab.${entry}.label`),
      value: value === null ? '—' : t('tiles.unread', { count: value }),
      hint: t(`tab.${entry}.hint`),
      onClick: () => (actions?.onTab ? actions.onTab(entry) : setOwnTab(entry)),
      active: tab === entry,
    }
  })

  // ---- the bulk actions, by the state shown ------------------------------------------------------------------------------------
  const bulk =
    state === 'DONE' ? (
      <Button size="sm" variant="primary" heldReason={heldText} aria-label={t('bulk.back', { count })} onClick={() => void actions?.onBack?.(selected)}>
        <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('bulk.back', { count })}</SelectionLabel>
      </Button>
    ) : (
      <>
        {state === 'OPEN' && (
          <Button size="sm" variant="primary" heldReason={heldText} aria-label={t('bulk.read', { count })} onClick={() => void actions?.onRead?.(selected, true)}>
            <MailOpen size={13} aria-hidden /> <SelectionLabel>{t('bulk.read', { count })}</SelectionLabel>
          </Button>
        )}
        {state === 'SNOOZED' && (
          <Button size="sm" variant="primary" heldReason={heldText} aria-label={t('bulk.wake', { count })} onClick={() => void actions?.onWake?.(selected)}>
            <Bell size={13} aria-hidden /> <SelectionLabel>{t('bulk.wake', { count })}</SelectionLabel>
          </Button>
        )}
        <Button size="sm" heldReason={heldText} aria-label={t('bulk.done', { count })} onClick={() => void actions?.onDone?.(selected)}>
          <CheckCircle2 size={13} aria-hidden /> <SelectionLabel>{t('bulk.done', { count })}</SelectionLabel>
        </Button>
        {state === 'OPEN' && (
          <Button size="sm" heldReason={heldText} aria-label={t('bulk.snooze', { count })} onClick={() => askSnooze(selected)}>
            <AlarmClock size={13} aria-hidden /> <SelectionLabel>{t('bulk.snooze', { count })}</SelectionLabel>
          </Button>
        )}
      </>
    )

  const stateSwitch = (
    <SegmentedControl
      ariaLabel={t('state.label')}
      size="sm"
      wrap
      value={state}
      onChange={(value) => (actions?.onState ? actions.onState(value as NotificationState) : setOwnState(value as NotificationState))}
      options={STATE_ORDER.map((entry) => ({ value: entry, label: t(`state.${entry}`) }))}
    />
  )

  const empty =
    model.list.status === 'error' ? (
      <EmptyState title={t('list.error')} description={t(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
    ) : data && rows.length === 0 ? (
      <EmptyState
        icon={<BellOff size={24} aria-hidden />}
        title={t(state === 'OPEN' ? (tab === 'ALL' ? 'empty.title' : 'empty.tabTitle') : `empty.${state}.title`, { tab: t(`tab.${tab}.label`) })}
        description={t(state === 'OPEN' ? 'empty.body' : `empty.${state}.body`)}
      />
    ) : undefined

  const snoozeDialog = dialog?.kind === 'snooze' ? dialog : null
  const digestDialog = dialog?.kind === 'digest' ? dialog : null

  return (
    <div className="fw-ntf">
      {band}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <span className="fw-ntf-buttons">
              {model.notice.undo && (
                <Button size="sm" onClick={() => model.notice?.undo && void actions?.onUndoDone?.(model.notice.undo.ids)}>
                  <RotateCcw size={13} aria-hidden /> {t('undo')}
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
      {model.live === 'offline' && <Banner tone="warning" title={t('offline.title')}>{t('offline.body')}</Banner>}
      <section className="fw-ntf-section" aria-labelledby="fw-ntf-tabs">
        <h2 id="fw-ntf-tabs" className="fw-ntf-h">
          {t('tabs.title')}
        </h2>
        <MetricStrip metrics={tiles} minTileWidth={160} />
      </section>
      <section className="fw-ntf-section" aria-labelledby="fw-ntf-list">
        <h2 id="fw-ntf-list" className="fw-ntf-h">
          {t('list.title')}
        </h2>
        <ListFrame<NotificationRow>
          label={t('list.label', { tab: t(`tab.${tab}.label`) })}
          title={t('list.title')}
          rows={model.list.status === 'loading' ? null : rows}
          rowId={(row) => row.id}
          columns={columns}
          count={data ? t('count', { count: rows.length }) : '—'}
          right={stateSwitch}
          selection={{ selected, onChange: setSelected, actions: bulk }}
          updates={data && data.fresh > 0 ? { count: data.fresh, onShow: () => actions?.onShowFresh?.() } : null}
          more={data?.more ? { label: t(data.loadingMore ? 'list.loadingMore' : 'list.more'), onMore: () => actions?.onMore?.(), held: data.loadingMore ? t('list.loadingMore') : null } : null}
          keys={notificationKeys(t)}
          onHelp={() => setHelp(true)}
          onOpen={(row) => actions?.onOpen?.(row)}
          state={empty}
          focusRow={model.focusRow}
          keysOpen={model.keysOpen}
        />
      </section>
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('keysTitle')} size="sm">
          <ul className="fw-ntf-keys">
            {listKeys(notificationKeys(t), true).map((entry) => (
              <li key={entry.keys.join('+')}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
      {snoozeDialog && (
        <SnoozeDialog
          what={snoozeDialog.what}
          now={model.now}
          untilChange
          maxDays={SNOOZE_MAX_DAYS.notification}
          held={heldText}
          onSnooze={(until) => (actions?.onSnooze ? actions.onSnooze(snoozeDialog.ids, until) : closeDialog())}
          onClose={closeDialog}
        />
      )}
      {digestDialog && (
        <DigestDialog
          digest={digestDialog.digest}
          saving={digestDialog.saving}
          problem={digestDialog.problem}
          held={model.live === 'offline' ? 'held.offline' : null}
          onSave={(draft) => (actions?.onSaveDigest ? actions.onSaveDigest(draft) : closeDialog())}
          onRetry={() => actions?.onRetryDigest?.()}
          onClose={closeDialog}
        />
      )}
    </div>
  )
}
