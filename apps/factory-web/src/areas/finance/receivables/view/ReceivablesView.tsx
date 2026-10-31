'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { BellRing, CheckCheck, Download, MoreHorizontal, Printer, Search, X } from 'lucide-react'
import { Banner, DateField, EmptyState, Menu, MetricStrip, Modal, type Metric } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { LiveState } from '../../_shared/hooks'
import { type Ageing, type AgeingRow, type Reminder, type ReminderCounts, type ReceivablesSettings, type ReminderView } from '../api'
import {
  bulkApprovePhrase,
  latePhrase,
  moneyText,
  RECEIVABLES_NAMESPACE,
  reminderSelectable,
  rowStatement,
  statementKey,
  stepPhrase,
  tileAmount,
  tileFilter,
  TILE_IDS,
  type CsvWords,
  type Phrase,
  type ReceivablesAddress,
  type ReceivablesCan,
  type StatementRef,
} from '../model'
import { AgeBar, dayText } from './parts'
import { ReminderDialog, type ReminderDialogState } from './ReminderDialog'
import { StatementDialog, type StatementState } from './StatementDialog'
import '../receivables.css'

export interface Notice {
  readonly tone: 'danger' | 'info' | 'success' | 'warning'
  readonly words: Phrase
  /** Per row (a bulk approval's refusals): the customer and the reason. */
  readonly items?: readonly { readonly name: string; readonly words: Phrase }[]
}

