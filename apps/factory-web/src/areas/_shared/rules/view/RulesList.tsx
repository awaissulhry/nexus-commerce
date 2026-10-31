'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Tag, Toggle } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { PanelRead } from '../../../../record-panels/model'
import type { AlertRule, RulesList as RulesAnswer } from '../api'
import { changeHeld, goesToWords, howOften, mainNumber, numbersWords, sentenceOf } from '../model'
import '../rules.css'

export interface RulesListProps {
  readonly rules: PanelRead<RulesAnswer>
  /** Only these (Admin › Reminders & timers: the date rules). */
  readonly only?: (rule: AlertRule) => boolean
  /** The list's own words (`label`, `title`, `empty`): keys of the host's catalogue, already said. */
  readonly words: { readonly label: string; readonly title: string; readonly empty: string; readonly emptyBody: string }
  /** The list's key for its saved views (a second list on the page). */
  readonly listKey: string
  /** Where a rule opens (`?rule=<id>`): a real link, ⌘-click opens it in a new tab. */
  readonly ruleHref: (rule: AlertRule) => string
  readonly offline: boolean
  readonly busy: boolean
  /** Rules whose switch or number is being saved. */
  readonly saving: readonly string[]
  /** Date rules: their waiting timers and the next one (Admin's columns). */
  readonly timers?: boolean
  /** The toolbar's own "Add rule" (false: the page's band has New rule; the empty list still offers it). */
  readonly addButton?: boolean
  onOpen?: (rule: AlertRule) => void
  onNew?: () => void
  onSwitch?: (rule: AlertRule, next: boolean) => void
  onNumber?: (rule: AlertRule, key: string, value: number) => void
  onRetry?: () => void
}

/** A key the cell took for itself (Enter on the switch); printable keys never start an edit (the list's keys). */
const cellKeys = (onEnter?: () => void) => (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key === 'Enter' && onEnter) {
    if (event.type === 'keydown') onEnter()
    return true
  }
  return event.key.length === 1 && event.key !== ' '
}

/**
 * The exception rules as a list (design home.alerts "Rules": "rule sentence, threshold, goes to (role and place: 'Quality
 * at Plant 1'), cooldown, last fired, fired 7 days, state (On/Off)"; admin.automation "Reminders & timers"): the ONE list
 * frame, read only (no bulk action exists for rules), each rule's sentence in the reader's language opening its dialog,
 * its one number edited in place (Enter / double-click; the rule's version as read), its switch. Who may not keep a rule
 * reads it, the switch and the number held with why. A count per rule, never per person.
 */
