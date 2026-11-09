'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { CircleCheck, Download, FileCode2, FileText, Lock } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { bulkDownloadHeld, dueWords, isLive, payHeld, sdiTone, type PayFacts, type PayRow } from '../model'
import { useDocumentWords } from '../words'

/**
 * SCR-186 › To pay (design portal.customer.documents sec:open-items "Open invoices and their status"; FIN-118, SAL-083,
 * SAL-089) for the customer's Finance and Admin (portal.payments.view, the price grain): invoice number · date · due date
 * (overdue in words) · amount still open · the SDI delivery state · the PDF (courtesy copy) and the XML (the legal
 * invoice), each in a new tab · Pay (card or SEPA, the pop-up) — held with the reason where it cannot be paid online (the
 * bank transfer is always there). Open deposit requests are listed too (paid the same way). On the shared list frame:
 * "Download N" PDFs while rows are selected. The statement of account is the band's primary (a new tab).
 */

export interface ToPayModel {
  state: 'loading' | 'error' | 'ready'
  rows: readonly PayRow[] | null
  /** What is open per currency, written ("2.480,00 €"), and what of it is overdue. */
  totals: readonly { open: string; overdue: string | null }[]
  overdue: number
  facts: PayFacts
  /** Today in the site's zone (YYYY-MM-DD). */
  today: string
  selected: readonly string[]
  busy: string | null
  /** Why nothing may be opened now (a preview, offline), a key. */
  held: string | null
  keysOpen?: boolean
}

export interface ToPayActions {
  onPay?: (row: PayRow) => void
  onTab?: (row: PayRow, fileId: string, contentType: string) => void
  onSelect?: (ids: string[]) => void
  onDownloadMany?: (ids: readonly string[]) => void
  onRetry?: () => void
  onHelp?: () => void
}

