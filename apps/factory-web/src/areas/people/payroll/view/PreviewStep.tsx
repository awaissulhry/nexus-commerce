'use client'

import { useMemo } from 'react'
import { Banner, Card, EmptyState, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Tag } from '@nexus/ui/primitives'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { CodeSum, PayrollMonth, PayrollValues } from '../api'
import { changeSides, meaningOf, moneyText, previewColumns, previewRows, quantityText, valueText, type PreviewColumn, type PreviewRow } from '../model'
import type { PayrollActions, PayrollModel, WizardModel } from '../view-model'
import { dayWords, SectionLoading, usePayrollWords, useSaid } from './parts'
import { ChangeValue } from '../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

/**
 * 4 · Preview (design sec:step-preview; MES-267): the numbers that will be sent. By employee code, never a name; amounts only with
 * the pay grain; opened by the person, recorded, and held in the page's memory alone (no saved view, no export of this list).
 * A correction shows each changed cell as from → to and can filter to the changed rows. Totals per company under the rows.
 */
export function PreviewStep({ model, wizard, month, actions }: { model: PayrollModel; wizard: WizardModel; month: PayrollMonth; actions?: PayrollActions | undefined }) {
  const t = usePayrollWords()
  const said = useSaid()
  const { preview } = wizard
  return (
    <Card padded className="fw-pay-card">
      <div className="fw-pay-section-head">
        <h3 className="fw-pp-h3">{t('step.preview.title')}</h3>
        <span className="fw-pp-hint">{t('preview.people', { count: month.people })}</span>
      </div>
      <p className="fw-pp-hint">{t('step.preview.lead')}</p>
      {!model.can.records || !month.actions.preview.allowed ? (
        <Banner tone="info" title={t('preview.noRight.title')}>
          {t(model.can.records ? 'held.noReach' : 'held.noRecords')}
        </Banner>
      ) : preview.status === 'idle' ? (
        <div className="fw-pay-open">
          <Button size="sm" variant="primary" onClick={() => actions?.onReadPreview?.()}>
            {t('preview.open')}
          </Button>
          <span className="fw-pp-hint">{t('preview.recorded')}</span>
        </div>
      ) : preview.status === 'reading' ? (
        <SectionLoading words={t('step.reading', { step: t('step.preview.title') })} rows={6} />
      ) : preview.status === 'error' || !preview.value ? (
        <EmptyState title={t('step.failed', { step: t('step.preview.title') })} description={said(preview.problem)} action={<Button size="sm" onClick={() => actions?.onReadPreview?.()}>{t('common.retry')}</Button>} />
      ) : (
        <Numbers values={preview.value} onlyChanged={wizard.onlyChanged} {...(actions?.onOnlyChanged ? { onOnlyChanged: actions.onOnlyChanged } : {})} />
      )}
    </Card>
  )
}

