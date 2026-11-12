'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Download, Pencil, Plus, Search, X } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, SegmentedControl } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { WithMessages } from '../../../../../record-panels/i18n'
import { moneyText } from '../../../costing/model'
import { LIMIT_VIEWS, type CreditLimits, type CustomerOption, type LimitRow, type LimitView } from '../api'
import { CREDIT_NAMESPACE, heldPhrases, usedTone, type CreditCan } from '../model'
import { ChangeLimitDialog, type ChangeState } from './ChangeLimitDialog'
import { UsedMeter } from './UsedMeter'
import '../credit.css'

/** SCR-151 sec:credit — Credit limits' view model (the view draws it and fetches nothing). */
export interface CreditLimitsModel {
  readonly prefix: string
  readonly can: CreditCan
  /** Today in Rome (the export's file name). */
  readonly today: string
  readonly view: LimitView
  readonly q: string | null
  /** The limits of the address (null while they read). */
  readonly limits: CreditLimits | null
  /** Every row read so far (Show more appends). */
  readonly rows: readonly LimitRow[] | null
  readonly problem: string | null
  readonly slow: boolean
  readonly updates: number
  /** The change dialog (a row's limit, or a new one for a customer chosen in it). */
  readonly change: ChangeState | null
  /** The customers a new limit may be set for (read when the dialog opens for a new one). */
  readonly customers: readonly CustomerOption[] | null
  readonly companyId: string | null
  readonly companyCode: string
  readonly notice: { readonly tone: 'success' | 'danger'; readonly key: string; readonly params?: Record<string, string | number> } | null
  readonly busy: boolean
  /** Design cases: the rows selected, the focused row, the keys panel. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface CreditLimitsActions {
  onView?: (view: LimitView) => void
  onSearch?: (text: string) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpenChange?: (row: LimitRow | null) => void
  onCloseChange?: () => void
  onSubmitChange?: (input: { readonly partyId: string; readonly companyId: string; readonly version?: number; readonly amount: number | null; readonly currency: string | null; readonly reason: string }) => Promise<boolean>
  onExport?: (rows: readonly LimitRow[], header: (column: string) => string, fileName: string) => void
  onDismissNotice?: () => void
}

/**
 * SCR-151 sec:credit — Finance › Receivables & credit › Credit limits (design finance.receivables "Credit limits — Limit,
 * used (open invoices + unbilled orders), available, orders on hold"; "Change limit (logged, ActionConfirm)"; B-W2b-304):
 * the customers with a limit with the company — the limit, what is used with its bar (open orders not yet invoiced + open
 * invoices), what is still available or how far over, the overdue part, a credit hold, and what waits for credit now
 * (orders waiting for a yes, releases and shipments held; the first orders open in Sales › Orders). Views All · Over the
 * limit · Something waits; a search; rows chosen → Export N. "Change limit" on a row and "Set a limit" for a new customer
 * open the change dialog (the reason, then the DS ActionConfirm review). Amounts only with the price grain; without
 * sales.credit.limits the actions are held with the permission in words; without sales.credit.view the section says so.
 */
export function CreditLimitsView({ model, actions }: { model: CreditLimitsModel; actions?: CreditLimitsActions }) {
  return (
    <WithMessages namespaces={[CREDIT_NAMESPACE, 'lists']}>
      <CreditSection model={model} actions={actions} />
    </WithMessages>
  )
}

function CreditSection({ model, actions }: { model: CreditLimitsModel; actions?: CreditLimitsActions }) {
  const t = useT(CREDIT_NAMESPACE)
  const lists = useT('lists')
  const locale = useLocale()
  const [selectedOwn, setSelected] = useState<string[]>([])
  const [typed, setTyped] = useState<string | null>(null)
  const [help, setHelp] = useState(false)
  const selected = model.selected ? [...model.selected] : selectedOwn
  const can = model.can
  const rows = model.rows
  const changeHeld = !can.change ? t('held.change', { permission: 'sales.credit.limits' }) : model.busy ? t('held.busy') : null

  const columns = useMemo<ColDef<LimitRow>[]>(() => {
    const CustomerCell = ({ data }: ICellRendererParams<LimitRow>) =>
      data ? (
        <span className="fw-frv-cell">
          <span className="fw-frv-ellipsis">{data.party.name}</span>
          <span className="fw-frv-cell-sub">
            {data.party.code} · {data.company.code}
            {data.onHold ? ` · ${t('row.onHold')}` : ''}
          </span>
        </span>
      ) : null
    const LimitCell = ({ data }: ICellRendererParams<LimitRow>) =>
      data ? (
        <span className="fw-frv-cell">
          <span className="fw-frv-num">{moneyText(data.limit ?? null, data.currency, locale)}</span>
          <span className="fw-frv-cell-sub">{formatDate(data.changedAt, { locale })}</span>
        </span>
      ) : null
    const UsedCell = ({ data }: ICellRendererParams<LimitRow>) =>
      data ? (
        <span className="fw-frc-used">
          <UsedMeter pct={data.usedPct} label={t('col.used')} over={usedTone(data) === 'missing'} />
          <span className="fw-frv-cell-sub fw-frv-num">{moneyText(data.used ?? null, data.currency, locale)}</span>
        </span>
      ) : null
    const AvailableCell = ({ data }: ICellRendererParams<LimitRow>) =>
      data ? (
        (data.overLimitBy ?? 0) > 0 || (data.available ?? 0) < 0 ? (
          <span className="fw-frv-num fw-frv-tone is-danger">{t('row.over', { amount: moneyText(Math.max(data.overLimitBy ?? 0, -(data.available ?? 0)), data.currency, locale) })}</span>
        ) : (
          <span className="fw-frv-num">{moneyText(data.available ?? null, data.currency, locale)}</span>
        )
      ) : null
    const OverdueCell = ({ data }: ICellRendererParams<LimitRow>) => (data ? <span className={`fw-frv-num${(data.overdue ?? 0) > 0 ? ' fw-frv-tone is-danger' : ''}`}>{moneyText(data.overdue ?? null, data.currency, locale)}</span> : null)
    const HeldCell = ({ data }: ICellRendererParams<LimitRow>) => {
      if (!data) return null
      const phrases = heldPhrases(data)
      if (phrases.length === 0) return <span className="fw-frv-muted">{t('row.nothingHeld')}</span>
      return (
        <span className="fw-frv-cell">
          <span className="fw-frv-inline">
            {phrases.map((phrase) => (
              <Pill key={phrase.key} tone="warning">
                {t(phrase.key, { count: phrase.count })}
              </Pill>
            ))}
          </span>
          {data.held.firstOrders.length > 0 && (
            <span className="fw-frv-cell-sub fw-frv-ellipsis">
              {data.held.firstOrders.map((order, index) => (
                <span key={order.id}>
                  {index > 0 ? ', ' : ''}
                  <Link className="fw-frv-link" href={`${model.prefix}/sales/orders/${encodeURIComponent(order.id)}`} tabIndex={-1}>
                    {order.number}
                  </Link>
                </span>
              ))}
            </span>
          )}
        </span>
      )
    }
    const ChangeCell = ({ data }: ICellRendererParams<LimitRow>) =>
      data ? (
        <Button size="sm" heldReason={!data.mayChange ? t('held.change', { permission: 'sales.credit.limits' }) : changeHeld} aria-label={`${t('action.change')} · ${data.party.name}`} onClick={() => actions?.onOpenChange?.(data)}>
          <Pencil size={13} aria-hidden /> {t('action.change')}
        </Button>
      ) : null
    return [
      { colId: 'customer', headerName: t('col.customer'), minWidth: 200, flex: 1.6, cellRenderer: CustomerCell },
      ...(can.price
        ? [
            { colId: 'limit', headerName: t('col.limit'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: LimitCell } satisfies ColDef<LimitRow>,
            { colId: 'used', headerName: t('col.used'), minWidth: 170, flex: 1.1, cellRenderer: UsedCell } satisfies ColDef<LimitRow>,
            { colId: 'available', headerName: t('col.available'), minWidth: 140, flex: 0.9, type: 'rightAligned', cellRenderer: AvailableCell } satisfies ColDef<LimitRow>,
            { colId: 'overdue', headerName: t('col.overdue'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: OverdueCell } satisfies ColDef<LimitRow>,
          ]
        : []),
      { colId: 'held', headerName: t('col.held'), minWidth: 190, flex: 1.2, cellRenderer: HeldCell },
      { colId: 'change', headerName: t('col.change'), minWidth: 150, flex: 0.7, cellRenderer: ChangeCell },
    ]
  }, [t, locale, can.price, changeHeld, model.prefix, actions])

  if (!can.view) {
    return (
      <section className="fw-frv-section" aria-labelledby="fw-frc-title">
        <h2 id="fw-frc-title" className="fw-frv-h2">
          {t('title')}
        </h2>
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body', { permission: 'sales.credit.view' })} />
      </section>
    )
  }

  const keyOf = (row: LimitRow) => row.termsId
  const picked = (rows ?? []).filter((row) => selected.includes(keyOf(row)))
  const counts = model.limits?.tiles
  const viewCount = (view: LimitView): number | null => (counts ? (view === 'ALL' ? counts.customers : view === 'OVER' ? counts.over : counts.held) : null)
  const filtered = model.view !== 'ALL' || model.q !== null
  const keys: ListKey[] = [{ keys: ['/'], does: t('keys.search') }, { keys: ['Enter'], does: t('keys.change') }]
  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('search')}
      placeholder={t('search')}
      value={typed ?? model.q ?? ''}
      onChange={(event) => {
        setTyped(event.target.value)
        actions?.onSearch?.(event.target.value)
      }}
    />
  )
  const chips = model.q ? (
    <FilterChip
      pressed
      onClick={() => {
        setTyped(null)
        actions?.onSearch?.('')
      }}
      aria-label={t('clear')}
    >
      {model.q} <X size={12} aria-hidden />
    </FilterChip>
  ) : undefined
  const state = model.problem ? (
    <EmptyState title={t('failed')} description={t(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : rows && rows.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('noMatch.title')}
        description={t('noMatch.body')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setTyped(null)
              actions?.onSearch?.('')
              actions?.onView?.('ALL')
            }}
          >
            {t('clear')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('empty.title')} description={t('empty.body')} />
    )
  ) : undefined

