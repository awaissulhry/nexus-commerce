'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Download, Plus } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { ChangeValue } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { FiguresAnswer } from '@nexus/factory-domain/receivables-figures/contracts'
import type { CustomerRow } from '../../_shared/api'
import { dayInstant, money } from '../../_shared/model'
import type { FiguresRow } from '../api'
import { bankHref, EMPTY_ADDRESS, type FiguresDraft, type Phrase } from '../model'
import { FiguresDetail } from './FiguresDetail'
import { FiguresDialog } from './FiguresDialog'

/** The figures editor (record their figures, or correct a typing mistake): the container keeps it. */
export interface FiguresEditor {
  readonly mode: 'new' | 'correct'
  readonly figuresId: string | null
  readonly version: number | null
  readonly draft: FiguresDraft
  readonly q: string
  readonly customers: readonly CustomerRow[] | null
  readonly customersProblem: string | null
  readonly busy: boolean
  /** Shown once the person tried to send (every field's problem then). */
  readonly tried: boolean
  readonly problems: readonly Phrase[] | null
}

/** Their figures vs ours (design sec:customer-figures): the container keeps it. */
export interface FiguresModel {
  readonly can: { readonly view: boolean; readonly manage: boolean; readonly price: boolean; readonly upload: boolean; readonly filesRead: boolean; readonly parties: boolean }
  readonly rows: readonly FiguresRow[] | null
  readonly problem: string | null
  readonly slow: boolean
  /** `?figures=<id>`: the figures open with their comparison. */
  readonly open: { readonly id: string; readonly answer: FiguresAnswer | null; readonly problem: string | null } | null
  readonly editor: FiguresEditor | null
  /** Design cases: the rows chosen. */
  readonly selected?: readonly string[]
}

export interface FiguresActions {
  onNew?: () => void
  onOpen?: (figuresId: string) => void
  onCloseOpen?: () => void
  onCorrect?: () => void
  onRetry?: (part: 'list' | 'open') => void
  onExport?: (rows: readonly FiguresRow[]) => void
  onDownload?: (fileId: string) => void
  editor?: {
    onDraft?: (draft: FiguresDraft) => void
    onSearch?: (q: string) => void
    onCustomer?: (customer: { id: string; label: string } | null) => void
    onFile?: (file: File | null) => void
    onSubmit?: () => void
    onClose?: () => void
  }
}

/**
 * Their figures vs ours (design finance.bank sec:customer-figures, FIN-135: "A B2B customer's stated figures compared with
 * ours — order, payment, balance; differences"): the figures recorded, newest first, on the ONE list frame — the customer,
 * the day, their balance → ours (ChangeValue; the price grain), the difference, how many lines differ, what they listed,
 * the statement kept — with Export N; "Record their figures"; a row opens the comparison (`?figures=<id>`). No person's name
 * in the list (who recorded them is inside the record).
 */
