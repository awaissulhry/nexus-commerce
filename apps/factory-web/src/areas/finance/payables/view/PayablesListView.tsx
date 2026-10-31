'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { CheckCheck, CloudDownload, FilePlus2, MoreHorizontal, Search, X } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, Modal, type Metric } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { dayInstant, money } from '../../_shared/model'
import type { InvoiceCounts, InvoiceRow, PickupAnswer, SdiStatus, SupplierOption } from '../api'
import { daysLate, invoiceHref, MATCH_TONE, PAYABLES_NAMESPACE, rowHeld, STATUS_TONE, tilesOf, type ForeignDraft, type PayablesAddress, type PayablesCan, type Phrase } from '../model'
import { ForeignDialog } from './ForeignDialog'
import '../payables.css'

export type LiveState = 'connecting' | 'live' | 'offline'

export interface Part<T> {
  readonly value: T | null
  readonly problem: string | null
}

export interface BulkAnswer {
  readonly approved: number
  readonly refused: readonly { readonly id: string; readonly number: string; readonly phrases: readonly Phrase[] }[]
}

export interface ForeignModel {
  readonly draft: ForeignDraft
  /** The suppliers the search found (null: not asked yet). */
  readonly suppliers: readonly SupplierOption[] | null
  readonly problems: readonly Phrase[] | null
  readonly busy: boolean
}