  return (
    <section id="credit" tabIndex={-1} className="fw-frv-section" aria-labelledby="fw-frc-title">
      <div className="fw-frv-section-head">
        <h2 id="fw-frc-title" className="fw-frv-h2">
          {t('title')}
        </h2>
        <SegmentedControl
          size="sm"
          wrap
          ariaLabel={t('view.label')}
          value={model.view}
          onChange={(value) => actions?.onView?.(value as LimitView)}
          options={LIMIT_VIEWS.map((view) => ({ value: view, label: viewCount(view) === null ? t(`view.${view}`) : t(`viewCount.${view}`, { count: viewCount(view)! }) }))}
        />
        <Button size="sm" heldReason={changeHeld} onClick={() => actions?.onOpenChange?.(null)}>
          <Plus size={13} aria-hidden /> {t('action.add')}
        </Button>
      </div>
      <p className="fw-frv-muted">{t('hint')}</p>
      <p className="fw-frv-muted">{t('rules')}</p>
      {!can.price && <p className="fw-frv-muted">{t('noPrice', { permission: 'money.price' })}</p>}
      {model.notice && (
        <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} onDismiss={() => actions?.onDismissNotice?.()}>
          {null}
        </Banner>
      )}
      {model.slow && !rows && !model.problem && (
        <p className="fw-frv-muted" role="status">
          {t('slow')}
        </p>
      )}
      <ListFrame<LimitRow>
        label={t('title')}
        title={t('title')}
        listKey="finance.receivables.credit"
        rows={state ? [] : rows}
        rowId={keyOf}
        columns={columns}
        count={rows ? t('count', { count: model.limits?.count ?? rows.length }) : '—'}
        search={search}
        tools={chips}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('action.export', { count: picked.length })} heldReason={picked.length === 0 ? t('held.pickToExport') : null} onClick={() => actions?.onExport?.(picked, (column) => t(`csv.${column}`), t('action.exportFile', { day: model.today }))}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('action.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.limits?.next !== null && model.limits?.next !== undefined ? { label: t('more'), onMore: () => actions?.onMore?.() } : null}
        keys={keys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => {
          if (row.mayChange && can.change) actions?.onOpenChange?.(row)
        }}
        state={state}
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
      <p className="fw-frv-muted">{t('wording')}</p>

      {model.change && (
        <ChangeLimitDialog
          state={model.change}
          customers={model.customers}
          companyId={model.companyId}
          companyCode={model.companyCode}
          busy={model.busy}
          onClose={() => actions?.onCloseChange?.()}
          onSubmit={(input) => actions?.onSubmitChange?.(input) ?? Promise.resolve(false)}
        />
      )}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('keys.title')} size="sm">
          <ul className="fw-frv-muted">
            {listKeys(keys, true).map((entry) => (
              <li key={`${entry.keys.join('+')}-${entry.does}`}>
                <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </section>
  )
}