export function FiguresSection({ model, prefix, today, actions }: { model: FiguresModel; prefix: string; today: string; actions?: FiguresActions }) {
  const t = useT('finance-bank')
  const locale = useLocale()
  const [selectedOwn, setSelected] = useState<string[]>([])
  const selected = model.selected ? [...model.selected] : selectedOwn
  const can = model.can
  const rows = model.rows
  const day = (value: string) => formatDate(dayInstant(value), { locale })

  const columns = useMemo<ColDef<FiguresRow>[]>(() => {
    const CustomerCell = ({ data }: ICellRendererParams<FiguresRow>) =>
      data ? (
        <span className="fw-bank-cell">
          <Link className="fw-bank-link" href={bankHref(prefix, { ...EMPTY_ADDRESS, figures: data.id })} tabIndex={-1}>
            {data.customer.name}
          </Link>
          <span className="fw-bank-sub fw-bank-code">{data.customer.code}</span>
        </span>
      ) : null
    const AsOfCell = ({ data }: ICellRendererParams<FiguresRow>) => (data ? <span>{day(data.asOf)}</span> : null)
    const BalanceCell = ({ data }: ICellRendererParams<FiguresRow>) =>
      data ? (
        can.price ? (
          <ChangeValue compact hideLabels changes={[{ label: t('figures.col.balance'), from: money(data.theirs.balance ?? null, data.currency, locale), to: money(data.summary.ours ?? null, data.currency, locale) }]} />
        ) : (
          <span className="fw-bank-muted">—</span>
        )
      ) : null
    const DifferenceCell = ({ data }: ICellRendererParams<FiguresRow>) =>
      data ? <span className={`fw-bank-num${(data.summary.difference ?? 0) !== 0 ? ' is-late' : ''}`}>{can.price ? money(data.summary.difference ?? null, data.currency, locale) : '—'}</span> : null
    const StateCell = ({ data }: ICellRendererParams<FiguresRow>) =>
      data ? <Pill tone={data.summary.state === 'AGREES' ? 'success' : 'warning'}>{data.summary.state === 'AGREES' ? t('figures.agrees') : t('figures.differs', { count: data.summary.differences })}</Pill> : null
    const ListedCell = ({ data }: ICellRendererParams<FiguresRow>) => (data ? <span className="fw-bank-muted">{t('figures.listed', { orders: data.theirs.orders, payments: data.theirs.payments })}</span> : null)
    const FileCell = ({ data }: ICellRendererParams<FiguresRow>) => (data ? data.file ? <Tag tone="info">{t('figures.fileKept')}</Tag> : <span className="fw-bank-muted">—</span> : null)
    return [
      { colId: 'customer', headerName: t('figures.col.customer'), minWidth: 200, flex: 1.4, cellRenderer: CustomerCell },
      { colId: 'asOf', headerName: t('figures.col.asOf'), minWidth: 110, flex: 0.6, cellRenderer: AsOfCell },
      { colId: 'balance', headerName: t('figures.col.theirsOurs'), minWidth: 200, flex: 1.2, cellRenderer: BalanceCell },
      { colId: 'difference', headerName: t('figures.col.difference'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: DifferenceCell },
      { colId: 'state', headerName: t('figures.col.state'), minWidth: 140, flex: 0.8, cellRenderer: StateCell },
      { colId: 'listed', headerName: t('figures.col.listed'), minWidth: 150, flex: 0.9, cellRenderer: ListedCell },
      { colId: 'file', headerName: t('figures.col.file'), minWidth: 110, flex: 0.6, cellRenderer: FileCell },
    ]
  }, [t, locale, prefix, can.price])

  const newHeld = !can.manage ? t('held.figures') : !can.price ? t('held.figuresPrice') : !can.parties ? t('held.parties') : null
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const keys: ListKey[] = [
    { keys: ['Enter'], does: t('keys.openFigures') },
    { keys: ['x'], does: t('keys.select') },
  ]
  const state = !can.view ? (
    <EmptyState title={t('figures.noAccess.title')} description={t('figures.noAccess.body')} />
  ) : model.problem ? (
    <EmptyState
      title={t('figures.failed')}
      description={t(model.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.('list')}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows && rows.length === 0 ? (
    <EmptyState title={t('figures.empty.title')} description={t('figures.empty.body')} />
  ) : undefined

  return (
    <section className="fw-bank-section" aria-labelledby="fw-bank-figures">
      <div className="fw-bank-section-head">
        <span className="fw-bank-stack">
          <h2 id="fw-bank-figures" className="fw-bank-h2">
            {t('figures.title')}
          </h2>
          <span className="fw-bank-muted">{can.price ? t('figures.hint') : t('figures.noPrice')}</span>
        </span>
        <Button size="sm" heldReason={newHeld} onClick={() => actions?.onNew?.()}>
          <Plus size={14} aria-hidden /> {t('figures.new')}
        </Button>
      </div>
      {model.slow && !rows && !model.problem && (
        <p className="fw-bank-muted" role="status">
          {t('lines.slow')}
        </p>
      )}
      <ListFrame<FiguresRow>
        label={t('figures.title')}
        listKey="finance.bank.figures"
        rows={state ? [] : can.view ? rows : []}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('figures.count', { count: rows.length }) : '—'}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked)}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        keys={keys}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
      />
      {model.open && <FiguresDetail model={model} prefix={prefix} actions={actions} />}
      {model.editor && <FiguresDialog editor={model.editor} can={can} today={today} actions={actions?.editor} />}
    </section>
  )
}