export function RulesList(props: RulesListProps) {
  const t = useT('rules')
  const locale = useLocale()
  const latest = useRef(props)
  latest.current = props
  const answer = props.rules.status === 'ready' ? props.rules.data : null
  const rows = useMemo(() => (answer ? answer.rules.filter((rule) => (props.only ? props.only(rule) : true)) : []), [answer, props.only])
  const savingKey = props.saving.join(',')

  const columns = useMemo<ColDef<AlertRule>[]>(() => {
    const heldOf = (rule: AlertRule) => {
      const held = changeHeld({ canChange: rule.canChange, offline: latest.current.offline, busy: latest.current.saving.includes(rule.id) })
      return held ? t(held) : null
    }
    const SentenceCell = ({ data }: ICellRendererParams<AlertRule>) =>
      data ? (
        <span className="fw-rules-cell">
          <Link
            className="fw-rules-sentence"
            href={latest.current.ruleHref(data)}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
              event.preventDefault()
              latest.current.onOpen?.(data)
            }}
          >
            {sentenceOf(data, locale)}
          </Link>
          <span className="fw-rules-sub">
            {t(`kind.${data.ruleKind}`)}
            {data.builtIn ? ` · ${t('list.builtIn')}` : ''}
            {data.openAlerts > 0 ? ` · ${t('list.openAlerts', { count: data.openAlerts })}` : ''}
          </span>
        </span>
      ) : null
    const SwitchCell = ({ data }: ICellRendererParams<AlertRule>) => {
      if (!data) return null
      const held = heldOf(data)
      return (
        <span className="fw-rules-switch">
          <Toggle size="xs" checked={data.enabled} disabled={held !== null} title={held ?? undefined} aria-label={t('list.switch', { rule: t(`kind.${data.ruleKind}`) })} onChange={(next) => latest.current.onSwitch?.(data, next)} />
          <Tag tone={data.enabled ? 'success' : 'neutral'}>{t(data.enabled ? 'state.on' : 'state.off')}</Tag>
          {latest.current.saving.includes(data.id) && <span className="fw-rules-sub">{t('held.busy')}</span>}
        </span>
      )
    }
    const number = mainNumber
    const timerColumns: ColDef<AlertRule>[] = props.timers
      ? [
          {
            colId: 'timers',
            headerName: t('list.col.timers'),
            flex: 1.2,
            minWidth: 180,
            valueGetter: (params) => {
              const timers = params.data?.timers
              if (!timers) return '—'
              const waiting = t('list.waiting', { count: timers.pending })
              return timers.nextFireAt ? t('list.waitingNext', { waiting, date: formatDateTime(timers.nextFireAt, { locale }) }) : waiting
            },
          },
        ]
      : []
    return [
      { colId: 'sentence', headerName: t('list.col.sentence'), flex: 3, minWidth: 280, autoHeight: true, wrapText: true, valueGetter: (params) => (params.data ? sentenceOf(params.data, locale) : ''), cellRenderer: SentenceCell, suppressKeyboardEvent: cellKeys() },
      {
        colId: 'threshold',
        headerName: t('list.col.threshold'),
        width: 110,
        minWidth: 100,
        editable: (params) => !!params.data && !!number(params.data.ruleKind) && heldOf(params.data) === null,
        cellEditor: 'agNumberCellEditor',
        cellEditorParams: (params: { data?: AlertRule }) => {
          const field = params.data ? number(params.data.ruleKind) : null
          return { min: field?.min, max: field?.max, precision: 0 }
        },
        valueGetter: (params) => {
          const field = params.data ? number(params.data.ruleKind) : null
          return field && params.data ? Number(params.data.threshold[field.key] ?? 0) : null
        },
        valueFormatter: (params) => (params.data ? numbersWords(params.data.ruleKind, params.data.threshold, t) : ''),
        valueSetter: (params) => {
          const field = params.data ? number(params.data.ruleKind) : null
          const value = typeof params.newValue === 'number' ? params.newValue : Number(params.newValue)
          if (params.data && field && Number.isInteger(value)) latest.current.onNumber?.(params.data, field.key, value)
          return false
        },
        suppressKeyboardEvent: cellKeys(),
      },
      { colId: 'goesTo', headerName: t('list.col.goesTo'), flex: 1.2, minWidth: 160, valueGetter: (params) => (params.data ? goesToWords(params.data, t) : '') },
      { colId: 'cooldown', headerName: t('list.col.cooldown'), flex: 1.2, minWidth: 170, valueGetter: (params) => (params.data ? howOften(params.data.cooldownMinutes, locale) : '') },
      ...timerColumns,
      { colId: 'lastFired', headerName: t('list.col.lastFired'), width: 140, minWidth: 130, valueGetter: (params) => (params.data ? (params.data.lastFiredAt ? formatDateTime(params.data.lastFiredAt, { locale }) : t('list.never')) : '') },
      { colId: 'fired7Days', headerName: t('list.col.fired7Days'), width: 110, minWidth: 100, type: 'rightAligned', valueGetter: (params) => params.data?.fired7Days ?? 0 },
      {
        colId: 'state',
        headerName: t('list.col.state'),
        width: 140,
        minWidth: 130,
        valueGetter: (params) => (params.data ? t(params.data.enabled ? 'state.on' : 'state.off') : ''),
        cellRenderer: SwitchCell,
        suppressKeyboardEvent: (params: { event: KeyboardEvent; editing: boolean; data?: AlertRule }) => cellKeys(() => params.data && heldOf(params.data) === null && latest.current.onSwitch?.(params.data, !params.data.enabled))(params),
      },
    ]
    // The cells read the words, the language, the offline state and what is saving through the closure.
  }, [t, locale, props.timers, props.offline, savingKey])

  const canAdd = answer?.canAdd ?? false
  const addHeld = props.offline ? t('held.offline') : !canAdd ? t('held.noAdd') : null
  const state: ReactNode =
    props.rules.status === 'error' ? (
      <EmptyState title={t(props.rules.problem)} action={props.onRetry ? <Button size="sm" onClick={props.onRetry}>{t('retry')}</Button> : undefined} />
    ) : answer && rows.length === 0 ? (
      <EmptyState
        title={props.words.empty}
        description={props.words.emptyBody}
        action={
          props.onNew && canAdd ? (
            <Button size="sm" variant="primary" heldReason={addHeld} onClick={props.onNew}>
              <Plus size={14} aria-hidden /> {t('list.add')}
            </Button>
          ) : undefined
        }
      />
    ) : undefined

  return (
    <ListFrame<AlertRule>
      label={props.words.label}
      title={props.words.title}
      listKey={props.listKey}
      rows={props.rules.status === 'loading' ? null : rows}
      rowId={(rule) => rule.id}
      columns={columns}
      rowKind="text"
      count={answer ? t('list.count', { count: rows.length }) : '—'}
      right={
        props.onNew && props.addButton !== false ? (
          <Button size="sm" variant="primary" heldReason={addHeld} onClick={props.onNew}>
            <Plus size={14} aria-hidden /> {t('list.add')}
          </Button>
        ) : undefined
      }
      onOpen={(rule) => props.onOpen?.(rule)}
      state={state}
    />
  )
}
