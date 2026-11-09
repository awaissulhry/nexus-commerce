'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { Archive, Download, FileCode2, FileText } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { dayWords, invoiceSelectable, NS, periodWords, sizeWords, stateTone, type ExportFileRow, type InvoiceRow, type RegisterRow } from '../model'

/**
 * SCR-268's three lists on the shared list frame (select-all, shift range, x / Space, "Download N" while rows are chosen, the
 * keys only in the footer's icon, cards on a phone; Enter downloads the focused file): the numbered exports' journal files,
 * the period's e-invoices (XML and PDF), the register files. Names, numbers, days and states only: never an amount.
 */

export type ListSection = 'exports' | 'invoices' | 'registers'

export interface ListsModel {
  state: 'loading' | 'error' | 'ready'
  exports: readonly ExportFileRow[] | null
  invoices: readonly InvoiceRow[] | null
  registers: readonly RegisterRow[] | null
  later: readonly string[]
  selected: Readonly<Record<ListSection, readonly string[]>>
  /** The download running: a file id or `zip:<what>`. */
  busy: string | null
  /** Why nothing may be downloaded now (a key), or null. */
  held: string | null
  keysOpen?: boolean
}

export interface ListsActions {
  onSelect?: (section: ListSection, ids: string[]) => void
  onDownload?: (fileId: string, name: string) => void
  onZipChosen?: (section: ListSection, ids: readonly string[]) => void
  onZipXml?: () => void
  onRetry?: () => void
  onHelp?: () => void
}

type Held = string | null

function useHeld(model: ListsModel) {
  const t = useT(NS)
  return (id: string): Held => (model.held ? t(model.held) : model.busy === id ? t('row.downloading') : model.busy ? t('held.busy') : null)
}

const failed = (t: (key: string) => string, onRetry?: () => void) => (
  <EmptyState title={t('state.listFailed')} description={t('state.listFailedBody')} action={<Button size="sm" onClick={() => onRetry?.()}>{t('state.retry')}</Button>} />
)

function bulkButton(t: (key: string, params?: Record<string, string | number>) => string, count: number, held: Held, onClick: () => void) {
  return (
    <Button size="sm" heldReason={count === 0 ? t('held.choose') : held} onClick={onClick} aria-label={t('bulk.download', { count })}>
      <Archive size={13} aria-hidden /> <SelectionLabel>{t('bulk.download', { count })}</SelectionLabel>
    </Button>
  )
}

