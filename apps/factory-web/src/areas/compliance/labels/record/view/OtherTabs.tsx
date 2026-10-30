'use client'

import Link from 'next/link'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { Section } from '../../../../quality/_shared/parts'
import type { LabelDetail, PrintJob } from '../../api'
import { labelHref } from '../../model'
import { StatusPill } from '../../view/parts'
import type { LabelRecordActions, LabelRecordModel } from '../../view-model'

const JOB_TONE: Record<PrintJob['status'], 'neutral' | 'info' | 'success' | 'danger'> = { QUEUED: 'neutral', SENT: 'info', PRINTED: 'success', FAILED: 'danger' }

/** Versions (design lb-vers): every revision of the code and who uses this one — style revisions and work orders. */
export function VersionsTab({ detail, model }: { detail: LabelDetail; model: LabelRecordModel }) {
  const t = useT('labels')
  const locale = useLocale()
  const usage = detail.usage
  return (
    <div className="fw-q-two">
      <Section title={t('versions.title')} sub={t('versions.intro')}>
        <SummaryTable
          label={t('versions.title')}
          stackOnPhone
          columns={[t('versions.revision'), t('versions.status'), t('versions.updated')]}
          rows={[...detail.revisions]
            .sort((a, b) => b.revision - a.revision)
            .map((entry) => ({
              id: entry.id,
              cells: [
                entry.id === detail.id ? (
                  <b key="r">{t('versions.this', { revision: entry.revision })}</b>
                ) : (
                  <Link key="r" className="fw-q-link" href={labelHref(model.prefix, entry.id)}>
                    {t('versions.revisionN', { revision: entry.revision })}
                  </Link>
                ),
                <StatusPill key="s" status={entry.status} />,
                formatDateTime(entry.updatedAt, { locale }),
              ],
            }))}
        />
      </Section>
      <Section title={t('versions.usedBy')} sub={t('versions.usedByIntro')}>
        {usage.styleRevisions.length === 0 ? (
          <p className="fw-q-hint">{t('versions.noStyle')}</p>
        ) : (
          <SummaryTable
            label={t('versions.styleRevisions')}
            stackOnPhone
            columns={[t('versions.style'), t('versions.styleRevision'), t('versions.status')]}
            rows={usage.styleRevisions.map((entry) => ({
              id: entry.id,
              cells: [
                model.can.styles ? (
                  <Link key="s" className="fw-q-link fw-q-code" href={`${model.prefix}/products/styles/${encodeURIComponent(entry.styleId)}?tab=compliance&rev=${encodeURIComponent(entry.id)}`}>
                    {entry.styleCode}
                  </Link>
                ) : (
                  <span key="s" className="fw-q-code">
                    {entry.styleCode}
                  </span>
                ),
                t('versions.revisionN', { revision: entry.revision }),
                t(`revisionStatus.${entry.status}`),
              ],
            }))}
          />
        )}
        <h3 className="fw-lb-h3">{t('versions.workOrders', { count: usage.workOrders.count })}</h3>
        {usage.workOrders.count === 0 ? (
          <p className="fw-q-hint">{t('versions.noWorkOrders')}</p>
        ) : (
          <>
            <ul className="fw-lb-links">
              {usage.workOrders.shown.map((order) => (
                <li key={order.id}>
                  {model.can.workOrders ? (
                    <Link className="fw-q-link fw-q-code" href={`${model.prefix}/production/work-orders/${encodeURIComponent(order.id)}`}>
                      {order.number}
                    </Link>
                  ) : (
                    <span className="fw-q-code">{order.number}</span>
                  )}
                  {order.batchNumber && <span className="fw-q-hint"> · {t('versions.batch', { batch: order.batchNumber })}</span>}
                </li>
              ))}
            </ul>
            {usage.workOrders.shown.length < usage.workOrders.count && <p className="fw-q-hint">{t('versions.moreWorkOrders', { count: usage.workOrders.count - usage.workOrders.shown.length })}</p>}
          </>
        )}
      </Section>
    </div>
  )
}

/** Test prints (design lb-prints, as far as the print service serves it): every test print of this label revision. */
export function PrintsTab({ model, actions }: { model: LabelRecordModel; actions?: LabelRecordActions }) {
  const t = useT('labels')
  const q = useT('quality')
  const locale = useLocale()
  const prints = model.prints
  const printers = new Map((model.printers.value ?? []).map((printer) => [printer.id, printer]))
  return (
    <Card padded>
      <section className="fw-q-section" aria-labelledby="lb-prints">
        <div className="fw-q-section-head">
          <div className="fw-q-section-title">
            <h2 id="lb-prints">{t('prints.title')}</h2>
            <p className="fw-q-hint">{t('prints.intro')}</p>
          </div>
        </div>
        {prints.problem ? (
          <Banner
            tone="warning"
            title={t('prints.failed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetryPrints?.()}>
                {q('common.retry')}
              </Button>
            }
          >
            {q(prints.problem)}
          </Banner>
        ) : prints.value === null ? (
          <p className="fw-q-loading" role="status">
            <Spinner size={14} /> {q('common.loading')}
          </p>
        ) : prints.value.length === 0 ? (
          <EmptyState title={t('prints.empty')} description={t('prints.emptyBody')} />
        ) : (
          <SummaryTable
            label={t('prints.title')}
            stackOnPhone
            columns={[t('prints.when'), t('prints.printer'), t('prints.copies'), t('prints.state'), t('prints.action')]}
            rows={prints.value.map((job) => ({
              id: job.id,
              cells: [
                formatDateTime(job.createdAt, { locale }),
                printers.get(job.printerId)?.name ?? t('prints.unknownPrinter'),
                String(job.copies),
                <span key="s" className="fw-q-cell">
                  <Pill tone={JOB_TONE[job.status]} dot>
                    {t(`print.${job.status}`)}
                  </Pill>
                  {job.status === 'FAILED' && job.lastError && (
                    <span className="fw-q-hint" lang="en">
                      {job.lastError}
                    </span>
                  )}
                </span>,
                job.status === 'FAILED' ? (
                  <Button key="r" size="sm" onClick={() => actions?.onRetryJob?.(job.id)} heldReason={model.can.printView ? null : t('held.noPrint')}>
                    {t('test.retry')}
                  </Button>
                ) : (
                  <Tag key="r" tone="neutral">
                    {t('prints.test')}
                  </Tag>
                ),
              ],
            }))}
          />
        )}
        <p className="fw-q-hint">{t('prints.garmentLabels')}</p>
      </section>
    </Card>
  )
}
