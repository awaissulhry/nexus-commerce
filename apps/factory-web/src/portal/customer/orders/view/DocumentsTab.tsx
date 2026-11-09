'use client'

import { Download, Eye, FileText, Lock } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { FileRow } from '../../../../lib/i18n/ds-parts'
import type { OrderDocument } from '../api'
import { documentsInOrder } from '../model'
import { useOrderWords } from '../words'
import { Loading, PricesNote, ReadFailed } from './parts'
import type { OrderRecordActions, OrderRecordViewModel } from './OrderRecordView'

/**
 * Order › Documents (design rec "Order" tab documents; SAL-086, SAL-092): every document of the order the person's role may
 * see — order confirmation versions, delivery papers, invoices and credit notes (finance), declarations of conformity,
 * certificates and test reports (quality) — by version with its fingerprint ("v3 · 3f9a1c…"); an earlier version names the
 * one that replaced it. Preview in place (PDF) and download, both logged. "Download all as zip" is Later (SAL-091).
 */
export function DocumentsTab({ model, actions }: { model: OrderRecordViewModel; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t } = words
  const documents = model.documents
  if (documents.state === 'noAccess') return <EmptyState icon={<Lock size={24} aria-hidden />} title={t('docs.noAccess')} description={t('docs.noAccessBody')} />
  if (documents.state === 'loading') return <Loading rows={3} height={52} />
  if (documents.state === 'error' || !documents.read) return <ReadFailed title={t('docs.failed')} onRetry={actions?.onRetryDocuments} />
  const read = documents.read
  return (
    <div className="fw-pord-tab">
      {!read.seesPrices ? <PricesNote /> : null}
      {read.items.length === 0 ? (
        <EmptyState icon={<FileText size={24} aria-hidden />} title={t('docs.none')} description={t('docs.noneBody')} />
      ) : (
        <div className="fw-pord-stack" role="list" aria-label={t('docs.label')}>
          {documentsInOrder(read.items).map((doc) => (
            <div role="listitem" key={doc.id} className={doc.current ? undefined : 'fw-pord-old'}>
              <DocumentRow doc={doc} model={model} actions={actions} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DocumentRow({ doc, model, actions }: { doc: OrderDocument; model: OrderRecordViewModel; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, locale, at } = words
  const pdf = doc.files.find((file) => file.format === 'PDF') ?? null
  const status = (
    <span className="fw-pord-docline">
      <span>{[doc.kindWords[locale], t('docs.versionPrint', { version: doc.version, fingerprint: doc.fingerprint }), at(doc.date)].join(' · ')}</span>
      {doc.grossTotal != null && doc.currency ? <span>{words.money(doc.grossTotal, doc.currency)}</span> : null}
      {doc.replacedBy ? <span className="fw-pord-moved">{t('docs.replacedBy', { version: doc.replacedBy.version })}</span> : null}
      {doc.new ? <Pill tone="info">{t('docs.new')}</Pill> : null}
    </span>
  )
  return (
    <FileRow
      name={doc.title[locale]}
      status={status}
      actions={
        <>
          {pdf ? (
            <Button size="sm" variant="quiet" heldReason={model.fileHeld} onClick={() => actions?.onPreview?.({ fileId: pdf.fileId, title: doc.title[locale] })}>
              <Eye size={13} aria-hidden /> {t('docs.preview')}
            </Button>
          ) : null}
          {doc.files.map((file) => (
            <Button key={file.fileId} size="sm" variant="quiet" heldReason={model.fileHeld} onClick={() => actions?.onDownload?.({ fileId: file.fileId, name: file.name })} aria-label={t('docs.downloadOf', { format: file.format, title: doc.title[locale] })}>
              <Download size={13} aria-hidden /> {doc.files.length > 1 ? t(`docs.format.${file.format}`) : t('docs.download')}
            </Button>
          ))}
        </>
      }
    />
  )
}
