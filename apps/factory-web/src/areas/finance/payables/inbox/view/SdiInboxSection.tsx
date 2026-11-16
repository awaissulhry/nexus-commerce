'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { FileCode2, Inbox } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Phrase } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import type { InboxItem, InboxList, InboxStatus } from '../api'
import { dismissHeld, fileHeld, INBOX_ROWS, inboxShown, reasonProblem, type InboxCan, type InboxRows } from '../model'
import '../../../_shared/finance.css'

export const INBOX = 'payables-inbox'

export interface SdiInboxModel {
  prefix: string
  can: InboxCan
  rows: InboxRows
  list: { value: InboxList | null; problem: string | null }
  dismissing: InboxItem | null
  reason: string
  busy: boolean
  writeProblem: Phrase | null
  notice: Phrase | null
  /** The file could not be opened (a finance message key). */
  fileProblem: string | null
}

export interface SdiInboxActions {
  onRows?: (rows: InboxRows) => void
  onDismiss?: (item: InboxItem | null) => void
  onReason?: (reason: string) => void
  onConfirmDismiss?: () => void
  onReopen?: (item: InboxItem) => void
  onOpenFile?: (item: InboxItem) => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

const STATUS_TONE: Readonly<Record<InboxStatus, 'warning' | 'success' | 'neutral'>> = { OPEN: 'warning', RECORDED: 'success', DISMISSED: 'neutral' }

/**
 * B-W2b-GB02 — the SDI inbox on Finance › Payables (B-W2b-21's routes; G088 keeps the file): every delivery SDI handed the
 * company that the pickup could not record, when it arrived, the file and its SDI number, why it waits (in words from the
 * code), how often it was tried, its state; open the file SDI handed over, dismiss one with the reason (payables.manage; it
 * is not tried again), reopen a dismissed one. The rows: waiting (default), dismissed, recorded, every one. Not drawn while
 * nothing ever waited.
 */
export function SdiInboxSection({ model, actions }: { model: SdiInboxModel; actions?: SdiInboxActions }) {
  if (!model.can.view || !inboxShown(model.list.value, model.rows, model.list.problem)) return null
  return (
    <WithMessages namespaces={['finance', INBOX]}>
      <Section model={model} actions={actions} />
    </WithMessages>
  )
}

function Section({ model, actions }: { model: SdiInboxModel; actions?: SdiInboxActions }) {
  const t = useT('finance')
  const n = useT(INBOX)
  const locale = useLocale()
  const items = model.list.value?.items ?? null
  const columns = useMemo<ColDef<InboxItem>[]>(() => {
    const Received = ({ data }: ICellRendererParams<InboxItem>) =>
      data ? (
        <span className="fw-fin-cell">
          <span>{formatDate(data.receivedAt, { locale })}</span>
          <span className="fw-fin-cell-sub">{formatTime(data.receivedAt, { locale })}</span>
        </span>
      ) : null
    const File = ({ data }: ICellRendererParams<InboxItem>) =>
      data ? (
        <span className="fw-fin-cell">
          <span className="fw-fin-code">{data.fileName}</span>
          <span className="fw-fin-cell-sub">{n('sdiNumber', { number: data.sdiIdentifier })}</span>
        </span>
      ) : null
    const Why = ({ data }: ICellRendererParams<InboxItem>) => (data ? <span>{n(`problem.${data.problem}`)}</span> : null)
    const Tried = ({ data }: ICellRendererParams<InboxItem>) =>
      data ? (
        <span className="fw-fin-cell">
          <span>{n('tried', { count: data.attempts })}</span>
          <span className="fw-fin-cell-sub">{n('lastTried', { date: formatDate(data.lastTriedAt, { locale }) })}</span>
        </span>
      ) : null
    const State = ({ data }: ICellRendererParams<InboxItem>) =>
      data ? (
        <span className="fw-fin-cell">
          <Pill tone={STATUS_TONE[data.status]}>{n(`status.${data.status}`)}</Pill>
          {data.dismissed && <span className="fw-fin-cell-sub">{data.dismissed.reason}</span>}
          {data.recorded?.supplierInvoiceId && (
            <Link className="fw-fin-link" href={`${model.prefix}/finance/payables/${data.recorded.supplierInvoiceId}`}>
              {n('openInvoice')}
            </Link>
          )}
        </span>
      ) : null
    const Actions = ({ data }: ICellRendererParams<InboxItem>) => {
      if (!data) return null
      const file = fileHeld(data, model.can)
      const dismiss = dismissHeld(data, model.can, model.busy)
      return (
        <span className="fw-fin-inline">
          <Button size="sm" variant="quiet" heldReason={file ? n(file.key) : null} onClick={() => actions?.onOpenFile?.(data)} aria-label={`${n('openFile')} · ${data.fileName}`}>
            <FileCode2 size={13} aria-hidden /> {n('openFile')}
          </Button>
          {data.status === 'DISMISSED' ? (
            <Button size="sm" heldReason={!model.can.manage ? n('held.noManage') : model.busy ? n('held.busy') : null} onClick={() => actions?.onReopen?.(data)}>
              {n('reopen')}
            </Button>
          ) : (
            <Button size="sm" heldReason={dismiss ? n(dismiss.key) : null} onClick={() => actions?.onDismiss?.(data)}>
              {n('dismiss.go')}
            </Button>
          )}
        </span>
      )
    }
    return [
      { colId: 'received', headerName: n('col.received'), minWidth: 120, flex: 0.7, cellRenderer: Received },
      { colId: 'file', headerName: n('col.file'), minWidth: 220, flex: 1.4, cellRenderer: File },
      { colId: 'why', headerName: n('col.why'), minWidth: 220, flex: 1.6, cellRenderer: Why },
      { colId: 'tried', headerName: n('col.tried'), minWidth: 120, flex: 0.7, cellRenderer: Tried },
      { colId: 'state', headerName: n('col.state'), minWidth: 150, flex: 1, cellRenderer: State },
      { colId: 'actions', headerName: n('col.actions'), minWidth: 230, flex: 1, sortable: false, cellRenderer: Actions },
    ]
  }, [n, locale, model.can, model.busy, model.prefix, actions])
  const counts = model.list.value?.counts
  return (
    <section className="fw-fin-section" id="fw-sdi-inbox" aria-labelledby="fw-sdi-inbox-title">
      <div className="fw-fin-section-head">
        <h2 className="fw-fin-h2" id="fw-sdi-inbox-title">
          <Inbox size={16} aria-hidden /> {n('title')}
        </h2>
        <p className="fw-fin-hint">{n('explain')}</p>
      </div>
      {model.notice && (
        <Banner
          tone="success"
          title={n(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {model.fileProblem && <Banner tone="danger" title={n('fileFailed', { why: t(model.fileProblem) })} />}
      <ListFrame<InboxItem>
        label={n('title')}
        rows={model.list.problem ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={counts ? n('count', { open: counts.open, dismissed: counts.dismissed }) : '—'}
        tools={
          <Select size="sm" aria-label={n('rowsLabel')} value={model.rows} onChange={(event) => actions?.onRows?.(event.target.value as InboxRows)}>
            {INBOX_ROWS.map((rows) => (
              <option key={rows} value={rows}>
                {n(`rows.${rows}`)}
              </option>
            ))}
          </Select>
        }
        state={
          model.list.problem ? (
            <p className="fw-fin-hint">
              {n('failed', { why: t(model.list.problem) })}{' '}
              <Button size="sm" variant="link" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            </p>
          ) : items && items.length === 0 ? (
            <p className="fw-fin-hint">{n(`empty.${model.rows}`)}</p>
          ) : undefined
        }
      />
      {model.dismissing && <DismissDialog model={model} item={model.dismissing} actions={actions} />}
    </section>
  )
}

function DismissDialog({ model, item, actions }: { model: SdiInboxModel; item: InboxItem; actions?: SdiInboxActions }) {
  const t = useT('finance')
  const n = useT(INBOX)
  const problem = reasonProblem(model.reason)
  const held = model.busy ? n('held.busy') : problem ? n(problem.key, problem.params) : null
  return (
    <DialogFrame title={n('dismiss.title', { file: item.fileName })} held={held} go={() => actions?.onConfirmDismiss?.()} goLabel={model.busy ? t('common.working') : n('dismiss.confirm')} onClose={() => actions?.onDismiss?.(null)} problem={model.writeProblem}>
      <p className="fw-fin-hint">{n('dismiss.explain')}</p>
      <Field label={n('dismiss.reason')} hint={n('dismiss.hint')}>
        <Textarea value={model.reason} rows={3} maxLength={500} onChange={(event) => actions?.onReason?.(event.target.value)} />
      </Field>
    </DialogFrame>
  )
}
