'use client'

import Link from 'next/link'
import { Download, ExternalLink, MoreHorizontal, Plus } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu } from '@nexus/ui/components'
import { DocumentSeal } from '@nexus/ui/components/DocumentSeal/index'
import { Button, RadioCard } from '@nexus/ui/primitives'
import { FileRow, JobProgress, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { TIME_ZONE } from '../../_shared/model'
import type { ExportRecord, Layout, PayrollMonth } from '../api'
import { activeLayouts, fileHeld, fileHref, fileOf, makeHeld, monthWords, nextRevision, recordHref, sendRowHeld, type PayrollCan } from '../model'
import type { PayrollActions, PayrollModel, WizardModel } from '../view-model'
import { LayoutTag, LayoutWarning, NotPayroll, SectionLoading, ToConfirm, usePayrollWords, useSaid } from './parts'

/**
 * 5 · Export and send (design sec:step-send): the format (a provider layout nobody confirmed says so, here and on every screen that
 * shows it), the file's version, one request that makes the file and its summary, then the seal, the two files, Send and Done.
 * The file is by employee code, never by name. A month with a file shows that file; a correction is the dialog's Make v2.
 */
export function SendStep({ model, wizard, month, actions }: { model: PayrollModel; wizard: WizardModel; month: PayrollMonth; actions?: PayrollActions | undefined }) {
  const t = usePayrollWords()
  const said = useSaid()
  const locale = useLocale()
  const made = wizard.record?.status === 'ready' ? wizard.record.value : null
  const hasFile = made !== null || month.latest !== null
  const reading = wizard.record?.status === 'loading' || (!wizard.record && month.latest !== null)
  const label = monthWords(month.month, locale)
  const held = makeHeld({ month, can: model.can, layout: model.layout, busy: wizard.making.busy })
  return (
    <div className="fw-pp-stack">
      {!hasFile && <FormatCard model={model} hasFile={false} actions={actions} />}
      <Card padded className="fw-pay-card">
        <h3 className="fw-pp-h3">{t('step.send.title')}</h3>
        {reading && <SectionLoading words={t('step.reading', { step: t('step.send.title') })} rows={3} />}
        {wizard.record?.status === 'error' && <EmptyState title={t('step.failed', { step: t('step.send.title') })} description={t(wizard.record.problem)} action={<Button size="sm" onClick={() => actions?.onRetryRecord?.()}>{t('common.retry')}</Button>} />}
        {made ? (
          <>
            {month.state === 'CORRECTION_PENDING' && month.latest?.id === made.id && (
              <Banner
                tone="warning"
                title={t('send.pending', { people: month.correction?.people ?? 0, values: month.correction?.values ?? 0, version: made.revision })}
                action={
                  <Button size="sm" variant="primary" onClick={() => actions?.onOpenCorrect?.(made)}>
                    {t('send.makeNext', { version: made.revision + 1 })}
                  </Button>
                }
              >
                {t('send.pendingBody')}
              </Banner>
            )}
            {month.state === 'EXPORTED' && <p className="fw-pp-hint">{t('send.fileOf', { version: made.revision, month: label })}</p>}
            <FileCard prefix={model.prefix} can={model.can} record={made} {...(actions ? { actions } : {})} />
          </>
        ) : !hasFile ? (
          <>
            <KeyValue
              dense
              columns={2}
              items={[
                { label: t('send.month'), value: label },
                { label: t('send.version'), value: `v${nextRevision(month)}`, hint: t('send.versionHint') },
                { label: t('send.people'), value: String(month.people) },
                { label: t('send.format'), value: model.layout?.name ?? t('aside.noFormat') },
              ]}
            />
            <Field label={t('send.note')} hint={t('send.noteHint')}>
              <Textarea value={wizard.note} maxLength={500} rows={2} onChange={(event) => actions?.onNote?.(event.target.value)} />
            </Field>
            {month.carriesPay && <p className="fw-pp-hint">{t('send.carriesPay')}</p>}
            {wizard.making.problem && <Banner tone="danger" title={said(wizard.making.problem)} />}
            {wizard.making.busy && <JobProgress label={t('send.making', { month: label })} {...(wizard.making.startedAt ? { startedAt: wizard.making.startedAt } : {})} detail={t('send.makingDetail')} />}
            <div className="fw-pp-row">
              <Button size="sm" variant="primary" heldReason={held ? said(held) : null} onClick={() => actions?.onMake?.()}>
                {t('send.make', { month: label, version: nextRevision(month) })}
              </Button>
            </div>
          </>
        ) : null}
        <NotPayroll />
      </Card>
      {hasFile && <FormatCard model={model} hasFile actions={actions} />}
    </div>
  )
}

/** The formats of the company: choose one, add one from a starter, its columns, its confirmation. */
function FormatCard({ model, hasFile, actions }: { model: PayrollModel; hasFile: boolean; actions?: PayrollActions | undefined }) {
  const t = usePayrollWords()
  const layouts = model.layouts
  const starters = layouts.status === 'ready' ? layouts.value.starters : []
  const rows = layouts.status === 'ready' ? activeLayouts(layouts.value.layouts) : []
  return (
    <Card padded className="fw-pay-card">
      <div className="fw-pay-section-head">
        <h3 className="fw-pp-h3">{t('format.title')}</h3>
        {model.can.manage && starters.length > 0 && (
          <Menu
            align="right"
            label={
              <>
                <Plus size={14} aria-hidden /> {t('format.add')}
              </>
            }
            triggerProps={{ 'aria-label': t('format.add') }}
            items={starters.map((starter) => ({ id: starter.key, label: t(`starter.${starter.key}`), onSelect: () => actions?.onAddLayout?.(starter.key) }))}
          />
        )}
      </div>
      <p className="fw-pp-hint">{t(hasFile ? 'format.leadFile' : 'format.lead')}</p>
      {layouts.status === 'loading' && <SectionLoading words={t('format.reading')} rows={2} />}
      {layouts.status === 'error' && <EmptyState title={t('format.failed')} description={t(layouts.problem)} action={<Button size="sm" onClick={() => actions?.onRetryLayouts?.()}>{t('common.retry')}</Button>} />}
      {layouts.status === 'ready' && rows.length === 0 && <EmptyState title={t('format.none.title')} description={t('format.none.body')} />}
      <div className="fw-pay-formats" role="radiogroup" aria-label={t('format.title')}>
        {rows.map((layout) => (
          <div key={layout.id} className="fw-pay-format">
            <RadioCard
              name="fw-pay-format"
              title={
                <span className="fw-pp-row">
                  {layout.name} <LayoutTag layout={layout} />
                </span>
              }
              description={t('format.description', { format: t(`format.${layout.format}`), count: layout.definition.columns.length })}
              checked={model.layout?.id === layout.id}
              selected={model.layout?.id === layout.id}
              onChange={() => actions?.onLayout?.(layout.id)}
            />
            <LayoutMenu layout={layout} can={model.can} actions={actions} />
          </div>
        ))}
      </div>
      <LayoutWarning layout={model.layout} />
      {model.layout?.provider && <ToConfirm />}
    </Card>
  )
}

function LayoutMenu({ layout, can, actions }: { layout: Layout; can: PayrollCan; actions?: PayrollActions | undefined }) {
  const t = usePayrollWords()
  const held = can.manage ? null : t('held.noManage')
  return (
    <Menu
      align="right"
      label={<MoreHorizontal size={16} aria-hidden />}
      triggerProps={{ 'aria-label': t('format.menu', { name: layout.name }) }}
      items={[
        { id: 'columns', label: t(layout.format === 'FIXED_WIDTH' ? 'format.columnsFixed' : 'format.columns'), onSelect: () => actions?.onOpenColumns?.(layout), ...(held ? { disabled: true, description: held } : {}) },
        ...(layout.provider ? [{ id: 'confirm', label: t('format.confirm'), onSelect: () => actions?.onOpenConfirm?.(layout), ...(held ? { disabled: true, description: held } : {}) }] : []),
        { id: 'archive', label: t('format.archive'), tone: 'danger' as const, onSelect: () => actions?.onArchiveLayout?.(layout), ...(held ? { disabled: true, description: held } : {}) },
      ]}
    />
  )
}

/** A file made: its seal, the two files (each opening recorded), Send. */
export function FileCard({ prefix, can, record, actions, withRecordLink = true }: { prefix: string; can: PayrollCan; record: ExportRecord; actions?: PayrollActions | Pick<PayrollActions, 'onDownload' | 'onOpenSend'>; withRecordLink?: boolean }) {
  const t = usePayrollWords()
  const said = useSaid()
  const locale = useLocale()
  const ds = useDsWords()
  const data = fileOf(record, 'data')
  const summary = fileOf(record, 'summary')
  const held = fileHeld(record, can)
  const send = sendRowHeld(record, can)
  const place = { locale, timeZone: TIME_ZONE }
  return (
    <div className="fw-pp-stack">
      <LayoutWarning layout={record.layout} />
      {record.seal && (
        <DocumentSeal
          title={t('file.seal', { month: monthWords(record.month, locale) })}
          version={`v${record.revision}`}
          sha256={record.seal}
          sealedAt={record.exportedAt ? formatDateTime(record.exportedAt, place) : '—'}
          timestampSource={t('file.clock')}
          {...(record.madeBy?.name ? { sealedBy: record.madeBy.name } : {})}
          labels={ds.documentSeal}
        />
      )}
      <ul className="fw-pay-files" aria-label={t('file.list', { version: record.revision })}>
        {summary && (
          <li>
            <FileRow
              name={summary.name}
              size={summary.sizeBytes}
              status={t('file.summaryKind', { count: summary.rowCount })}
              actions={
                held ? (
                  <Button size="sm" heldReason={said(held)}>
                    {t('file.open')}
                  </Button>
                ) : (
                  <Button asChild size="sm">
                    <a href={fileHref(prefix, record.id, 'summary')} target="_blank" rel="noopener noreferrer">
                      <ExternalLink size={13} aria-hidden /> {t('file.open')}
                    </a>
                  </Button>
                )
              }
            />
          </li>
        )}
        {data && (
          <li>
            <FileRow
              name={data.name}
              size={data.sizeBytes}
              status={t('file.dataKind', { count: data.rowCount, format: data.format })}
              actions={
                <>
                  <Button size="sm" heldReason={held ? said(held) : null} onClick={() => actions?.onDownload?.(record, data)}>
                    <Download size={13} aria-hidden /> {t('file.download')}
                  </Button>
                  {!held && (
                    <Button asChild size="sm" variant="quiet">
                      <a href={fileHref(prefix, record.id, 'data')} target="_blank" rel="noopener noreferrer" aria-label={t('file.window', { name: data.name })}>
                        <ExternalLink size={13} aria-hidden />
                      </a>
                    </Button>
                  )}
                </>
              }
            />
          </li>
        )}
      </ul>
      <p className="fw-pp-hint">{t('file.recorded')}</p>
      <div className="fw-pp-row">
        <Button size="sm" variant="primary" heldReason={send ? said(send) : null} onClick={() => actions?.onOpenSend?.(record)}>
          {t('send.send')}
        </Button>
        {withRecordLink && (
          <Button asChild size="sm" variant="quiet">
            <Link href={recordHref(prefix, record.id)}>{t('send.openRecord')}</Link>
          </Button>
        )}
      </div>
      <p className="fw-pp-hint">{t('send.noPage')}</p>
    </div>
  )
}
