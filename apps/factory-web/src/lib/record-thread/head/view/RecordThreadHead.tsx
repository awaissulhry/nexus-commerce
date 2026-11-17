'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { BadgeCheck, ChevronDown, Columns2, Filter, Handshake, ListChecks, Lock, MoreHorizontal, Users, WifiOff, X } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Pill, Tooltip } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../i18n/format'
import { useLocale, useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { CountPopover } from '../../popups/view/CountPopover'
import type { CountKind } from '../../popups/model'
import { DOCK_WIDTHS, menuRows, waitWords, type DockWidth, type HeadDoor, type HeadModel, type ThreadView } from '../model'
import '../head.css'

export const HEAD_NS = 'record-thread-head'

export interface HeadActions {
  /** An R-ACT door: the container opens the EXISTING dialog of record-panels (TaskNewDialog, AskDialog, InviteDialog, the Followers popover, RemindMeDialog) or follows / mutes. */
  onDoor?: (door: HeadDoor) => void
  onView?: (view: ThreadView) => void
  /** A width, 'hide' (⌘J) or 'reset' (back to 40 %). */
  onWidth?: (width: DockWidth | 'hide' | 'reset') => void
  onPrint?: () => void
  /** "Close thread…": the container opens "Close thread?" (popups/Confirms). */
  onCloseThread?: () => void
  onReopen?: () => void
}

/** The door a count popover's one action opens. */
const COUNT_DOOR: Readonly<Record<CountKind, HeadDoor>> = { tasks: 'task', approvals: 'approve', partners: 'share', followers: 'followers' }
const COUNT_ICON: Readonly<Record<CountKind, ReactNode>> = {
  tasks: <ListChecks size={14} aria-hidden />,
  approvals: <BadgeCheck size={14} aria-hidden />,
  partners: <Handshake size={14} aria-hidden />,
  followers: <Users size={14} aria-hidden />,
}
const COUNT_ORDER: readonly CountKind[] = ['tasks', 'approvals', 'partners', 'followers']
/** Below this width the count chips fold into the "⋯" (their counts go on the doors' lines). */
const FOLD_BELOW = 560

/**
 * The thread's Head (B-TH-209, T1; picture 7 drawn to the approved pictures' look): ONE 44 px row at ~438 and ~718 px —
 * who must answer next and how long they wait (the last shared message, in clock time), the closed or offline state, a chip
 * naming the View when it is not All, the count chips when not zero (each one popover, one action), View ▾, the width menu,
 * and the "⋯" that ALWAYS holds Activity's doors (R-ACT), held with the reason when the person cannot use one; "Close
 * thread…" only with threads.manage. The phone head: the record and the pill, the rest in the "⋯". Draws one view model,
 * fetches nothing; the container (B-TH-300) loads it and opens the existing dialogs.
 */
export function RecordThreadHead({ model, actions }: { model: HeadModel; actions?: HeadActions }) {
  return (
    <WithMessages namespaces={[HEAD_NS]}>
      <Head model={model} actions={actions} />
    </WithMessages>
  )
}

function Head({ model, actions }: { model: HeadModel; actions?: HeadActions | undefined }) {
  const t = useT(HEAD_NS)
  const locale = useLocale()
  const place = { locale, ...(model.timeZone ? { timeZone: model.timeZone } : {}) }
  const tipId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const [folded, setFolded] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setFolded((entry?.contentRect.width ?? 1000) < FOLD_BELOW))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const compact = model.compact ?? false
  const role = model.party?.role ?? 'customer'
  const words = (row: { key: string; params?: Readonly<Record<string, string | number>> }) => t(row.key, dated(row.params, place))

  const viewWord = (view: ThreadView) => (view === 'shared' ? t(`view.shared.${role}`) : t(`view.${view}`))
  const viewItems: MenuItemDef[] = model.views.map((view) => ({ id: view, label: viewWord(view), checked: view === model.view, onSelect: () => actions?.onView?.(view) }))
  const widthItems: MenuItemDef[] = [
    ...DOCK_WIDTHS.map((width) => ({ id: width, label: t(`width.${width}`), checked: width === model.width, onSelect: () => actions?.onWidth?.(width) })),
    { id: 'sep', separator: true },
    { id: 'hide', label: t('width.hide'), onSelect: () => actions?.onWidth?.('hide') },
    { id: 'reset', label: t('width.reset'), onSelect: () => actions?.onWidth?.('reset') },
  ]
  const rows = menuRows(model, folded || compact)
  const moreItems: MenuItemDef[] = []
  let section: string | null = null
  for (const row of rows) {
    const group = row.kind === 'door' ? 'doors' : row.kind === 'view' ? 'views' : 'end'
    if (section !== null && section !== group) moreItems.push({ id: `sep-${group}`, separator: true })
    if (group === 'views' && section !== 'views') moreItems.push({ id: 'views-heading', heading: true, label: t('view.label') })
    section = group
    if (row.kind === 'door') {
      moreItems.push({
        id: row.door,
        label: words(row.label),
        disabled: row.held !== null,
        ...(row.held ? { description: words(row.held) } : row.hint ? { description: words(row.hint) } : {}),
        onSelect: () => actions?.onDoor?.(row.door),
      })
    } else if (row.kind === 'view') {
      moreItems.push({ id: `view-${row.view}`, label: viewWord(row.view), checked: row.checked, onSelect: () => actions?.onView?.(row.view) })
    } else if (row.kind === 'print') {
      moreItems.push({ id: 'print', label: t('act.print'), onSelect: () => actions?.onPrint?.() })
    } else if (row.kind === 'close') {
      moreItems.push({ id: 'close', label: t('act.close'), description: t('act.closeHint'), tone: 'danger', onSelect: () => actions?.onCloseThread?.() })
    } else {
      moreItems.push({ id: 'reopen', label: t('act.reopen'), onSelect: () => actions?.onReopen?.() })
    }
  }

  const wait = model.answers ? waitWords(model.answers.since, model.now) : null
  const pillWords = model.answers && wait ? (model.answers.on === 'us' ? t('answers.us', { wait: t(wait.key, { n: wait.n }) }) : t(`answers.${role}`, { wait: t(wait.key, { n: wait.n }) })) : null
  const tip = model.answers
    ? t(model.answers.on === 'us' ? 'answers.tipUs' : 'answers.tipParty', { party: model.party?.name ?? '', when: `${formatDate(model.answers.since, place)} ${formatTime(model.answers.since, place)}` })
    : null

  return (
    <div ref={ref} className={`fw-rth${compact ? ' is-compact' : ''}`} role="group" aria-label={t('label', { record: model.record })}>
      {compact && <span className="fw-rth-title">{model.record}</span>}
      {model.closed ? (
        <span className="fw-rth-closed">
          <Lock size={14} aria-hidden />
          <span>{model.closed.by ? t('closed.by', { name: model.closed.by, date: formatDate(model.closed.at, place) }) : t('closed.noName', { date: formatDate(model.closed.at, place) })}</span>
          {model.canManage && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onReopen?.()}>
              {t('act.reopen')}
            </Button>
          )}
        </span>
      ) : pillWords && tip ? (
        <Tooltip label={tip} portal>
          <span className="fw-rth-pillwrap" tabIndex={0} aria-describedby={tipId}>
            <Pill tone="neutral" truncate>
              {pillWords}
            </Pill>
            <span id={tipId} className="nds-vh">
              {tip}
            </span>
          </span>
        </Tooltip>
      ) : null}
      {model.offline && (
        <Pill tone="warning" icon={<WifiOff size={12} aria-hidden />}>
          {t('offline', { time: formatTime(model.offline.asOf, place) })}
        </Pill>
      )}
      {!compact && model.view !== 'all' && (
        <button type="button" className="fw-rth-viewchip" onClick={() => actions?.onView?.('all')} aria-label={t('view.clear', { view: viewWord(model.view) })}>
          {viewWord(model.view)} <X size={12} aria-hidden />
        </button>
      )}
      {!compact && !folded && (
        <span className="fw-rth-counts">
          {COUNT_ORDER.map((kind) => {
            const count = model.counts[kind]
            if (!count || count.count <= 0) return null
            const held = model.holds[COUNT_DOOR[kind]]
            return (
              <CountPopover
                key={kind}
                model={{ ...count, held: held ? words(held) : null }}
                trigger={
                  <span className="fw-rth-count">
                    {COUNT_ICON[kind]} {count.count > 99 ? '99+' : count.count}
                  </span>
                }
                triggerLabel={t(`count.${kind}`, { count: count.count })}
                onAction={() => actions?.onDoor?.(COUNT_DOOR[kind])}
              />
            )
          })}
        </span>
      )}
      <span className="fw-rth-grow" />
      {!compact && model.views.length > 1 && (
        <Menu
          align="right"
          className="fw-rth-menu"
          label={
            <>
              <Filter size={14} aria-hidden /> {t('view.label')} <ChevronDown size={14} aria-hidden />
            </>
          }
          items={viewItems}
          triggerProps={{ className: 'nds-btn sm', 'aria-label': t('view.menu') }}
        />
      )}
      {!compact && model.width !== null && (
        <Menu align="right" className="fw-rth-menu" label={<Columns2 size={16} aria-hidden />} items={widthItems} triggerProps={{ className: 'nds-btn sm icon', 'aria-label': t('width.label') }} />
      )}
      <Menu align="right" className="fw-rth-menu" label={<MoreHorizontal size={16} aria-hidden />} items={moreItems} triggerProps={{ className: 'nds-btn sm icon', 'aria-label': t('more.label') }} />
    </div>
  )
}

/** A `{at}` value (an instant) said as a day in the page's language; other values as they are. */
function dated(params: Readonly<Record<string, string | number>> | undefined, place: { locale: 'it' | 'en'; timeZone?: string }): Record<string, string | number> | undefined {
  if (!params) return undefined
  const out: Record<string, string | number> = { ...params }
  if (typeof out.at === 'string') out.at = formatDate(out.at, place)
  return out
}
