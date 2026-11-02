'use client'

import { useMemo, useRef } from 'react'
import { AlertCircle } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { CellSaveMark } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { CODE_LIMITS } from '@nexus/factory-domain/people/payroll/codes'
import { TIME_ZONE } from '../../_shared/model'
import type { CodeRow } from '../api'
import { codeKey, meaningOf } from '../model'
import type { PayrollActions, PayrollModel, WizardModel } from '../view-model'
import { SectionLoading, usePayrollWords, useSaid } from './parts'

/** Printable keys stay the list's keys (j, k, x …): Enter or a click opens the cell. While editing the grid hears everything. */
const typingKeys = (params: { event: KeyboardEvent; editing: boolean }) => !params.editing && !params.event.metaKey && !params.event.ctrlKey && !params.event.altKey && params.event.key.length === 1 && params.event.key !== ' '

/** The provider code's cell editor: the DS sheet's "leaving the cell saves" for one column of a list frame (the frame has no such grid option). */
function ProviderEditor({ value, onValueChange, stopEditing, data }: { value?: string | null; onValueChange: (value: string) => void; stopEditing: () => void; data?: CodeRow }) {
  const t = usePayrollWords()
  return (
    <input
      className="fw-pay-editor"
      autoFocus
      aria-label={t('mapping.editor', { code: data?.ourCode ?? '' })}
      maxLength={CODE_LIMITS.providerCode}
      value={value ?? ''}
      onChange={(event) => onValueChange(event.target.value)}
      onFocus={(event) => event.target.select()}
      onBlur={() => stopEditing()}
    />
  )
}

/**
 * 3 · Code mapping (design sec:step-mapping; MES-271): our hour types, absence codes and earning types → the provider's codes, per
 * company, unmapped rows first as the API sorts them. A code is edited in its cell and saves itself on leaving the cell, with the
 * version read; its mark says saving, saved or why not. Leaving a cell empty clears the code. Rows never move while editing.
 */
export function MappingStep({ model, wizard, actions }: { model: PayrollModel; wizard: WizardModel; actions?: PayrollActions | undefined }) {
  const t = usePayrollWords()
  const said = useSaid()
  const locale = useLocale()
  const place = useMemo(() => ({ locale, timeZone: TIME_ZONE }), [locale])
  const codes = wizard.codes
  const rows = codes.status === 'ready' ? codes.value.rows : null
  const latest = useRef({ actions, marks: wizard.marks })
  latest.current = { actions, marks: wizard.marks }
  const marksKey = JSON.stringify(wizard.marks)
  const can = model.can.manage

  const columns = useMemo<ColDef<CodeRow>[]>(() => {
    const KindCell = ({ data }: ICellRendererParams<CodeRow>) => (data ? <Tag tone="neutral">{t(`kind.${data.kind}`)}</Tag> : null)
    const OurCell = ({ data }: ICellRendererParams<CodeRow>) => (data ? <span className="fw-pp-code">{data.ourCode}</span> : null)
    const MeaningCell = ({ data }: ICellRendererParams<CodeRow>) =>
      data ? (
        <span className="fw-pp-cell">
          <span className="fw-pp-ellipsis">{meaningOf(data.kind, data.ourCode, data.meaning, locale)}</span>
          {!data.inUse && <span className="fw-pp-sub">{t('mapping.notInUse')}</span>}
        </span>
      ) : null
    const ProviderCell = ({ data }: ICellRendererParams<CodeRow>) => {
      if (!data) return null
      const mark = latest.current.marks[codeKey(data)]
      return (
        <span className="fw-pp-row">
          {data.providerCode ? <span className="fw-pp-code">{data.providerCode}</span> : <Pill tone="warning">{t('mapping.notMapped')}</Pill>}
          {mark?.state === 'saving' && <CellSaveMark state="saving" />}
          {mark?.state === 'saved' && <span className="fw-pp-sub">{t('mapping.saved')}</span>}
          {mark?.state === 'failed' && <AlertCircle size={14} className="fw-pp-danger" role="img" aria-label={said(mark.words)} />}
        </span>
      )
    }
    const ChangedCell = ({ data }: ICellRendererParams<CodeRow>) => <span className="fw-pp-sub">{data?.updatedAt ? formatDateTime(data.updatedAt, place) : t('mapping.never')}</span>
    return [
      { colId: 'kind', headerName: t('col.kind'), minWidth: 120, flex: 0.6, cellRenderer: KindCell },
      { colId: 'our', headerName: t('col.ourCode'), minWidth: 130, flex: 0.7, cellRenderer: OurCell },
      { colId: 'meaning', headerName: t('col.meaning'), minWidth: 220, flex: 1.5, cellRenderer: MeaningCell },
      {
        colId: 'provider',
        headerName: t('col.providerCode'),
        minWidth: 220,
        flex: 1.1,
        valueGetter: (params) => params.data?.providerCode ?? '',
        cellRenderer: ProviderCell,
        ...(can ? { editable: true, singleClickEdit: true, cellEditor: ProviderEditor } : {}),
        suppressKeyboardEvent: typingKeys,
        valueSetter: (params) => {
          if (params.data) latest.current.actions?.onCode?.(params.data, String(params.newValue ?? ''))
          return false
        },
      },
      { colId: 'changed', headerName: t('col.lastChanged'), minWidth: 150, flex: 0.8, cellRenderer: ChangedCell },
    ]
    // The cells read the marks through `latest`; a change of a mark redraws them.
  }, [t, said, locale, place, can, marksKey])

  const state =
    codes.status === 'error' ? <EmptyState title={t('step.failed', { step: t('step.mapping.title') })} description={t(codes.problem)} action={<Button size="sm" onClick={() => actions?.onRetryCodes?.()}>{t('common.retry')}</Button>} /> : rows && rows.length === 0 ? <EmptyState title={t('mapping.empty')} /> : undefined
  const unmapped = codes.status === 'ready' ? codes.value.unmapped : null
  const failedCode = Object.entries(wizard.marks).find(([, mark]) => mark.state === 'failed')
  return (
    <Card padded className="fw-pay-card">
      <div className="fw-pay-section-head">
        <h3 className="fw-pp-h3">{t('step.mapping.title')}</h3>
        {unmapped !== null && <span className="fw-pp-hint">{t('mapping.unmapped', { count: unmapped })}</span>}
      </div>
      <p className="fw-pp-hint">{t('step.mapping.lead')}</p>
      {!model.can.manage && <Banner tone="info" title={t('held.noManage')} />}
      {failedCode && <Banner tone="danger" title={t('mapping.failed', { code: failedCode[0].split('|')[1] ?? '' })}>{said(failedCode[1].words)}</Banner>}
      {codes.status === 'loading' ? (
        <SectionLoading words={t('step.reading', { step: t('step.mapping.title') })} rows={6} />
      ) : (
        <ListFrame<CodeRow>
          label={t('step.mapping.title')}
          rows={state ? [] : rows}
          rowId={codeKey}
          columns={columns}
          count={rows ? t('mapping.count', { count: rows.length }) : '—'}
          state={state}
          listKey={null}
          cards={null}
        />
      )}
    </Card>
  )
}