// ── Accounting exports ───────────────────────────────────────────────────────────────────────────────────────────────
export function ExportsList({ model, actions }: { model: ListsModel; actions?: ListsActions }) {
  const t = useT(NS)
  const locale = useLocale()
  const held = useHeld(model)
  const latest = useRef({ model, actions, held })
  latest.current = { model, actions, held }
  const columns = useMemo((): ColDef<ExportFileRow>[] => {
    const Standing = ({ data }: ICellRendererParams<ExportFileRow>) =>
      data ? (
        <span className="fw-pacc-line">
          {data.amendedBy ? <Pill tone="warning">{t('standing.amendedBy', { number: data.amendedBy })}</Pill> : <Pill tone="success">{t('standing.final')}</Pill>}
          {data.amends ? <span className="fw-pacc-sub">{t('standing.amends', { number: data.amends })}</span> : null}
        </span>
      ) : null
    const FileCell = ({ data }: ICellRendererParams<ExportFileRow>) =>
      data ? (
        <span className="fw-pacc-two">
          <span className="fw-pacc-ellipsis fw-pacc-mono" title={data.name}>
            {data.name}
          </span>
          <span className="fw-pacc-sub">{t('row.fileFacts', { format: data.format, size: sizeWords(data.sizeBytes, locale), rows: data.rowCount })}</span>
        </span>
      ) : null
    const Actions = ({ data }: ICellRendererParams<ExportFileRow>) =>
      data ? (
        <Button size="sm" heldReason={latest.current.held(data.id)} aria-label={t('row.downloadOf', { name: data.name })} onClick={() => latest.current.actions?.onDownload?.(data.id, data.name)}>
          <Download size={14} aria-hidden /> <span className="fw-pacc-btnword">{t('row.download')}</span>
        </Button>
      ) : null
    return [
      { colId: 'number', headerName: t('col.export'), flex: 0.8, minWidth: 140, sortable: false, valueGetter: ({ data }) => data?.number ?? '', cellClass: 'fw-pacc-mono' },
      { colId: 'journal', headerName: t('col.journal'), flex: 1, minWidth: 170, sortable: false, valueGetter: ({ data }) => (data ? t(`package.${data.journal}`) : '') },
      { colId: 'period', headerName: t('col.period'), flex: 0.7, minWidth: 130, sortable: false, valueGetter: ({ data }) => (data ? periodWords(data.month, locale) : '') },
      { colId: 'created', headerName: t('col.created'), flex: 0.6, minWidth: 116, sortable: false, valueGetter: ({ data }) => (data ? dayWords(data.exportedAt, locale) : '') },
      { colId: 'standing', headerName: t('col.standing'), flex: 1, minWidth: 190, sortable: false, cellRenderer: Standing, valueGetter: ({ data }) => (data ? (data.amendedBy ? t('standing.amendedBy', { number: data.amendedBy }) : t('standing.final')) : '') },
      { colId: 'file', headerName: t('col.file'), flex: 1.4, minWidth: 220, sortable: false, cellRenderer: FileCell, valueGetter: ({ data }) => data?.name ?? '' },
      { colId: 'actions', headerName: t('col.actions'), width: 148, minWidth: 148, maxWidth: 148, sortable: false, pinned: 'right', suppressHeaderMenuButton: true, cellRenderer: Actions },
    ]
  }, [t, locale])
  const rows = model.exports
  const chosen = model.selected.exports
  const state: ReactNode = model.state === 'error' ? failed(t, actions?.onRetry) : rows && rows.length === 0 ? <EmptyState icon={<FileText size={24} aria-hidden />} title={t('exports.empty')} description={t('exports.emptyBody')} /> : undefined
  return (
    <section className="fw-pacc-section" aria-labelledby="fw-pacc-exports">
      <div className="fw-pacc-head">
        <h2 id="fw-pacc-exports" className="fw-pacc-h2">
          {t('exports.title')}
        </h2>
        <p className="fw-pacc-sub">{t('exports.hint')}</p>
      </div>
      <ListFrame<ExportFileRow>
        label={t('exports.title')}
        title={t('exports.title')}
        listKey={null}
        rows={model.state === 'error' ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows && model.state !== 'error' ? t('count.files', { count: rows.length }) : ''}
        selection={{ selected: chosen, onChange: (ids) => actions?.onSelect?.('exports', ids), actions: bulkButton(t, chosen.length, held('zip:exports'), () => actions?.onZipChosen?.('exports', chosen)) }}
        keys={[{ keys: ['Enter'], does: t('keys.download') }]}
        onHelp={actions?.onHelp}
        onOpen={(row) => actions?.onDownload?.(row.id, row.name)}
        state={state}
        cards={{}}
        keysOpen={model.keysOpen}
      />
    </section>
  )
}