/** The numbers of one month per employee code, from → to where a correction changes them, and the totals: also a past file's. */
export function Numbers({ values, onlyChanged, onOnlyChanged }: { values: PayrollValues; onlyChanged: boolean; onOnlyChanged?: (only: boolean) => void }) {
  const t = usePayrollWords()
  const locale = useLocale()
  const rows = useMemo(() => previewRows(values, onlyChanged), [values, onlyChanged])
  const codes = useMemo(() => previewColumns(values, locale), [values, locale])

  const columns = useMemo<ColDef<PreviewRow>[]>(() => {
    const CodeCell = ({ data }: ICellRendererParams<PreviewRow>) =>
      data ? (
        <span className="fw-pp-cell">
          {data.employeeCode ? <span className="fw-pp-code">{data.employeeCode}</span> : <Tag tone="danger">{t('preview.noCode')}</Tag>}
          {data.lastDay && <span className="fw-pp-sub">{t('preview.leaver', { day: dayWords(data.lastDay, locale) })}</span>}
        </span>
      ) : null
    const valueCell = (column: PreviewColumn) => {
      const ValueCell = ({ data }: ICellRendererParams<PreviewRow>) => {
        if (!data) return null
        const change = data.changes[column.id]
        if (change) {
          const sides = changeSides(change, locale)
          return <ChangeValue compact hideLabels changes={[{ label: column.meaning, from: sides.from, to: sides.to }]} />
        }
        return <span className="fw-pp-num">{valueText(data.cells[column.id], locale) ?? '—'}</span>
      }
      return ValueCell
    }
    const ChangedCell = ({ data }: ICellRendererParams<PreviewRow>) => (data && data.changed > 0 ? <Tag tone="warning">{t('preview.changedValues', { count: data.changed })}</Tag> : null)
    return [
      { colId: 'employee', headerName: t('col.employeeCode'), minWidth: 130, maxWidth: 170, pinned: 'left', cellRenderer: CodeCell },
      ...codes.map(
        (column): ColDef<PreviewRow> => ({
          colId: column.id,
          headerName: column.meaning,
          headerTooltip: column.code,
          minWidth: 110,
          flex: 1,
          type: 'rightAligned',
          cellRenderer: valueCell(column),
        }),
      ),
      ...(values.changes ? [{ colId: 'changed', headerName: t('col.changedRow'), minWidth: 120, flex: 0.6, cellRenderer: ChangedCell } satisfies ColDef<PreviewRow>] : []),
    ]
  }, [t, locale, codes, values.changes])

  const state = rows.length === 0 ? <EmptyState title={t(onlyChanged ? 'preview.noChanged' : 'preview.nobody')} description={t(onlyChanged ? 'preview.noChangedBody' : 'preview.nobodyBody')} /> : undefined
  return (
    <div className="fw-pp-stack">
      {!values.payShown && <Banner tone="info" title={t('preview.noPay')} />}
      {values.changes && (
        <div className="fw-pp-stack tight">
          <MetricStrip
            metrics={[
              { label: t('preview.changedPeople'), value: String(values.changes.people) },
              { label: t('preview.changedTotal'), value: String(values.changes.values) },
            ]}
          />
          <Checkbox checked={onlyChanged} onChange={(event) => onOnlyChanged?.(event.target.checked)} label={t('preview.onlyChanged')} />
        </div>
      )}
      <ListFrame<PreviewRow>
        label={t('step.preview.title')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('preview.count', { count: rows.length })}
        state={state}
        listKey={null}
        rowKind="two-line"
      />
      <Totals sums={values.sums} payShown={values.payShown} />
    </div>
  )
}

/** Totals per company, per code: the file's sums. */
function Totals({ sums, payShown }: { sums: readonly CodeSum[]; payShown: boolean }) {
  const t = usePayrollWords()
  const locale = useLocale()
  const shown = sums.filter((sum) => payShown || sum.kind !== 'EARNING')
  if (shown.length === 0) return null
  return (
    <div className="fw-pp-stack tight">
      <h4 className="fw-pp-h3">{t('preview.totals')}</h4>
      <SummaryTable
        label={t('preview.totals')}
        stackOnPhone
        columns={[t('col.ourCode'), t('col.meaning'), t('col.providerCode'), t('col.quantity'), ...(payShown ? [t('col.amount')] : []), t('col.people')]}
        align={[undefined, undefined, undefined, 'right', ...(payShown ? (['right'] as const) : []), 'right']}
        rows={shown.map((sum) => ({
          id: `${sum.kind}|${sum.code}`,
          cells: [
            <span key="c" className="fw-pp-code">
              {sum.code}
            </span>,
            meaningOf(sum.kind, sum.code, sum.meaning, locale),
            sum.providerCode ?? '—',
            sum.quantity === null ? '—' : quantityText(sum.quantity, locale),
            ...(payShown ? [typeof sum.amount === 'number' ? moneyText(sum.amount, sum.currency, locale) : '—'] : []),
            String(sum.people),
          ],
        }))}
      />
    </div>
  )
}
