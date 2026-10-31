'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, FileCode2, FileX, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { PAYMENT_METHODS } from '@nexus/factory-domain/sales/terms/terms'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Loaded } from '../../record/record-model'
import { parseXml, prettyXml, tagKey, valueWordsKey, versionOf, xmlSections, type XmlSection, type XmlView } from '../model'
import '../../../_shared/finance.css'
import '../xml.css'

/** SCR-081-xml — the readable XML's view model (InvoiceXmlView draws it and fetches nothing). */
export interface InvoiceXmlModel {
  /** `/w/<company>`. */
  prefix: string
  invoiceId: string
  /** The invoice (its number, type, customer, files); not found / no right / failed as the record says them. */
  invoice: Loaded<{ number: string | null; docType: string; partyName: string; status: string; filesPending: boolean; xmlFileId: string | null }>
  /** The legal file's text, read once from the store (null while it loads or when the invoice has none). */
  xml: { status: 'idle' | 'loading' | 'ready' | 'error'; text: string | null }
  view: XmlView
}

export interface InvoiceXmlActions {
  onRetry?: () => void
  onView?: (view: XmlView) => void
  onDownload?: () => void
}

/**
 * SCR-081-xml — the legal file shown readable (design finance.invoices tab:xml, opened in a new tab from the record's
 * Documents and ⋯, and the list's row verb): the band (‹ the invoice, "XML · <number> · <customer>", the FatturaPA version,
 * Readable ⇄ Source, Download), then the file's parts as a person checks them — transmission, seller, buyer, the document,
 * DDTs and orders, the lines, the VAT summary, the payment — each field in our words with its legal tag beside it; Source
 * shows the file itself, one element per line. Nothing is edited here: an issued invoice never changes.
 */
export function InvoiceXmlView({ model, actions }: { model: InvoiceXmlModel; actions?: InvoiceXmlActions }) {
  return (
    <WithMessages namespaces={['finance', 'finance-daily']}>
      <XmlPage model={model} actions={actions} />
    </WithMessages>
  )
}

function XmlPage({ model, actions }: { model: InvoiceXmlModel; actions?: InvoiceXmlActions }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const recordHref = `${model.prefix}/finance/invoices/${model.invoiceId}?tab=documents`
  const loaded = model.invoice
  const back = <Link href={recordHref}>{d('xml.back')}</Link>
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-fin">
        <div className="fw-fin-band">
          <DetailHeader backAsChild backLabel={back} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : d('xml.title')} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-fin-hint" role="status">
              <Spinner size={14} /> {d('xml.loading')}
            </p>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={t(`record.state.${loaded.status}.title`)}
              description={loaded.status === 'error' ? t(loaded.problem) : t(`record.state.${loaded.status}.body`)}
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
  const invoice = loaded.value
  const name = invoice.number ?? t('list.draft')
  // The XML is shown once it is stored, even while the courtesy PDF is still pending.
  const noFile = invoice.status === 'DRAFT' ? 'draft' : !invoice.xmlFileId ? 'pending' : null
  const version = model.xml.text ? versionOf(model.xml.text) : null
  return (
    <div className="fw-fin">
      <div className="fw-fin-band">
        <DetailHeader
          backAsChild
          backLabel={back}
          title={
            <span className="fw-fin-title">
              {d('xml.heading', { number: name })} <span className="fw-fin-title-sub">· {invoice.partyName}</span>
            </span>
          }
          actions={
            <span className="fw-fin-actions">
              {model.xml.status === 'ready' && (
                <Button size="sm" variant={model.view === 'source' ? 'tonal' : 'secondary'} active={model.view === 'source'} aria-pressed={model.view === 'source'} onClick={() => actions?.onView?.(model.view === 'source' ? 'readable' : 'source')}>
                  <FileCode2 size={14} aria-hidden /> {d(model.view === 'source' ? 'xml.showReadable' : 'xml.showSource')}
                </Button>
              )}
              <Button size="sm" variant="primary" heldReason={noFile ? d(`xml.none.${noFile}`) : null} onClick={() => actions?.onDownload?.()}>
                <Download size={14} aria-hidden /> {t('action.downloadXml')}
              </Button>
            </span>
          }
        />
        <div className="fw-fin-meta-row">
          <span className="fw-fin-meta">
            <Tag tone="neutral">{t('record.typeChip', { type: t(`docType.${invoice.docType}`), code: invoice.docType })}</Tag>
            {version && <Tag tone="info">{d('xml.version', { version })}</Tag>}
            <span className="fw-fin-hint">{d('xml.explain')}</span>
          </span>
        </div>
      </div>
      {noFile ? (
        <Card padded>
          <EmptyState title={d(`xml.none.${noFile}`)} description={d(`xml.none.${noFile}Body`)} />
        </Card>
      ) : model.xml.status === 'error' ? (
        <Card padded>
          <EmptyState
            title={d('xml.failed')}
            description={d('xml.failedBody')}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        </Card>
      ) : model.xml.status !== 'ready' || model.xml.text === null ? (
        <Card padded aria-busy="true">
          <p className="fw-fin-hint" role="status">
            <Spinner size={14} /> {d('xml.reading')}
          </p>
          <div className="fw-fin-stack">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} height={20} />
            ))}
          </div>
        </Card>
      ) : model.view === 'source' ? (
        <Card padded className="fw-fin-card">
          <h2 className="fw-fin-h2">{d('xml.sourceTitle')}</h2>
          <pre className="fw-fin-xml" tabIndex={0} aria-label={d('xml.sourceTitle')}>
            {prettyXml(model.xml.text)}
          </pre>
        </Card>
      ) : (
        <Readable text={model.xml.text} />
      )}
    </div>
  )
}