// ── E-invoices ───────────────────────────────────────────────────────────────────────────────────────────────────────
export function InvoicesList({ model, actions }: { model: ListsModel; actions?: ListsActions }) {
  const t = useT(NS)
  const locale = useLocale()
  const held = useHeld(model)
  const latest = useRef({ model, actions, held })
  latest.current = { model, actions, held }
  const columns = useMemo((): ColDef<InvoiceRow>[] => {
    const Kind = ({ data }: ICellRendererParams<InvoiceRow>) =>
      data ? (
        <span className="fw-pacc-two">
          <span>{t(`kind.${data.kind}`)}</span>
          <span className="fw-pacc-sub">{t(`side.${data.side}`)}</span>
        </span>
      ) : null
    const State = ({ data }: ICellRendererParams<InvoiceRow>) => (data ? <Pill tone={stateTone(data.state)}>{t(`state.${data.state}`)}</Pill> : null)
    const Files = ({ data }: ICellRendererParams<InvoiceRow>) => {
      if (!data) return null
      const now = latest.current
      const button = (file: InvoiceRow['xml'], format: 'xml' | 'pdf') =>
        file ? (
          <Button size="sm" heldReason={now.held(file.id)} aria-label={t(`row.${format}Of`, { number: data.number })} onClick={() => now.actions?.onDownload?.(file.id, file.name)}>
            {format === 'xml' ? <FileCode2 size={14} aria-hidden /> : <FileText size={14} aria-hidden />} <span>{t(`file.${format}`)}</span>
          </Button>
        ) : (
          <span className="fw-pacc-sub fw-pacc-nofile" title={t(`file.no.${format}`)}>
            {t(`file.none.${format}`)}
          </span>
        )
      return (
        <span className="fw-pacc-actions">
          {button(data.xml, 'xml')}
          {button(data.pdf, 'pdf')}
        </span>
      )
    }
    return [
      { colId: 'number', headerName: t('col.number'), flex: 0.8, minWidth: 150, sortable: false, valueGetter: ({ data }) => data?.number ?? '', cellClass: 'fw-pacc-mono' },
      { colId: 'date', headerName: t('col.date'), flex: 0.6, minWidth: 116, sortable: false, valueGetter: ({ data }) => (data ? dayWords(data.date, locale) : '') },
      { colId: 'party', headerName: t('col.party'), flex: 1.4, minWidth: 200, sortable: false, valueGetter: ({ data }) => data?.party ?? '' },
      { colId: 'kind', headerName: t('col.kind'), flex: 0.9, minWidth: 160, sortable: false, cellRenderer: Kind, valueGetter: ({ data }) => (data ? `${t(`kind.${data.kind}`)} · ${t(`side.${data.side}`)}` : '') },
      { colId: 'state', headerName: t('col.state'), flex: 1, minWidth: 200, sortable: false, cellRenderer: State, valueGetter: ({ data }) => (data ? t(`state.${data.state}`) : '') },
      { colId: 'files', headerName: t('col.files'), width: 196, minWidth: 196, maxWidth: 196, sortable: false, pinned: 'right', suppressHeaderMenuButton: true, cellRenderer: Files },
    ]
  }, [t, locale])
  const rows = model.invoices
  const chosen = model.selected.invoices
  const xmlCount = rows?.filter((row) => row.xml).length ?? 0
  const state: ReactNode = model.state === 'error' ? failed(t, actions?.onRetry) : rows && rows.length === 0 ? <EmptyState icon={<FileCode2 size={24} aria-hidden />} title={t('einvoices.empty')} description={t('einvoices.emptyBody')} /> : undefined
  return (
    <section className="fw-pacc-section" aria-labelledby="fw-pacc-einvoices">
      <div className="fw-pacc-head">
        <h2 id="fw-pacc-einvoices" className="fw-pacc-h2">
          {t('einvoices.title')}
        </h2>
        <p className="fw-pacc-sub">{t('einvoices.hint')}</p>
      </div>
      <ListFrame<InvoiceRow>
        label={t('einvoices.title')}
        title={t('einvoices.title')}
        listKey={null}
        rows={model.state === 'error' ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows && model.state !== 'error' ? t('count.invoices', { count: rows.length }) : ''}
        tools={
          <Button size="sm" heldReason={xmlCount === 0 ? t('held.noXml') : held('zip:XML')} onClick={() => actions?.onZipXml?.()}>
            <Archive size={13} aria-hidden /> {t('einvoices.allXml', { count: xmlCount })}
          </Button>
        }
        selection={{ selected: chosen, onChange: (ids) => actions?.onSelect?.('invoices', ids), actions: bulkButton(t, chosen.length, held('zip:invoices'), () => actions?.onZipChosen?.('invoices', chosen)) }}
        isRowSelectable={(row) => {
          const key = invoiceSelectable(row)
          return key ? t(key) : null
        }}
        keys={[{ keys: ['Enter'], does: t('keys.downloadInvoice') }]}
        onHelp={actions?.onHelp}
        onOpen={(row) => {
          const file = row.xml ?? row.pdf
          if (file) actions?.onDownload?.(file.id, file.name)
        }}
        state={state}
        cards={{}}
      />
    </section>
  )
}