/** SCR-151 — Receivables & credit's view model (the view draws it and fetches nothing). */
export interface ReceivablesModel {
  readonly prefix: string
  readonly can: ReceivablesCan
  readonly today: string
  readonly address: ReceivablesAddress
  /** The ageing of the address: tiles and the first page (null while it reads). */
  readonly ageing: {
    readonly value: Ageing | null
    readonly problem: string | null
    readonly slow: boolean
  }
  /** Every customer row read so far (Show more appends). */
  readonly rows: readonly AgeingRow[] | null
  readonly more: boolean
  readonly readAt: number | null
  readonly live: LiveState
  readonly updates: number
  readonly counts: ReminderCounts | null
  readonly reminders: {
    readonly value: readonly Reminder[] | null
    readonly problem: string | null
    readonly more: boolean
  }
  /** The company's reminder switch (null while it reads or when it cannot be read). */
  readonly settings: ReceivablesSettings | null
  readonly statement: StatementState | null
  readonly reminder: ReminderDialogState | null
  readonly busy: boolean
  readonly notice: Notice | null
  /** Design cases: the rows selected in each list, the focused row, the keys panel. */
  readonly selected?: readonly string[]
  readonly selectedReminders?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface ReceivablesActions {
  onAddress?: (next: Partial<ReceivablesAddress>) => void
  onSearch?: (text: string) => void
  onRetry?: (part: 'ageing' | 'reminders' | 'statement' | 'reminder') => void
  onMore?: () => void
  onMoreReminders?: () => void
  onShowUpdates?: () => void
  onExport?: (rows: readonly AgeingRow[], words: CsvWords, fileName: string) => void
  onPrint?: (refs: readonly StatementRef[], period?: { from: string | null; to: string | null }) => void
  onPeriod?: (period: { from: string | null; to: string | null }) => void
  onSendStatement?: (message: string) => Promise<boolean>
  onApproveMany?: (reminders: readonly Reminder[]) => Promise<boolean>
  onApprove?: (
    reminder: Reminder,
    input: {
      send: boolean
      subject?: string
      body?: string
      callNote?: string
    },
  ) => Promise<boolean>
  onSend?: (reminder: Reminder, callNote?: string) => Promise<boolean>
  onEdit?: (reminder: Reminder, input: { subject?: string; body?: string; language?: 'it' | 'en' }) => Promise<boolean>
  onSkip?: (reminder: Reminder, reason: string) => Promise<boolean>
  onCancel?: (reminder: Reminder, reason: string) => Promise<boolean>
  onDismissNotice?: () => void
}

/**
 * SCR-151 — Finance › Receivables & credit (design finance.receivables; FIN-109, FIN-110, FIN-111): the band (as of
 * which day, read at, live; "Reminders to approve (n)" brings the reminders into view; ⋯ Export this view, Print
 * statements), What customers owe (Open · Overdue · 0–30 · 31–60 · 61–90 · Over 90 days per currency; each tile filters
 * the table), By customer (each customer's balance split by age with the AgeBar, oldest due, last payment, reminders
 * sent; a row opens the statement DetailModal with J / K; selected rows: Print N statements, Export N), and Reminders to
 * approve (what the ladder prepared, the level, the action, the warnings; Approve and send n while the Owner's switch
 * is on, else Approve n and they wait; A approves the focused one; a row opens the reminder). Amounts and the
 * reminders' text only with the price grain. Credit limits are W2b and not drawn.
 */
export function ReceivablesView({ model, actions }: { model: ReceivablesModel; actions?: ReceivablesActions }) {
  return (
    <WithMessages namespaces={[RECEIVABLES_NAMESPACE, 'lists']}>
      <ReceivablesPageView model={model} actions={actions} />
    </WithMessages>
  )
}

const REMINDER_VIEW_ORDER: readonly ReminderView[] = ['toApprove', 'waiting', 'sent', 'closed', 'all']

function ReceivablesPageView({ model, actions }: { model: ReceivablesModel; actions?: ReceivablesActions }) {
  const t = useT(RECEIVABLES_NAMESPACE)
  const lists = useT('lists')
  const locale = useLocale()
  const [selectedOwn, setSelected] = useState<string[]>([])
  const [pickedOwn, setPicked] = useState<string[]>([])
  const [help, setHelp] = useState(false)
  const [typed, setTyped] = useState<string | null>(null)
  const selected = model.selected ? [...model.selected] : selectedOwn
  const pickedIds = model.selectedReminders ? [...model.selectedReminders] : pickedOwn
  const can = model.can
  const rows = model.rows
  const ageing = model.ageing.value
  const reminders = model.reminders.value
  const switchedOn = model.settings?.switch.on ?? false
  const say = (phrase: Phrase) => t(phrase.key, phrase.params)
  const rowKey = (row: AgeingRow) => statementKey(rowStatement(row))

  // A: approve the focused reminder (in the reminders list, not typing, no dialog open).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'a' || event.metaKey || event.ctrlKey || event.altKey || model.reminder || model.statement) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      const section = document.getElementById('reminders')
      const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[row-id]')
      if (!section || !row || !section.contains(row)) return
      const reminder = reminders?.find((entry) => entry.id === row.getAttribute('row-id'))
      if (!reminder || reminderSelectable(reminder, can) !== null) return
      event.preventDefault()
      void actions?.onApprove?.(reminder, {
        send: switchedOn && reminder.action !== 'CALL',
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const columns = useMemo<ColDef<AgeingRow>[]>(() => {
    const CustomerCell = ({ data }: ICellRendererParams<AgeingRow>) =>
      data ? (
        <span className="fw-frv-cell">
          <Link
            className="fw-frv-link fw-frv-ellipsis"
            href={`${model.prefix}/finance/receivables?statement=${encodeURIComponent(data.customer.id)}&company=${encodeURIComponent(data.company.id)}&currency=${data.currency}`}
            tabIndex={-1}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
              event.preventDefault()
              actions?.onAddress?.({
                statement: data.customer.id,
                company: data.company.id,
                currency: data.currency,
              })
            }}
          >
            {data.customer.name}
          </Link>
          <span className="fw-frv-cell-sub">
            {data.customer.code} · {data.company.code}
          </span>
        </span>
      ) : null
    const money = (pick: (row: AgeingRow) => number | undefined, tone?: (row: AgeingRow) => string) =>
      function MoneyCell({ data }: ICellRendererParams<AgeingRow>) {
        return data ? <span className={`fw-frv-num${tone ? ` fw-frv-tone ${tone(data)}` : ''}`}>{moneyText(pick(data) ?? null, data.currency, locale)}</span> : null
      }
    const BarCell = ({ data }: ICellRendererParams<AgeingRow>) => (data ? <AgeBar buckets={data.buckets} currency={data.currency} /> : null)
    const OldestCell = ({ data }: ICellRendererParams<AgeingRow>) =>
      data ? (
        <span className="fw-frv-cell">
          <span>{dayText(data.oldestDueDate, locale)}</span>
          <span className={`fw-frv-cell-sub${data.daysLate && data.daysLate > 0 ? ' fw-frv-tone is-danger' : ''}`}>{say(latePhrase(data.daysLate, data.oldestDueDate))}</span>
        </span>
      ) : null
    const PaymentCell = ({ data }: ICellRendererParams<AgeingRow>) => (data ? <span>{data.lastPaymentOn ? dayText(data.lastPaymentOn, locale) : t('row.noPayment')}</span> : null)
    const RemindersCell = ({ data }: ICellRendererParams<AgeingRow>) =>
      data ? (
        <span className="fw-frv-cell">
          <span>{t('row.remindersSent', { count: data.remindersSent })}</span>
          <span className="fw-frv-cell-sub">
            {data.remindersWaiting > 0
              ? t('row.remindersWaiting', { count: data.remindersWaiting })
              : data.lastReminderAt
                ? t('row.lastReminder', {
                    date: formatDate(data.lastReminderAt, { locale }),
                  })
                : t('row.invoices', { count: data.invoices })}
          </span>
        </span>
      ) : null
    return [
      {
        colId: 'customer',
        headerName: t('col.customer'),
        minWidth: 200,
        flex: 1.5,
        cellRenderer: CustomerCell,
      },
      ...(can.price
        ? [
            {
              colId: 'open',
              headerName: t('col.open'),
              minWidth: 120,
              flex: 0.8,
              type: 'rightAligned',
              cellRenderer: money((row) => row.open),
            } satisfies ColDef<AgeingRow>,
            {
              colId: 'overdue',
              headerName: t('col.overdue'),
              minWidth: 120,
              flex: 0.8,
              type: 'rightAligned',
              cellRenderer: money(
                (row) => row.overdue,
                (row) => ((row.overdue ?? 0) > 0 ? 'is-danger' : ''),
              ),
            } satisfies ColDef<AgeingRow>,
            {
              colId: 'buckets',
              headerName: t('col.buckets'),
              minWidth: 170,
              flex: 1.2,
              cellRenderer: BarCell,
            } satisfies ColDef<AgeingRow>,
          ]
        : []),
      {
        colId: 'oldest',
        headerName: t('col.oldest'),
        minWidth: 140,
        flex: 0.9,
        cellRenderer: OldestCell,
      },
      {
        colId: 'payment',
        headerName: t('col.lastPayment'),
        minWidth: 130,
        flex: 0.8,
        cellRenderer: PaymentCell,
      },
      {
        colId: 'reminders',
        headerName: t('col.reminders'),
        minWidth: 150,
        flex: 0.9,
        cellRenderer: RemindersCell,
      },
    ]
  }, [t, locale, model.prefix, can.price, actions])

  const reminderColumns = useMemo<ColDef<Reminder>[]>(() => {
    const CustomerCell = ({ data }: ICellRendererParams<Reminder>) =>
      data ? (
        <span className="fw-frv-cell">
          <Link
            className="fw-frv-link fw-frv-ellipsis"
            href={`${model.prefix}/finance/receivables?reminder=${encodeURIComponent(data.id)}`}
            tabIndex={-1}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
              event.preventDefault()
              actions?.onAddress?.({ reminder: data.id })
            }}
          >
            {data.customer.name}
          </Link>
          <span className="fw-frv-cell-sub">{data.byHand ? t('reminder.byHand') : t('reminder.byLadder')}</span>
        </span>
      ) : null
    const InvoicesCell = ({ data }: ICellRendererParams<Reminder>) =>
      data ? (
        <span className="fw-frv-cell">
          <span className="fw-frv-ellipsis">{data.invoices.map((invoice) => invoice.number ?? t('reminder.draftInvoice')).join(', ')}</span>
          <span className="fw-frv-cell-sub">
            {t('reminder.oldestDue', {
              date: dayText(data.oldestDueDate, locale),
            })}
          </span>
        </span>
      ) : null
    const LevelCell = ({ data }: ICellRendererParams<Reminder>) =>
      data ? (
        <span className="fw-frv-cell">
          <span>{say(stepPhrase(data))}</span>
          <span className="fw-frv-cell-sub">{t('reminder.level', { level: data.level })}</span>
        </span>
      ) : null
    const ActionCell = ({ data }: ICellRendererParams<Reminder>) =>
      data ? (
        <span className="fw-frv-inline">
          <Tag tone="neutral">{t(`action.${data.action}`)}</Tag>
          <span className="fw-frv-cell-sub">{t(`language.${data.language.startsWith('it') ? 'it' : 'en'}`)}</span>
        </span>
      ) : null
    const AmountCell = ({ data }: ICellRendererParams<Reminder>) => (data ? <span className="fw-frv-num">{moneyText(data.amountDue ?? null, data.currency, locale)}</span> : null)
    const PreviewCell = ({ data }: ICellRendererParams<Reminder>) =>
      data ? <span className="fw-frv-ellipsis">{data.text?.subject ?? t(data.action === 'CALL' ? 'reminder.call' : 'reminder.noText')}</span> : null
    const StateCell = ({ data }: ICellRendererParams<Reminder>) =>
      data ? (
        <span className="fw-frv-inline">
          <Pill tone={data.status === 'SENT' ? 'success' : data.status === 'PREPARED' ? 'info' : data.status === 'APPROVED' ? 'warning' : 'neutral'}>{t(`status.${data.status}`)}</Pill>
          {data.held.length > 0 && (
            <span className="fw-frv-cell-sub fw-frv-tone is-warning" title={data.held.map((entry) => t(`heldReason.${entry.code}`)).join(' · ')}>
              {t('reminder.warnings', { count: data.held.length })}
            </span>
          )}
        </span>
      ) : null
    return [
      {
        colId: 'customer',
        headerName: t('col.customer'),
        minWidth: 190,
        flex: 1.3,
        cellRenderer: CustomerCell,
      },
      {
        colId: 'invoices',
        headerName: t('col.invoices'),
        minWidth: 170,
        flex: 1.1,
        cellRenderer: InvoicesCell,
      },
      {
        colId: 'level',
        headerName: t('col.level'),
        minWidth: 150,
        flex: 0.9,
        cellRenderer: LevelCell,
      },
      {
        colId: 'action',
        headerName: t('col.action'),
        minWidth: 150,
        flex: 0.8,
        cellRenderer: ActionCell,
      },
      ...(can.price
        ? [
            {
              colId: 'amount',
              headerName: t('col.amount'),
              minWidth: 120,
              flex: 0.7,
              type: 'rightAligned',
              cellRenderer: AmountCell,
            } satisfies ColDef<Reminder>,
            {
              colId: 'preview',
              headerName: t('col.preview'),
              minWidth: 200,
              flex: 1.4,
              cellRenderer: PreviewCell,
            } satisfies ColDef<Reminder>,
          ]
        : []),
      {
        colId: 'state',
        headerName: t('col.state'),
        minWidth: 150,
        flex: 0.9,
        cellRenderer: StateCell,
      },
    ]
  }, [t, locale, model.prefix, can.price, actions])

  if (!can.view) {
    return (
      <div className="fw-frv">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body', { permission: 'receivables.view' })} />
      </div>
    )
  }

  const tiles = ageing?.tiles ?? []
  const picked = (rows ?? []).filter((row) => selected.includes(rowKey(row)))
  const pickedReminders = (reminders ?? []).filter((reminder) => pickedIds.includes(reminder.id))
  const filtered = model.address.bucket !== null || model.address.party !== null || model.address.q !== null
  const csvWords: CsvWords = { header: (column) => t(`csv.${column}`) }
  const fileName = `${t('csv.file', { day: model.address.asOf ?? model.today })}.csv`
  const ownKeys: ListKey[] = [
    { keys: ['/'], does: t('keys.search') },
    { keys: ['Enter'], does: t('keys.statement') },
  ]
  const reminderKeys: ListKey[] = [
    { keys: ['a'], does: t('keys.approve') },
    { keys: ['Enter'], does: t('keys.reminder') },
  ]
  const toApprove = model.counts?.toApprove ?? null
  const printHeld = !can.price ? t('held.price', { permission: 'money.price' }) : picked.length === 0 ? t('held.pickToPrint') : picked.length > 10 ? t('held.printMax', { count: 10 }) : null

  const focusReminders = () => {
    actions?.onAddress?.({ reminders: 'toApprove' })
    const section = document.getElementById('reminders')
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    section?.focus({ preventScroll: true })
  }

  /** One currency's tiles; `zero`: read, and nobody owes anything (0, never '—'); no tile and not read: '—'. */
  const tileMetrics = (tile: (typeof tiles)[number] | null, zero = false): Metric[] =>
    TILE_IDS.map((id) => {
      const amount = tileAmount(tile, id)
      const filter = tileFilter(id)
      const value = zero ? (can.price || id === 'OPEN' ? '0' : '—') : !tile ? '—' : can.price ? moneyText(amount, tile.currency, locale) : id === 'OPEN' ? String(tile.customers) : '—'
      const hint =
        id === 'OPEN'
          ? tile
            ? `${t('tiles.customers', { count: tile.customers })} · ${t('tiles.invoices', { count: tile.invoices })}`
            : t('tiles.reading')
          : id === 'OVERDUE'
            ? t('tiles.overdueHint')
            : can.price && tile?.buckets
              ? t('tiles.bucketHint')
              : t('tiles.priceHint')
      return {
        label: t(`tile.${id}`),
        value,
        hint,
        onClick: () =>
          actions?.onAddress?.({
            bucket: model.address.bucket === filter ? null : filter,
          }),
        active: model.address.bucket === filter,
      }
    })

  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('list.search')}
      placeholder={t('list.search')}
      value={typed ?? model.address.q ?? ''}
      onChange={(event) => {
        setTyped(event.target.value)
        actions?.onSearch?.(event.target.value)
      }}
    />
  )
  const partyName = model.address.party ? ((rows ?? []).find((row) => row.customer.id === model.address.party)?.customer.name ?? t('filter.customer')) : null
  const chips =
    model.address.bucket || partyName ? (
      <span className="fw-frv-inline">
        {partyName && (
          <FilterChip pressed onClick={() => actions?.onAddress?.({ party: null })} aria-label={t('filter.clear', { name: partyName })}>
            {partyName} <X size={12} aria-hidden />
          </FilterChip>
        )}
        {model.address.bucket && (
          <FilterChip pressed onClick={() => actions?.onAddress?.({ bucket: null })} aria-label={t('filter.clear', { name: t(`tile.${model.address.bucket}`) })}>
            {t(`tile.${model.address.bucket}`)} <X size={12} aria-hidden />
          </FilterChip>
        )}
      </span>
    ) : undefined
  const clear = (
    <Button
      size="sm"
      onClick={() => {
        setTyped(null)
        actions?.onAddress?.({ bucket: null, party: null, q: null })
      }}
    >
      {t('list.clearFilters')}
    </Button>
  )
  const state = model.ageing.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={t(model.ageing.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.('ageing')}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows && rows.length === 0 ? (
    filtered ? (
      <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={clear} />
    ) : (
      <EmptyState title={t('list.empty.title')} description={t('list.empty.body')} />
    )
  ) : undefined
  const reminderState = model.reminders.problem ? (
    <EmptyState
      title={t('reminders.failed')}
      description={t(model.reminders.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.('reminders')}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : reminders && reminders.length === 0 ? (
    <EmptyState title={t(`reminders.empty.${model.address.reminders}`)} description={t('reminders.emptyBody')} />
  ) : undefined
  const bulkWords = bulkApprovePhrase(pickedReminders.length, switchedOn)
  const ids = (rows ?? []).map(rowKey)

  return (
    <div className="fw-frv">
      <div className="fw-frv-band" role="group" aria-label={t('band.label')}>
        <span className="fw-frv-inline">
          <span className="fw-frv-muted">{t('band.asOf')}</span>
          <span className="fw-frv-date">
            <DateField
              value={model.address.asOf ?? model.today}
              max={model.today}
              locale={locale === 'it' ? 'it-IT' : 'en-GB'}
              ariaLabel={t('band.asOfLabel')}
              placeholder={t('band.today')}
              clearLabel={t('band.clear')}
              onChange={(value) =>
                actions?.onAddress?.({
                  asOf: value && value !== model.today ? value : null,
                })
              }
            />
          </span>
          {model.readAt !== null ? <span className="fw-frv-muted">{t('band.readAt', { time: formatTime(model.readAt, { locale }) })}</span> : <span className="fw-frv-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </span>
        <span className="fw-frv-inline">
          <Button size="sm" variant="primary" onClick={focusReminders} aria-label={toApprove === null ? t('band.remindersUnknown') : t('band.reminders', { count: toApprove })}>
            <BellRing size={13} aria-hidden /> {toApprove === null ? t('band.remindersUnknown') : t('band.reminders', { count: toApprove })}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              {
                id: 'export',
                label: t('band.export'),
                onSelect: () => rows && actions?.onExport?.(rows, csvWords, fileName),
                ...(rows && rows.length > 0 ? {} : { disabled: true, description: t('band.exportHeld') }),
              },
              {
                id: 'print',
                label: t('band.print'),
                onSelect: () => actions?.onPrint?.(picked.map(rowStatement)),
                ...(printHeld ? { disabled: true, description: printHeld } : {}),
              },
            ]}
          />
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        >
          {model.notice.items && model.notice.items.length > 0 && (
            <ul className="fw-frv-muted">
              {model.notice.items.map((item, index) => (
                <li key={`${item.name}-${index}`}>
                  <b>{item.name}</b> — {say(item.words)}
                </li>
              ))}
            </ul>
          )}
        </Banner>
      )}

      <section className="fw-frv-section" aria-labelledby="fw-frv-tiles">
        <h2 id="fw-frv-tiles" className="fw-frv-h2">
          {t('tiles.title')}
        </h2>
        {model.ageing.problem && !ageing ? (
          <EmptyState
            title={t('tiles.failed')}
            description={t(model.ageing.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.('ageing')}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : (
          <div className="fw-frv-tiles">
            {(tiles.length > 0 ? tiles : [null]).map((tile, index) => (
              <div key={tile?.currency ?? `none-${index}`} className="fw-frv-section">
                {tiles.length > 1 && tile && <h3 className="fw-frv-h3">{t('tiles.currency', { currency: tile.currency })}</h3>}
                <MetricStrip metrics={tileMetrics(tile, ageing !== null && tiles.length === 0)} minTileWidth={150} />
              </div>
            ))}
            {!can.price && <p className="fw-frv-muted">{t('tiles.noPrice', { permission: 'money.price' })}</p>}
          </div>
        )}
      </section>

      <section className="fw-frv-section" aria-labelledby="fw-frv-ageing">
        <div className="fw-frv-section-head">
          <h2 id="fw-frv-ageing" className="fw-frv-h2">
            {t('list.title')}
          </h2>
          <span className="fw-frv-muted">{t('list.hint')}</span>
        </div>
        {model.ageing.slow && !rows && !model.ageing.problem && (
          <p className="fw-frv-muted" role="status">
            {t('list.slow')}
          </p>
        )}
        <ListFrame<AgeingRow>
          label={t('list.title')}
          title={t('list.fileTitle')}
          rows={state ? [] : rows}
          rowId={rowKey}
          columns={columns}
          count={rows ? t('list.count', { count: ageing?.count ?? rows.length }) : '—'}
          search={search}
          tools={chips}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <>
                <Button size="sm" variant="primary" heldReason={printHeld} aria-label={t('bulk.print', { count: picked.length })} onClick={() => actions?.onPrint?.(picked.map(rowStatement))}>
                  <Printer size={13} aria-hidden /> <SelectionLabel>{t('bulk.print', { count: picked.length })}</SelectionLabel>
                </Button>
                <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked, csvWords, fileName)}>
                  <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
                </Button>
              </>
            ),
          }}
          updates={
            model.updates > 0
              ? {
                  count: model.updates,
                  onShow: () => actions?.onShowUpdates?.(),
                }
              : null
          }
          more={model.more ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          onOpen={(row) =>
            actions?.onAddress?.({
              statement: row.customer.id,
              company: row.company.id,
              currency: row.currency,
            })
          }
          state={state}
          focusRow={model.focusRow}
          keysOpen={model.keysOpen}
        />
        <p className="fw-frv-muted">{t('list.creditLater')}</p>
      </section>

      <section id="reminders" tabIndex={-1} className="fw-frv-section" aria-labelledby="fw-frv-reminders">
        <div className="fw-frv-section-head">
          <h2 id="fw-frv-reminders" className="fw-frv-h2">
            {t('reminders.title')}
          </h2>
          <SegmentedControl
            size="sm"
            wrap
            ariaLabel={t('reminders.viewLabel')}
            value={model.address.reminders}
            onChange={(value) => actions?.onAddress?.({ reminders: value as ReminderView })}
            options={REMINDER_VIEW_ORDER.map((view) => ({
              value: view,
              label: viewLabel(view, model.counts, t),
            }))}
          />
        </div>
        {model.settings && !model.settings.switch.on && (
          <Banner tone="info" title={t('switch.offTitle')}>
            {t('switch.offBody')} {model.settings.switch.blockers.map((blocker) => t(`switch.blocker.${blocker.code}`)).join(' ')}
          </Banner>
        )}
        {model.settings?.switch.on && <p className="fw-frv-muted">{t('switch.onBody')}</p>}
        <p className="fw-frv-muted">{t('reminders.wording')}</p>
        <ListFrame<Reminder>
          label={t('reminders.title')}
          title={t('reminders.title')}
          listKey="finance.receivables.2"
          rows={reminderState ? [] : reminders}
          rowId={(reminder) => reminder.id}
          columns={reminderColumns}
          count={reminders ? t('reminders.count', { count: reminders.length }) : '—'}
          selection={{
            selected: pickedIds,
            onChange: setPicked,
            actions: (
              <Button
                size="sm"
                variant="primary"
                heldReason={
                  model.busy
                    ? t('held.busy')
                    : !can.approve
                      ? t('held.approve', {
                          permission: 'receivables.reminders.approve',
                        })
                      : pickedReminders.length > 50
                        ? t('held.bulkMax', { count: 50 })
                        : switchedOn && pickedReminders.some((reminder) => reminder.action === 'CALL')
                          ? t('held.callInBulk')
                          : null
                }
                aria-label={say(bulkWords)}
                onClick={async () => {
                  if (await actions?.onApproveMany?.(pickedReminders)) setPicked([])
                }}
              >
                <CheckCheck size={13} aria-hidden /> <SelectionLabel>{say(bulkWords)}</SelectionLabel>
              </Button>
            ),
          }}
          isRowSelectable={(reminder) => {
            const held = reminderSelectable(reminder, can)
            return held ? say(held) : null
          }}
          more={
            model.reminders.more
              ? {
                  label: t('list.more'),
                  onMore: () => actions?.onMoreReminders?.(),
                }
              : null
          }
          keys={reminderKeys}
          onHelp={() => setHelp(true)}
          onOpen={(reminder) => actions?.onAddress?.({ reminder: reminder.id })}
          state={reminderState}
        />
      </section>

      {model.statement && (
        <StatementDialog
          state={model.statement}
          ids={ids}
          can={can}
          prefix={model.prefix}
          busy={model.busy}
          onGo={(key) => {
            const row = (rows ?? []).find((entry) => rowKey(entry) === key)
            if (row)
              actions?.onAddress?.({
                statement: row.customer.id,
                company: row.company.id,
                currency: row.currency,
              })
          }}
          onClose={() =>
            actions?.onAddress?.({
              statement: null,
              company: null,
              currency: null,
            })
          }
          onRetry={() => actions?.onRetry?.('statement')}
          onPeriod={(period) => actions?.onPeriod?.(period)}
          onPrint={(ref, period) => actions?.onPrint?.([ref], period)}
          onSend={(message) => actions?.onSendStatement?.(message) ?? Promise.resolve(false)}
          onCurrency={(currency) => actions?.onAddress?.({ currency })}
        />
      )}

      {model.reminder && (
        <ReminderDialog
          state={model.reminder}
          ids={(reminders ?? []).map((reminder) => reminder.id)}
          can={can}
          switchedOn={switchedOn}
          prefix={model.prefix}
          busy={model.busy}
          onGo={(id) => actions?.onAddress?.({ reminder: id })}
          onClose={() => actions?.onAddress?.({ reminder: null })}
          onRetry={() => actions?.onRetry?.('reminder')}
          onApprove={(reminder, input) => actions?.onApprove?.(reminder, input) ?? Promise.resolve(false)}
          onSend={(reminder, callNote) => actions?.onSend?.(reminder, callNote) ?? Promise.resolve(false)}
          onEdit={(reminder, input) => actions?.onEdit?.(reminder, input) ?? Promise.resolve(false)}
          onSkip={(reminder, reason) => actions?.onSkip?.(reminder, reason) ?? Promise.resolve(false)}
          onCancel={(reminder, reason) => actions?.onCancel?.(reminder, reason) ?? Promise.resolve(false)}
        />
      )}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('keys.title')} size="sm">
          <ul className="fw-frv-muted">
            {listKeys([...ownKeys, ...reminderKeys, { keys: ['J', 'K'], does: t('keys.next') }], true).map((entry) => (
              <li key={`${entry.keys.join('+')}-${entry.does}`}>
                <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}

function viewLabel(view: ReminderView, counts: ReminderCounts | null, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (view === 'toApprove') return counts ? t('reminders.view.toApproveCount', { count: counts.toApprove }) : t('reminders.view.toApprove')
  if (view === 'waiting') return counts ? t('reminders.view.waitingCount', { count: counts.waiting }) : t('reminders.view.waiting')
  if (view === 'sent') return counts ? t('reminders.view.sentCount', { count: counts.sent30Days }) : t('reminders.view.sent')
  return t(`reminders.view.${view}`)
}