function Readable({ text }: { text: string }) {
  const d = useT('finance-daily')
  const sections = useMemo(() => xmlSections(parseXml(text)), [text])
  if (sections.length === 0) return <Banner tone="danger" title={d('xml.unreadable')}>{d('xml.unreadableBody')}</Banner>
  return (
    <div className="fw-fin-cards">
      {sections.map((section) => (
        <SectionCard key={section.id} section={section} />
      ))}
    </div>
  )
}

/** A tag in our words (or itself), with the legal tag beside it. */
function useTagWords() {
  const d = useT('finance-daily')
  return (tag: string): string => {
    const key = tagKey(tag)
    return key ? d(key) : tag
  }
}

function useValue() {
  const t = useT('finance')
  const d = useT('finance-daily')
  const locale = useLocale()
  return (tag: string, value: string): ReactNode => {
    if (tag === 'ModalitaPagamento' && Object.hasOwn(PAYMENT_METHODS, value)) return `${value} · ${PAYMENT_METHODS[value as keyof typeof PAYMENT_METHODS][locale]}`
    const words = valueWordsKey(tag, value)
    if (!words) return value === '' ? '—' : value
    return `${value} · ${words.ns === 'finance' ? t(words.key) : d(words.key)}`
  }
}

function SectionCard({ section }: { section: XmlSection }) {
  const d = useT('finance-daily')
  const words = useTagWords()
  const value = useValue()
  const wide = section.tables.length > 0
  return (
    <Card padded className={wide ? 'fw-fin-card fw-fin-card--wide' : 'fw-fin-card'}>
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">
          {words(section.tag)}
          {section.body > 0 ? ` · ${d('xml.body', { n: section.body + 1 })}` : ''}
        </h2>
        <span className="fw-fin-code">{section.tag}</span>
      </div>
      {section.fields.length > 0 && (
        <KeyValue
          dense
          labelCase="sentence"
          columns={2}
          items={section.fields.map((field) => {
            const tag = field.path[field.path.length - 1]!
            return {
              label: words(tag),
              value: <span className="fw-fin-code">{value(tag, field.value)}</span>,
              hint: field.path.join(' › '),
            }
          })}
        />
      )}
      {section.tables.map((table) => (
        <SummaryTable
          key={table.tag}
          label={words(table.tag)}
          columns={table.columns.map((column) => words(column[column.length - 1]!))}
          rows={table.rows.map((row, index) => ({ id: `${table.tag}-${index}`, cells: row.map((cell, at) => value(table.columns[at]![table.columns[at]!.length - 1]!, cell)) }))}
          stackOnPhone
        />
      ))}
    </Card>
  )
}