/** SCR-153 — Supplier invoices' view model (the view draws it and fetches nothing). */
export interface PayablesListModel {
  readonly prefix: string
  readonly can: PayablesCan
  readonly today: string
  readonly address: PayablesAddress
  readonly counts: Part<InvoiceCounts>
  readonly sdi: Part<SdiStatus>
  readonly list: { readonly problem: string | null; readonly slow: boolean }
  /** Every row read so far (Show more appends); null while the first read runs. */
  readonly rows: readonly InvoiceRow[] | null
  readonly count: number | null
  readonly more: boolean
  readonly readAt: number | null
  readonly live: LiveState
  readonly updates: number
  readonly busy: boolean
  readonly notice: { readonly tone: 'success' | 'danger' | 'info' | 'warning'; readonly phrases: readonly Phrase[] } | null
  /** The bulk approval's answer, per row. */
  readonly bulk: BulkAnswer | null
  readonly pickup: PickupAnswer | null
  /** "Add foreign invoice" (`?new=1`). */
  readonly foreign: ForeignModel | null
  /** Design cases: the selected rows, the focused row, the keys panel open. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface PayablesListActions {
  onAddress?: (next: Partial<PayablesAddress>) => void
  onSearch?: (text: string) => void
  onRetry?: (part: 'list' | 'counts' | 'sdi') => void
  onMore?: () => void
  onShowUpdates?: () => void
  onApprove?: (rows: readonly InvoiceRow[], clear: () => void) => void
  onPickUp?: () => void
  onDismissNotice?: () => void
  onDismissBulk?: () => void
  onDismissPickup?: () => void
  onOpen?: (row: InvoiceRow) => void
  foreign?: {
    onChange: (draft: ForeignDraft) => void
    onSupplierQuery: (text: string) => void
    onFile: (file: File | null) => void
    onSubmit: () => void
    onClose: () => void
  }
}

/**
 * SCR-153 — Finance › Payables & bank › Supplier invoices (design finance.payables; FIN-136, FIN-137): the band (when it
 * was read, live, "Last SDI pickup", Pick up now; Add foreign invoice; Payment proposal — W2b, held —; ⋯ Self-invoices
 * TD17/18/19 — W2b, held), the "To handle" tiles (saved filters: New from SDI, Differences to check, To approve, Due this
 * week; a tile filters the list), and the invoices on the ONE list frame: supplier, number and date, amount (the cost
 * grain: the column is not drawn without it), source (SDI · e-mail · typed), match in words, approval, due, paid; select
 * with the header box, shift-click, x; "Approve N" asks each invoice's own approval (separation of duties per row: the
 * answer says which were approved and why the others were not). A row's number is a real link to the record (⌘-click: a
 * new tab). No person is counted or totalled.
 */
export function PayablesListView({ model, actions }: { model: PayablesListModel; actions?: PayablesListActions }) {
  return (
    <WithMessages namespaces={[PAYABLES_NAMESPACE, 'lists']}>
      <ListPage model={model} actions={actions} />
    </WithMessages>
  )
}

function ListPage({ model, actions }: { model: PayablesListModel; actions?: PayablesListActions }) {
  const t = useT(PAYABLES_NAMESPACE)
  const lists = useT('lists')
  const locale = useLocale()
  const [selectedOwn, setSelected] = useState<string[]>([])
  const [help, setHelp] = useState(false)
  const [typed, setTyped] = useState<string | null>(null)
  const selected = model.selected ? [...model.selected] : selectedOwn
  const can = model.can
  const rows = model.rows
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')

  const columns = useMemo<ColDef<InvoiceRow>[]>(() => {
    const SupplierCell = ({ data }: ICellRendererParams<InvoiceRow>) =>
      data ? (
        <span className="fw-fpy-cell">
          <span className="fw-fpy-ellipsis">{data.supplier.name}</span>
          <span className="fw-fpy-cell-sub">
            <span className="fw-fpy-code">{data.supplier.code}</span>
            {data.kind === 'CREDIT_NOTE' ? ` · ${t('kind.CREDIT_NOTE')}` : ''}
          </span>
        </span>
      ) : null
    const NumberCell = ({ data }: ICellRendererParams<InvoiceRow>) =>
      data ? (
        <span className="fw-fpy-cell">
          <Link className="fw-fpy-link" href={invoiceHref(model.prefix, data.id)} tabIndex={-1}>
            {data.number}
          </Link>
          <span className="fw-fpy-cell-sub">{day(data.issueDate)}</span>
        </span>
      ) : null
    const AmountCell = ({ data }: ICellRendererParams<InvoiceRow>) =>
      data ? (
        <span className="fw-fpy-cell is-end">
          <span className="fw-fpy-num">{money(data.grossTotal ?? null, data.currency, locale)}</span>
          <span className="fw-fpy-cell-sub fw-fpy-num">{t('row.net', { amount: money(data.netTotal ?? null, data.currency, locale) })}</span>
        </span>
      ) : null
    const SourceCell = ({ data }: ICellRendererParams<InvoiceRow>) => (data ? <Tag tone={data.source === 'SDI' ? 'info' : 'neutral'}>{t(`source.${data.source}`)}</Tag> : null)
    const MatchCell = ({ data }: ICellRendererParams<InvoiceRow>) =>
      data ? (
        <span className="fw-fpy-cell">
          <Pill tone={MATCH_TONE[data.matchStatus]}>{t(`match.${data.matchStatus}`)}</Pill>
          {data.differencesToCheck > 0 && <span className="fw-fpy-cell-sub">{t('row.toCheck', { count: data.differencesToCheck })}</span>}
        </span>
      ) : null
    const ApprovalCell = ({ data }: ICellRendererParams<InvoiceRow>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill> : null)
    const DueCell = ({ data }: ICellRendererParams<InvoiceRow>) => {
      if (!data) return null
      const late = daysLate(data, model.today)
      return (
        <span className="fw-fpy-cell">
          <span>{day(data.dueDate)}</span>
          {late !== null && <span className="fw-fpy-cell-sub fw-fpy-tone is-danger">{t('row.late', { count: late })}</span>}
        </span>
      )
    }
    const PaidCell = ({ data }: ICellRendererParams<InvoiceRow>) => (data ? <span>{data.paidOn ? day(data.paidOn) : t('row.notPaid')}</span> : null)
    return [
      { colId: 'supplier', headerName: t('col.supplier'), minWidth: 200, flex: 1.5, cellRenderer: SupplierCell },
      { colId: 'number', headerName: t('col.number'), minWidth: 150, flex: 1, cellRenderer: NumberCell },
      ...(can.cost ? [{ colId: 'amount', headerName: t('col.amount'), minWidth: 140, flex: 0.9, type: 'rightAligned', cellRenderer: AmountCell } satisfies ColDef<InvoiceRow>] : []),
      { colId: 'source', headerName: t('col.source'), minWidth: 110, flex: 0.6, cellRenderer: SourceCell },
      { colId: 'match', headerName: t('col.match'), minWidth: 160, flex: 1, cellRenderer: MatchCell },
      { colId: 'approval', headerName: t('col.approval'), minWidth: 130, flex: 0.8, cellRenderer: ApprovalCell },
      { colId: 'due', headerName: t('col.due'), minWidth: 130, flex: 0.8, cellRenderer: DueCell },
      { colId: 'paid', headerName: t('col.paid'), minWidth: 110, flex: 0.7, cellRenderer: PaidCell },
    ]
    // The cells close over the words, the grain and the day: a change of language or rights rebuilds them.
  }, [t, locale, model.prefix, model.today, can.cost])

  if (!can.view) {
    return (
      <div className="fw-fpy">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }

  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const approvable = picked.filter((row) => rowHeld(row) === null)
  const filtered = model.address.tile !== null || model.address.q !== null
  const company = model.sdi.value?.companies[0] ?? null
  const lastPickup = company?.lastPickup ?? null
  const pickupHeld = !can.manage ? t('held.manage') : !company ? t('held.noSdiAccount') : !company.picksUp ? t('held.noIntermediary') : model.busy ? t('held.busy') : null
  const addHeld = !can.manage ? t('held.manage') : !can.upload ? t('held.upload') : null
  const approveHeld = !can.approve ? t('held.approve') : approvable.length === 0 ? t('held.noneApprovable') : model.busy ? t('held.busy') : null
  const ownKeys: ListKey[] = [
    { keys: ['/'], does: t('keys.search') },
    { keys: ['Enter'], does: t('keys.open') },
    { keys: ['x'], does: t('keys.select') },
  ]

  const tiles: Metric[] = tilesOf(model.counts.value).map((tile) => ({
    label: t(`tile.${tile.id}`),
    value: tile.count === null ? '—' : String(tile.count),
    hint: tile.id === 'DUE_THIS_WEEK' && model.counts.value ? t('tile.dueHint', { date: day(model.counts.value.weekEnds) }) : t(`tile.${tile.id}Hint`),
    onClick: () => actions?.onAddress?.({ tile: model.address.tile === tile.id ? null : tile.id }),
    active: model.address.tile === tile.id,
  }))

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
  const chips = model.address.tile ? (
    <FilterChip pressed onClick={() => actions?.onAddress?.({ tile: null })} aria-label={t('filter.clear', { name: t(`tile.${model.address.tile}`) })}>
      {t(`tile.${model.address.tile}`)} <X size={12} aria-hidden />
    </FilterChip>
  ) : undefined
  const clear = (
    <Button
      size="sm"
      onClick={() => {
        setTyped(null)
        actions?.onAddress?.({ tile: null, q: null })
      }}
    >
      {t('list.clearFilters')}
    </Button>
  )
  const state = model.list.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={t(model.list.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.('list')}>
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

  return (
    <div className="fw-fpy">
      <div className="fw-fpy-band" role="group" aria-label={t('band.label')}>
        <span className="fw-fpy-inline">
          {model.readAt !== null ? <span className="fw-fpy-muted">{t('band.readAt', { time: formatTime(model.readAt, { locale }) })}</span> : <span className="fw-fpy-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
          <span className="fw-fpy-muted">
            {model.sdi.problem
              ? t('band.sdiUnknown')
              : !model.sdi.value
                ? t('band.sdiReading')
                : !company?.account
                  ? t('band.noSdiAccount')
                  : lastPickup
                    ? t(lastPickup.byPerson ? 'band.lastPickupByPerson' : 'band.lastPickup', { time: formatTime(lastPickup.at, { locale }) })
                    : t('band.noPickupYet')}
          </span>
          <Button size="sm" heldReason={pickupHeld} onClick={() => actions?.onPickUp?.()}>
            <CloudDownload size={14} aria-hidden /> {t('band.pickUp')}
          </Button>
        </span>
        <span className="fw-fpy-inline">
          <Button size="sm" heldReason={addHeld} onClick={() => actions?.onAddress?.({ adding: true })}>
            <FilePlus2 size={14} aria-hidden /> {t('band.addForeign')}
          </Button>
          <Button size="sm" variant="primary" heldReason={t('held.proposalLater')}>
            {t('band.proposal')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[{ id: 'self', label: t('band.selfInvoices'), disabled: true, description: t('held.selfInvoicesLater') }]}
          />
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={model.notice.phrases.map((phrase) => t(phrase.key, phrase.params)).join(' ')}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {model.pickup && (
        <Banner
          tone={model.pickup.waiting.length > 0 ? 'warning' : 'success'}
          title={t('pickup.done', { listed: model.pickup.listed, recorded: model.pickup.recorded.length })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissPickup?.()}>
              {t('common.dismiss')}
            </Button>
          }
        >
          {model.pickup.recorded.length > 0 && (
            <ul className="fw-fpy-list">
              {model.pickup.recorded.map((entry) => (
                <li key={entry.invoiceId}>
                  <Link className="fw-fpy-link" href={invoiceHref(model.prefix, entry.invoiceId)}>
                    {entry.number}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {model.pickup.waiting.length > 0 && <p className="fw-fpy-muted">{t('pickup.waiting', { count: model.pickup.waiting.length })}</p>}
        </Banner>
      )}
      {model.bulk && (
        <Banner
          tone={model.bulk.refused.length > 0 ? 'warning' : 'success'}
          title={t('bulk.answer', { approved: model.bulk.approved, refused: model.bulk.refused.length })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissBulk?.()}>
              {t('common.dismiss')}
            </Button>
          }
        >
          {model.bulk.refused.length > 0 && (
            <ul className="fw-fpy-list">
              {model.bulk.refused.map((entry) => (
                <li key={entry.id}>
                  <Link className="fw-fpy-link" href={invoiceHref(model.prefix, entry.id, 'approval')}>
                    {entry.number}
                  </Link>
                  : {entry.phrases.map((phrase) => t(phrase.key, phrase.params)).join(' ')}
                </li>
              ))}
            </ul>
          )}
        </Banner>
      )}

      <section className="fw-fpy-section" aria-labelledby="fw-fpy-tiles">
        <h2 id="fw-fpy-tiles" className="fw-fpy-h2">
          {t('tile.title')}
        </h2>
        {model.counts.problem && !model.counts.value ? (
          <EmptyState
            title={t('tile.failed')}
            description={t(model.counts.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.('counts')}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : (
          <MetricStrip metrics={tiles} minTileWidth={190} />
        )}
      </section>

      <section className="fw-fpy-section" aria-labelledby="fw-fpy-grid">
        <div className="fw-fpy-section-head">
          <h2 id="fw-fpy-grid" className="fw-fpy-h2">
            {t('list.title')}
          </h2>
          <span className="fw-fpy-muted">{can.cost ? t('list.hint') : t('list.noCost')}</span>
        </div>
        {model.list.slow && !rows && !model.list.problem && (
          <p className="fw-fpy-muted" role="status">
            {t('list.slow')}
          </p>
        )}
        <ListFrame<InvoiceRow>
          label={t('list.title')}
          rows={state ? [] : rows}
          rowId={(row) => row.id}
          columns={columns}
          count={rows ? t('list.count', { count: rows.length, total: model.count ?? rows.length }) : '—'}
          search={search}
          tools={chips}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <Button
                size="sm"
                variant="primary"
                heldReason={approveHeld}
                aria-label={t('bulk.approve', { count: approvable.length })}
                onClick={() => actions?.onApprove?.(approvable, () => setSelected([]))}
              >
                <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.approve', { count: approvable.length })}</SelectionLabel>
              </Button>
            ),
          }}
          isRowSelectable={(row) => {
            const held = rowHeld(row)
            return held ? t(held) : null
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          more={model.more ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          onOpen={(row) => actions?.onOpen?.(row)}
          state={state}
          focusRow={model.focusRow}
          keysOpen={model.keysOpen}
        />
      </section>

      {model.foreign && <ForeignDialog model={model.foreign} today={model.today} actions={actions?.foreign} />}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('keys.title')} size="sm">
          <ul className="fw-fpy-list">
            {listKeys(ownKeys, true).map((entry) => (
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
