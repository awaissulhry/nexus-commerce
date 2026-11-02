'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { CheckCheck, Search } from 'lucide-react'
import { STANDARD_REVIEW } from '@nexus/factory-domain/people/efficiency/rules'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ReviewEntry } from '../api'
import { decisionHeld, differenceText, leftOutWeight, operationLabel, reviewHeld, standardText, styleLabel } from '../model'
import type { BulkState, EfficiencyActions, EfficiencyModel } from './EfficiencyView'
import { SectionFailed } from './FiguresPanels'

type Props = { model: EfficiencyModel; actions?: EfficiencyActions | undefined; onHelp: () => void }

/**
 * The standard review queue (design sec:review; MES-251): operations off their SMV beyond the tolerance over enough bundles, in
 * both directions (c.c. art. 2101 protects both sides). Operation · SMV → actual · bundles · since; a row opens the
 * DetailModal. What the minimum group size leaves out is said in words and in proportion: with one person per operation it
 * can be most of the queue, and a short queue must never read as "nothing else is off".
 */
export function ReviewPanel({ model, actions, onHelp }: Props) {
  const t = useT('people-efficiency')
  const locale = useLocale()
  const read = model.review
  const value = read.status === 'ready' ? read.value : null
  const rows = value ? value.queue : read.status === 'error' ? [] : null
  const [selected, setSelected] = useState<string[]>([])
  const picked = (rows ?? []).filter((row) => selected.includes(row.routingOperationId))
  const weight = value ? leftOutWeight(value) : 'none'

  const columns = useMemo<ColDef<ReviewEntry>[]>(
    () => [
      { colId: 'operation', headerName: t('operations.operation'), sortable: false, minWidth: 180, flex: 1.5, valueGetter: (params) => (params.data ? operationLabel(params.data) : '') },
      { colId: 'style', headerName: t('operations.style'), sortable: false, minWidth: 180, flex: 1.5, valueGetter: (params) => (params.data ? styleLabel(params.data) : '') },
      {
        colId: 'change',
        headerName: t('review.smvActual'),
        sortable: false,
        minWidth: 160,
        flex: 1,
        valueGetter: (params) => (params.data ? (params.data.tooFew ? `${standardText(params.data.standardMinutes, locale)} → —` : `${standardText(params.data.standardMinutes, locale)} → ${standardText(params.data.figures.actualMinutes, locale)}`) : ''),
      },
      { colId: 'difference', headerName: t('operations.difference'), sortable: false, minWidth: 96, flex: 0.7, type: 'rightAligned', valueGetter: (params) => (params.data ? (params.data.tooFew ? '—' : differenceText(params.data.figures.differencePercent, locale)) : '') },
      { colId: 'bundles', headerName: t('operations.bundles'), sortable: false, minWidth: 96, flex: 0.7, type: 'rightAligned', valueGetter: (params) => (params.data ? (params.data.tooFew ? '—' : String(params.data.figures.bundles ?? '—')) : '') },
      { colId: 'since', headerName: t('review.since'), sortable: false, minWidth: 110, flex: 0.7, valueGetter: (params) => (params.data?.since ? formatDate(`${params.data.since}T12:00:00Z`, { locale }) : '—') },
      {
        colId: 'reason',
        headerName: t('review.why'),
        sortable: false,
        minWidth: 150,
        flex: 1,
        valueGetter: (params) => (params.data ? t(`review.reason.${params.data.reason}`) : ''),
        cellRenderer: (params: ICellRendererParams<ReviewEntry>) => (params.data ? <Pill tone={params.data.reason === 'OFF_STANDARD' ? 'warning' : 'info'}>{t(`review.reason.${params.data.reason}`)}</Pill> : null),
      },
    ],
    [t, locale],
  )

  const held = !model.can.review ? t('held.noReview') : null
  const open = (row: ReviewEntry) => actions?.onAddress?.({ open: row.routingOperationId })

  return (
    <div id="fw-ef-review" className="fw-pp-stack tight">
      {value && weight !== 'none' && (
        <Banner tone={weight === 'most' ? 'warning' : 'info'} title={t('review.leftOut', { count: value.leftOut })}>
          {t(weight === 'most' ? 'review.leftOutMost' : 'review.leftOutSome')} {model.can.settings ? <Link href={`${model.prefix}/people/settings`}>{t('tooFew.settings')}</Link> : null}
        </Banner>
      )}
      <ListFrame<ReviewEntry>
        label={t('review.tableLabel')}
        title={t('section.review')}
        rows={rows}
        rowId={(row) => row.routingOperationId}
        columns={columns}
        count={rows ? t('review.count', { count: rows.length }) : t('common.loading')}
        tools={<b className="fw-ef-list-title">{t('section.review')}</b>}
        listKey="people.efficiency.review"
        isRowSelectable={(row) => {
          const why = reviewHeld(row)
          return why ? t(why) : null
        }}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" aria-label={t('bulk.keep', { count: picked.length })} heldReason={held} onClick={() => actions?.onBulk?.('KEEP', picked)}>
                <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.keep', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('bulk.investigate', { count: picked.length })} heldReason={held} onClick={() => actions?.onBulk?.('INVESTIGATE', picked)}>
                <Search size={13} aria-hidden /> <SelectionLabel>{t('bulk.investigate', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        onHelp={onHelp}
        onOpen={open}
        state={
          read.status === 'error' ? (
            <SectionFailed title={t('review.failed')} problem={read.problem} onRetry={actions?.onRetryReview} />
          ) : read.status === 'idle' ? (
            <EmptyState title={t('common.waitsForPrivacy')} />
          ) : rows && rows.length === 0 ? (
            <EmptyState title={weight === 'none' ? t('review.empty') : t('review.emptyLeftOut')} />
          ) : null
        }
      />
      {value && <p className="fw-pp-hint">{t('review.rule', { percent: value.rule.tolerancePercent, bundles: value.rule.minBundles, days: STANDARD_REVIEW.windowDays })}</p>}
    </div>
  )
}

/** Keep N / Investigate N: one reason, one command per operation; refusals are listed by operation afterwards. */
export function BulkDecisionDialog({ bulk, actions }: { bulk: BulkState; actions?: EfficiencyActions | undefined }) {
  const t = useT('people-efficiency')
  const held = decisionHeld({ decision: bulk.decision, reason: bulk.reason, proposed: '' }, { review: true }, bulk.busy)
  return (
    <Modal
      open
      onClose={() => actions?.onBulkCancel?.()}
      title={t(bulk.decision === 'KEEP' ? 'bulk.keep' : 'bulk.investigate', { count: bulk.rows.length })}
      size="sm"
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onBulkCancel?.()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onBulkApply?.()}>
            {t(bulk.decision === 'KEEP' ? 'bulk.keep' : 'bulk.investigate', { count: bulk.rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pp-stack tight">
        <ul className="fw-pp-list">
          {bulk.rows.map((row) => (
            <li key={row.routingOperationId}>{`${operationLabel(row)} · ${styleLabel(row)}`}</li>
          ))}
        </ul>
        <Textarea aria-label={t('review.reasonLabel')} placeholder={t('review.reasonLabel')} value={bulk.reason} onChange={(event) => actions?.onBulkReason?.(event.target.value)} />
      </div>
    </Modal>
  )
}