// ── VAT and registers ────────────────────────────────────────────────────────────────────────────────────────────────
export function RegistersList({ model, actions }: { model: ListsModel; actions?: ListsActions }) {
  const t = useT(NS)
  const locale = useLocale()
  const held = useHeld(model)
  const latest = useRef({ model, actions, held })
  latest.current = { model, actions, held }
  const columns = useMemo((): ColDef<RegisterRow>[] => {
    const Standing = ({ data }: ICellRendererParams<RegisterRow>) => (data ? data.current ? <Pill tone="success">{t('registers.current')}</Pill> : <Pill tone="neutral">{t('registers.replacedBy', { number: data.replacedBy ?? '' })}</Pill> : null)
    const FileCell = ({ data }: ICellRendererParams<RegisterRow>) =>
      data ? (
        <span className="fw-pacc-two">
          <span className="fw-pacc-ellipsis fw-pacc-mono" title={data.name}>
            {data.name}
          </span>
          <span className="fw-pacc-sub">{t('row.fileSize', { format: data.format, size: sizeWords(data.sizeBytes, locale) })}</span>
        </span>
      ) : null
    const Actions = ({ data }: ICellRendererParams<RegisterRow>) =>
      data ? (
        <Button size="sm" heldReason={latest.current.held(data.id)} aria-label={t('row.downloadOf', { name: data.name })} onClick={() => latest.current.actions?.onDownload?.(data.id, data.name)}>
          <Download size={14} aria-hidden /> <span className="fw-pacc-btnword">{t('row.download')}</span>
        </Button>
      ) : null
    return [
      { colId: 'register', headerName: t('col.register'), flex: 1.1, minWidth: 190, sortable: false, valueGetter: ({ data }) => (data ? t(`package.${data.register}`) : '') },
      { colId: 'period', headerName: t('col.period'), flex: 0.7, minWidth: 130, sortable: false, valueGetter: ({ data }) => (data ? periodWords(data.month, locale) : '') },
      { colId: 'number', headerName: t('col.export'), flex: 0.7, minWidth: 140, sortable: false, valueGetter: ({ data }) => data?.number ?? '', cellClass: 'fw-pacc-mono' },
      { colId: 'standing', headerName: t('col.standing'), flex: 0.9, minWidth: 180, sortable: false, cellRenderer: Standing, valueGetter: ({ data }) => (data ? (data.current ? t('registers.current') : t('registers.replacedBy', { number: data.replacedBy ?? '' })) : '') },
      { colId: 'file', headerName: t('col.file'), flex: 1.4, minWidth: 220, sortable: false, cellRenderer: FileCell, valueGetter: ({ data }) => data?.name ?? '' },
      { colId: 'actions', headerName: t('col.actions'), width: 148, minWidth: 148, maxWidth: 148, sortable: false, pinned: 'right', suppressHeaderMenuButton: true, cellRenderer: Actions },
    ]
  }, [t, locale])
  const rows = model.registers
  const chosen = model.selected.registers
  const state: ReactNode = model.state === 'error' ? failed(t, actions?.onRetry) : rows && rows.length === 0 ? <EmptyState icon={<FileText size={24} aria-hidden />} title={t('registers.empty')} description={t('registers.emptyBody')} /> : undefined
  return (
    <section className="fw-pacc-section" aria-labelledby="fw-pacc-registers">
      <div className="fw-pacc-head">
        <h2 id="fw-pacc-registers" className="fw-pacc-h2">
          {t('registers.title')}
        </h2>
        <p className="fw-pacc-sub">{t('registers.hint')}</p>
      </div>
      <ListFrame<RegisterRow>
        label={t('registers.title')}
        title={t('registers.title')}
        listKey={null}
        rows={model.state === 'error' ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows && model.state !== 'error' ? t('count.files', { count: rows.length }) : ''}
        selection={{ selected: chosen, onChange: (ids) => actions?.onSelect?.('registers', ids), actions: bulkButton(t, chosen.length, held('zip:registers'), () => actions?.onZipChosen?.('registers', chosen)) }}
        keys={[{ keys: ['Enter'], does: t('keys.download') }]}
        onHelp={actions?.onHelp}
        onOpen={(row) => actions?.onDownload?.(row.id, row.name)}
        state={state}
        cards={{}}
      />
      {model.later.length > 0 ? (
        <p className="fw-pacc-later">
          {t('registers.later', { items: model.later.map((item) => t(`registers.laterItem.${item}`)).join(t('registers.join')) })}
        </p>
      ) : null}
    </section>
  )
}
