'use client'

import Link from 'next/link'
import { Download, FileX, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { dayInstant, money } from '../../../../_shared/model'
import type { RibaBatch } from '../../api'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES } from '../../depth'
import { cbiReceipts, maskIban, type CbiRecord } from '../../model'
import '../../../../_shared/finance.css'
import '../riba-file.css'

export type FileLoaded = { status: 'loading' } | { status: 'ready'; value: RibaBatch } | { status: 'not_found' } | { status: 'forbidden' } | { status: 'error'; problem: string }

/** The new tab "Ri.Ba. file download" — its view model (the view fetches nothing). */
export interface RibaFileModel {
  prefix: string
  price: boolean
  batch: FileLoaded
  /** The file's records read back from the store (null: not read yet); a store this browser cannot read is said. */
  records: { value: CbiRecord[] | null; problem: string | null }
  busy: boolean
  problem: string | null
}

export interface RibaFileActions {
  onRetry?: () => void
  onDownload?: () => void
}

/**
 * SCR-511 — the Ri.Ba. file (design finance.payments tab:riba-file "Ri.Ba. file download — a file for the bank"), opened in
 * its own tab from the batch: which batch it is (company, window, collecting account, receipts, total, when and by whom it
 * was made), Download (the CBI file exactly as kept on the batch, from a link that lives a minute: nothing is sent from
 * here — the person uploads it in the bank's site), and the file read back record by record (120 characters each) so it
 * can be checked before it goes. A draft has no file yet; a cancelled batch never gets one.
 */
export function RibaFileView({ model, actions }: { model: RibaFileModel; actions?: RibaFileActions }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <FileView model={model} actions={actions} />
    </WithMessages>
  )
}

function FileView({ model, actions }: { model: RibaFileModel; actions?: RibaFileActions }) {
  const p = useT(PAY_DEPTH)
  const t = useT('finance')
  const locale = useLocale()
  const back = <Link href={`${model.prefix}/finance/payments`}>{p('ribaFile.back')}</Link>
  const loaded = model.batch
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-fin">
        <div className="fw-fin-band">
          <DetailHeader backAsChild backLabel={back} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : p('ribaFile.title')} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-fin-hint" role="status">
              <Spinner size={14} /> {p('ribaFile.loading')}
            </p>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={p(`ribaFile.state.${loaded.status}.title`)}
              description={loaded.status === 'error' ? t(loaded.problem) : p(`ribaFile.state.${loaded.status}.body`)}
              action={
                loaded.status === 'error' ? (
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                ) : undefined
              }
            />
          </Card>
        )}
      </div>
    )
  }
  const batch = loaded.value
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const records = model.records.value
  return (
    <div className="fw-fin">
      <div className="fw-fin-band">
        <DetailHeader
          backAsChild
          backLabel={back}
          title={
            <span className="fw-fin-title">
              {batch.file ? batch.file.name : p('ribaFile.title')} <span className="fw-fin-title-sub">· {batch.company.name}</span>
            </span>
          }
          actions={
            batch.file ? (
              <Button size="sm" variant="primary" heldReason={model.busy ? t('common.working') : null} onClick={() => actions?.onDownload?.()}>
                <Download size={14} aria-hidden /> {p('ribaFile.download')}
              </Button>
            ) : undefined
          }
        />
      </div>
      {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      {!batch.file ? (
        <Card padded>
          <EmptyState icon={<FileX size={24} aria-hidden />} title={p(batch.status === 'CANCELLED' ? 'ribaFile.cancelled.title' : 'ribaFile.draft.title')} description={p(batch.status === 'CANCELLED' ? 'ribaFile.cancelled.body' : 'ribaFile.draft.body')} />
        </Card>
      ) : (
        <div className="fw-fin-cards fw-fin-cards--two">
          <Card padded className="fw-fin-card">
            <h2 className="fw-fin-h2">{p('ribaFile.what')}</h2>
            <KeyValue
              dense
              labelCase="sentence"
              columns={2}
              items={[
                { label: p('riba.col.window'), value: p('riba.window.range', { from: day(batch.dueFrom), to: day(batch.dueTo) }) },
                { label: p('riba.account'), value: `${maskIban(batch.bankAccount.iban)}${batch.bankAccount.bankName ? ` · ${batch.bankAccount.bankName}` : ''}` },
                { label: p('riba.col.receipts'), value: String(batch.count) },
                ...(model.price ? [{ label: p('riba.col.total'), value: money(batch.total, batch.currency, locale) }] : []),
                { label: p('ribaFile.size'), value: p('ribaFile.bytes', { count: batch.file.sizeBytes }) },
                { label: p('riba.issuedAt'), value: batch.issuedAt ? p('riba.issuedBy', { date: formatDateTime(batch.issuedAt, { locale }), name: batch.issuedBy?.name ?? p('riba.someone') }) : '—' },
              ]}
            />
            <p className="fw-fin-hint">{p('ribaFile.howTo')}</p>
            <p className="fw-fin-hint">{p('riba.rule')}</p>
          </Card>
          <Card padded className="fw-fin-card">
            <h2 className="fw-fin-h2">{p('ribaFile.records')}</h2>
            {model.records.problem ? (
              <p className="fw-fin-hint">{p('ribaFile.unreadable')}</p>
            ) : !records ? (
              <p className="fw-fin-hint" role="status">
                <Spinner size={12} /> {p('ribaFile.reading')}
              </p>
            ) : (
              <>
                <p className="fw-fin-hint">{p('ribaFile.recordsCount', { count: records.length, receipts: cbiReceipts(records) })}</p>
                <ol className="fw-rbf-records" aria-label={p('ribaFile.records')}>
                  {records.map((record, index) => (
                    <li key={index} className="fw-rbf-record">
                      <span className="fw-rbf-type">{p(`ribaFile.type.${/^(IB|14|20|30|40|50|51|70|EF)$/.test(record.type) ? record.type : 'other'}`)}</span>
                      <code className="fw-rbf-line">{record.text}</code>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
