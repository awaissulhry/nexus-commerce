'use client'

import Link from 'next/link'
import { Banner, Card, EmptyState, KeyValue, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { CheckList } from '@nexus/ui/patterns/checklist/index'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { TIME_ZONE } from '../../../_shared/model'
import { LiveLine, RecordFrame, type Loaded, type Notice } from '../../../_shared/parts'
import type { ExportFile, ExportLink, ExportRecord } from '../../api'
import { checkState, checkWords, isLatest, monthWords, orderedChecks, payrollHref, recordHref, rowCorrectHeld, type PayrollCan } from '../../model'
import type { ExportDialogActions, ExportDialogs, LiveState, PreviewState } from '../../view-model'
import { ExportModals } from '../../view/dialogs'
import { LayoutTag, NotPayroll, PayrollMessages, PayrollNote, PayrollNotice, SectionLoading, STATUS_TONE, usePayrollWords, useSaid } from '../../view/parts'
import { Numbers } from '../../view/PreviewStep'
import { FileCard } from '../../view/SendStep'

/** SCR-159-record — one past export's view model. */
export interface PastExportModel {
  prefix: string
  can: PayrollCan
  loaded: Loaded<ExportRecord>
  live: LiveState
  asOf: string | null
  /** What the file sent, per employee code: opened on the click, recorded, held here alone. */
  values: PreviewState
  onlyChanged: boolean
  /** The link being withdrawn. */
  withdrawing: string | null
  dialogs: ExportDialogs
  notice: Notice | null
}

export interface PastExportActions extends ExportDialogActions {
  onRetry?: () => void
  onDismissNotice?: () => void
  onReadValues?: () => void
  onOnlyChanged?: (only: boolean) => void
  onDownload?: (record: ExportRecord, file: ExportFile) => void
  onWithdraw?: (link: ExportLink) => void
}

const LINK_TONE: Readonly<Record<ExportLink['state'], 'success' | 'neutral' | 'warning'>> = { LIVE: 'success', REVOKED: 'neutral', USED_UP: 'warning', EXPIRED: 'neutral' }

/**
 * Past export (design tab:past): the band (period, version, state, Send, Make correction), what this page shows, the file with its
 * seal and the two files, its secure links with every download, its checks as they stood, and what changed from the file before.
 * The numbers per employee code stay closed until the person opens them.
 */
export function PastExportView({ model, actions }: { model: PastExportModel; actions?: PastExportActions }) {
  return (
    <PayrollMessages>
      <Past model={model} {...(actions ? { actions } : {})} />
    </PayrollMessages>
  )
}

function Past({ model, actions }: { model: PastExportModel; actions?: PastExportActions }) {
  const t = usePayrollWords()
  const said = useSaid()
  const locale = useLocale()
  const back = payrollHref(model.prefix)
  if (!model.can.view) {
    return (
      <div className="fw-pp fw-pay">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }
  const record = model.loaded.status === 'ready' ? model.loaded.value : null
  const correct = record ? rowCorrectHeld(record, model.can) : null
  return (
    <div className="fw-pay">
    <RecordFrame
      backHref={back}
      backLabel={t('record.back')}
      loaded={model.loaded}
      noun={t('record.noun')}
      title={record ? t('record.title', { month: monthWords(record.month, locale), version: record.revision }) : undefined}
      meta={
        record ? (
          <>
            <Pill tone={STATUS_TONE[record.status]} dot>
              {t(`status.${record.status}`)}
            </Pill>
            {record.number && <Tag tone="neutral">{record.number}</Tag>}
            {record.correctedById && <Tag tone="neutral">{t('list.replaced')}</Tag>}
          </>
        ) : undefined
      }
      status={<LiveLine asOf={model.asOf} live={model.live} />}
      note={<PayrollNote />}
      onRetry={() => actions?.onRetry?.()}
      actions={
        record ? (
          <span className="fw-pp-actions">
            {isLatest(record) && (
              <Button size="sm" heldReason={correct ? said(correct) : null} onClick={() => actions?.onOpenCorrect?.(record)}>
                {t('list.correct')}
              </Button>
            )}
            {record.status === 'DRAFT' && (
              <Button size="sm" variant="danger" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onOpenCancel?.(record)}>
                {t('list.cancel')}
              </Button>
            )}
          </span>
        ) : undefined
      }
    >
      <PayrollNotice notice={model.notice} {...(actions?.onDismissNotice ? { onDismiss: actions.onDismissNotice } : {})} />
      {record && <Body model={model} record={record} {...(actions ? { actions } : {})} />}
      <ExportModals prefix={model.prefix} can={model.can} dialogs={model.dialogs} actions={actions} />
    </RecordFrame>
    </div>
  )
}

function Body({ model, record, actions }: { model: PastExportModel; record: ExportRecord; actions?: PastExportActions }) {
  const t = usePayrollWords()
  const said = useSaid()
  const locale = useLocale()
  const ds = useDsWords()
  const place = { locale, timeZone: TIME_ZONE }
  const checks = orderedChecks(record.checks)
  return (
    <div className="fw-pp-split">
      <div className="fw-pp-stack">
        {record.status === 'CANCELLED' && (
          <Banner tone="info" title={t('record.cancelled')}>
            {record.cancelReason ?? ''}
          </Banner>
        )}
        {record.status === 'DRAFT' && <Banner tone="warning" title={t('record.draft')}>{t('record.draftBody')}</Banner>}
        {record.status === 'EXPORTED' && (
          <Card padded className="fw-pay-card">
            <h3 className="fw-pp-h3">{t('record.file')}</h3>
            <FileCard prefix={model.prefix} can={model.can} record={record} withRecordLink={false} {...(actions ? { actions } : {})} />
          </Card>
        )}
        {record.status === 'EXPORTED' && <Links model={model} record={record} {...(actions ? { actions } : {})} />}
        <Card padded className="fw-pay-card">
          <h3 className="fw-pp-h3">{t('record.values')}</h3>
          {record.changed && (
            <MetricStrip
              metrics={[
                { label: t('preview.changedPeople'), value: String(record.changed.people) },
                { label: t('preview.changedTotal'), value: String(record.changed.values) },
              ]}
            />
          )}
          {!model.can.records ? (
            <p className="fw-pp-hint">{t('held.noRecords')}</p>
          ) : model.values.status === 'idle' ? (
            <div className="fw-pay-open">
              <Button size="sm" onClick={() => actions?.onReadValues?.()}>
                {t('record.open')}
              </Button>
              <span className="fw-pp-hint">{t('preview.recorded')}</span>
            </div>
          ) : model.values.status === 'reading' ? (
            <SectionLoading words={t('record.reading')} rows={4} />
          ) : model.values.status === 'error' || !model.values.value ? (
            <Banner tone="danger" title={said(model.values.problem)} />
          ) : (
            <Numbers values={model.values.value} onlyChanged={model.onlyChanged} {...(actions?.onOnlyChanged ? { onOnlyChanged: actions.onOnlyChanged } : {})} />
          )}
        </Card>
        <Card padded className="fw-pay-card">
          <h3 className="fw-pp-h3">{t('record.checks')}</h3>
          <p className="fw-pp-hint">{t('record.checksLead')}</p>
          <CheckList
            label={t('record.checks')}
            labels={ds.checkList}
            checks={checks.map((check) => {
              const words = checkWords(check, record.month, locale)
              return { id: check.code, state: checkState(check), name: t(words.name), detail: said(words.detail) }
            })}
          />
        </Card>
      </div>
      <Card padded className="fw-pay-card">
        <h3 className="fw-pp-h3">{t('aside.title')}</h3>
        <KeyValue
          dense
          items={[
            { label: t('col.company'), value: `${record.company.code} · ${record.company.legalName}` },
            { label: t('col.period'), value: monthWords(record.month, locale) },
            {
              label: t('col.format'),
              value: (
                <span className="fw-pp-row">
                  {record.layout.name} <LayoutTag layout={record.layout} />
                </span>
              ),
            },
            { label: t('col.version'), value: `v${record.revision}` },
            { label: t('col.made'), value: `${record.madeBy?.name ?? t('list.someone')} · ${formatDateTime(record.exportedAt ?? record.createdAt, place)}` },
            { label: t('record.sentTo'), value: record.sentTo.length > 0 ? record.sentTo.join(', ') : t('list.notSent') },
            { label: t('record.downloaded'), value: record.downloadedAt ? formatDateTime(record.downloadedAt, place) : t('list.notDownloaded') },
            ...(record.correctionOfId ? [{ label: t('record.replaces'), value: <Link className="fw-pp-link" href={recordHref(model.prefix, record.correctionOfId)}>{t('record.previous', { version: record.revision - 1 })}</Link> }] : []),
            ...(record.correctedById ? [{ label: t('record.replacedBy'), value: <Link className="fw-pp-link" href={recordHref(model.prefix, record.correctedById)}>{t('record.next')}</Link> }] : []),
            ...(record.note ? [{ label: t('send.note'), value: record.note }] : []),
          ]}
        />
        <NotPayroll />
      </Card>
    </div>
  )
}

/** The secure links of this file: who, until when, how many downloads, each download with its time. A small table inside a record. */
function Links({ model, record, actions }: { model: PastExportModel; record: ExportRecord; actions?: PastExportActions }) {
  const t = usePayrollWords()
  const locale = useLocale()
  const place = { locale, timeZone: TIME_ZONE }
  return (
    <Card padded className="fw-pay-card">
      <h3 className="fw-pp-h3">{t('record.links')}</h3>
      {record.links.length === 0 ? (
        <p className="fw-pp-hint">{t('record.noLinks')}</p>
      ) : (
        <SummaryTable
          label={t('record.links')}
          density="roomy"
          stackOnPhone
          columns={[t('col.to'), t('col.linkState'), t('col.expires'), t('col.uses'), t('col.downloads'), t('col.more')]}
          rows={record.links.map((link) => ({
            id: link.id,
            cells: [
              link.email ?? '—',
              <Tag key="s" tone={LINK_TONE[link.state]}>
                {t(`link.${link.state}`)}
              </Tag>,
              formatDateTime(link.expiresAt, place),
              t('record.uses', { used: link.uses, max: link.maxUses }),
              link.downloads.length > 0 ? link.downloads.map((entry) => formatDateTime(entry.at, place)).join(', ') : t('list.notDownloaded'),
              link.state === 'LIVE' ? (
                <Button key="w" size="sm" heldReason={!model.can.manage ? t('held.noManage') : model.withdrawing === link.id ? t('held.busy') : null} onClick={() => actions?.onWithdraw?.(link)}>
                  {t('sendDialog.withdraw')}
                </Button>
              ) : (
                '—'
              ),
            ],
          }))}
        />
      )}
    </Card>
  )
}