export function ToPaySection({ model, actions }: { model: ToPayModel; actions?: ToPayActions }) {
  const { t, day, money } = useDocumentWords()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }

  const columns = useMemo((): ColDef<PayRow>[] => {
    const NumberCell = ({ data }: ICellRendererParams<PayRow>) => {
      if (!data) return null
      const payment = data.payment
      return (
        <span className="fw-pdoc-two">
          <span className="fw-pdoc-title fw-pdoc-ellipsis" title={data.target.kind === 'invoice' ? data.number : t('pay.depositFor', { number: data.number })}>
            {data.target.kind === 'invoice' ? data.number : t('pay.depositFor', { number: data.number })}
          </span>
          <span className="fw-pdoc-sub fw-pdoc-ellipsis">
            {data.target.kind === 'invoice' ? t(`docType.${docTypeKey(data.docType)}`) : t('pay.deposit')}
            {payment && isLive(payment.status) ? ` · ${t('pay.underWay')}` : payment?.status === 'FAILED' ? ` · ${t('pay.lastFailed')}` : ''}
          </span>
        </span>
      )
    }
    const DueCell = ({ data }: ICellRendererParams<PayRow>) => {
      if (!data) return null
      const due = dueWords(data, latest.current.model.today)
      return (
        <span className="fw-pdoc-two">
          <span className={due.tone === 'danger' ? 'fw-pdoc-danger' : due.tone === 'warning' ? 'fw-pdoc-warn' : undefined}>
            {t(due.key, { ...due.params, ...(due.params?.date ? { date: day(String(due.params.date)) } : {}) })}
          </span>
          {due.key === 'due.overdue' ? <span className="fw-pdoc-sub">{t('due.was', { date: day(data.dueDate) })}</span> : null}
        </span>
      )
    }
    const AmountCell = ({ data }: ICellRendererParams<PayRow>) => {
      if (!data) return null
      if (data.open === null) return <span>—</span>
      const partly = data.total !== null && data.total !== data.open
      return (
        <span className="fw-pdoc-two fw-pdoc-num">
          <span className="fw-pdoc-title">{money(data.open, data.currency)}</span>
          {partly ? <span className="fw-pdoc-sub">{t('pay.ofTotal', { total: money(data.total!, data.currency) })}</span> : null}
        </span>
      )
    }
    const SdiCell = ({ data }: ICellRendererParams<PayRow>) => (data ? data.sdiStatus ? <Pill tone={sdiTone(data.sdiStatus)}>{t(`sdi.${sdiKey(data.sdiStatus)}`)}</Pill> : <span>—</span> : null)
    const FilesCell = ({ data }: ICellRendererParams<PayRow>) => {
      if (!data) return null
      const now = latest.current.model
      const held = now.held ? t(now.held) : now.busy === data.key ? t('row.opening') : null
      if (!data.pdfFileId && !data.xmlFileId) return <span>—</span>
      return (
        <span className="fw-pdoc-files">
          {data.pdfFileId ? (
            <Button size="sm" variant="quiet" heldReason={held} aria-label={t('pay.pdfOf', { number: data.number })} onClick={() => latest.current.actions?.onTab?.(data, data.pdfFileId!, 'application/pdf')}>
              <FileText size={14} aria-hidden /> PDF
            </Button>
          ) : null}
          {data.xmlFileId ? (
            <Button size="sm" variant="quiet" heldReason={held} aria-label={t('pay.xmlOf', { number: data.number })} onClick={() => latest.current.actions?.onTab?.(data, data.xmlFileId!, 'application/xml')}>
              <FileCode2 size={14} aria-hidden /> XML
            </Button>
          ) : null}
        </span>
      )
    }
    const PayCell = ({ data }: ICellRendererParams<PayRow>) => {
      if (!data) return null
      const now = latest.current.model
      const live = data.payment && isLive(data.payment.status)
      const held = payHeld(data, now.facts)
      return (
        <Button size="sm" variant={live ? 'secondary' : 'primary'} heldReason={held ? t(held) : null} aria-haspopup="dialog" aria-label={t(live ? 'pay.followOf' : 'pay.payOf', { number: data.number })} onClick={() => latest.current.actions?.onPay?.(data)}>
          {held ? <Lock size={13} aria-hidden /> : null}
          {t(live ? 'pay.follow' : 'pay.pay')}
        </Button>
      )
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<PayRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<PayRow> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      { ...column('number', t('pay.col.number'), NumberCell, { flex: 1.4, minWidth: 220 }), valueGetter: ({ data }) => (data ? (data.target.kind === 'invoice' ? data.number : t('pay.depositFor', { number: data.number })) : '') },
      { ...column('date', t('pay.col.date'), undefined, { flex: 0.6, minWidth: 110 }), valueGetter: ({ data }) => (data?.issueDate ? day(data.issueDate) : '—') },
      { ...column('due', t('pay.col.due'), DueCell, { flex: 0.9, minWidth: 160 }), valueGetter: ({ data }) => (data ? day(data.dueDate) : '') },
      { ...column('amount', t('pay.col.amount'), AmountCell, { flex: 0.8, minWidth: 140 }), valueGetter: ({ data }) => (data && data.open !== null ? money(data.open, data.currency) : '—'), cellClass: 'fw-pdoc-numcell', headerClass: 'fw-pdoc-numcell' },
      { ...column('sdi', t('pay.col.sdi'), SdiCell, { flex: 0.9, minWidth: 180 }), valueGetter: ({ data }) => (data?.sdiStatus ? t(`sdi.${sdiKey(data.sdiStatus)}`) : '—') },
      { ...column('files', t('pay.col.files'), FilesCell, { flex: 0.7, minWidth: 200 }), valueGetter: () => '' },
      { ...column('pay', t('pay.col.pay'), PayCell, { width: 128, minWidth: 128, maxWidth: 128 }), pinned: 'right', suppressHeaderMenuButton: true },
    ]
  }, [t, day, money])

  const rows = model.rows
  const selected = model.selected
  const bulkHeld = bulkDownloadHeld(selected.length, model.held)
  const bulk = (
    <Button size="sm" heldReason={bulkHeld ? t(bulkHeld.key, bulkHeld.params) : null} onClick={() => actions?.onDownloadMany?.(selected)} aria-label={t('pay.bulk', { count: selected.length })}>
      <Download size={13} aria-hidden /> <SelectionLabel>{t('pay.bulk', { count: selected.length })}</SelectionLabel>
    </Button>
  )
  const state: ReactNode =
    model.state === 'error' ? (
      <EmptyState title={t('pay.failed')} description={t('pay.failedBody')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
    ) : rows !== null && rows.length === 0 ? (
      <EmptyState icon={<CircleCheck size={24} aria-hidden />} title={t('pay.empty')} description={t('pay.emptyBody')} />
    ) : undefined

  return (
    <section className="fw-pdoc-section fw-pdoc-topay" aria-labelledby="fw-pdoc-topay">
      <div className="fw-pdoc-head">
        <div className="fw-pdoc-headtext">
          <h2 id="fw-pdoc-topay" className="fw-pdoc-h2">
            {t('pay.title')}
          </h2>
          <p className="fw-pdoc-sub">
            {model.totals.length > 0
              ? model.totals.map((total) => (total.overdue ? t('pay.totalOverdue', { open: total.open, overdue: total.overdue }) : t('pay.total', { open: total.open }))).join(' · ')
              : t('pay.hint')}
          </p>
        </div>
      </div>
      <ListFrame<PayRow>
        label={t('pay.label')}
        title={t('pay.title')}
        listKey={null}
        rows={model.state === 'error' ? [] : rows}
        rowId={(row) => row.key}
        columns={columns}
        count={rows && model.state !== 'error' ? (model.overdue > 0 ? t('pay.countOverdue', { count: rows.length, overdue: model.overdue }) : t('pay.count', { count: rows.length })) : ''}
        selection={{ selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        isRowSelectable={(row) => (row.pdfFileId ? null : t('pay.noPdf'))}
        onHelp={actions?.onHelp}
        onOpen={(row) => actions?.onPay?.(row)}
        state={state}
        cards={{}}
        keysOpen={model.keysOpen}
      />
    </section>
  )
}

/** The fiscal type's words (`docType.<key>`): an invoice, a deposit invoice, a credit note, else an invoice. */
export const docTypeKey = (docType: string | null): 'TD01' | 'TD02' | 'TD04' | 'TD24' | 'OTHER' => (docType === 'TD01' || docType === 'TD02' || docType === 'TD04' || docType === 'TD24' ? docType : 'OTHER')

const SDI_KEYS = new Set(['ISSUED', 'SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'ERROR'])
export const sdiKey = (status: string): string => (SDI_KEYS.has(status) ? status : 'OTHER')
