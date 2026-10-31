'use client'

import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Download, MoreHorizontal, RotateCcw, XCircle } from 'lucide-react'
import { EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, TagGlyph, Toggle } from '@nexus/ui/primitives'
import { DEFECT_CLASSES } from '@nexus/factory-domain/quality/defects/rules'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { Disposition } from '../api'
import { amountText, approvalKeys, markKey, stockActionKeys, type DispositionField, type Mark } from '../model'
import { SaveMark } from './parts'

export interface DispositionsTableActions {
  onCell?: (row: Disposition, field: DispositionField, value: unknown) => void
  onSelect?: (ids: readonly string[]) => void
  onBulkActive?: (active: boolean) => void
  onExport?: (ids: readonly string[]) => void
  onShowUpdates?: () => void
  onKeys?: () => void
  onStandard?: () => void
  onNew?: () => void
  onRetry?: () => void
}

const cellKeys = (onEnter?: () => void) => (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key === 'Enter' && onEnter) {
    if (event.type === 'keydown') onEnter()
    return true
  }
  return event.key.length === 1 && event.key !== ' '
}

/** The value rule's field: typed in the company's currency, saved on Enter or when the field is left. */
function AmountField({ row, locale, label, onSave }: { row: Disposition; locale: string; label: string; onSave: (text: string) => void }) {
  const [text, setText] = useState(amountText(row.approvalAmount, locale))
  const shown = amountText(row.approvalAmount, locale)
  return (
    <Input
      size="sm"
      inputMode="decimal"
      className="fw-df-amount"
      aria-label={label}
      value={text}
      onFocus={() => setText(shown)}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') onSave(text)
        if (event.key === 'Escape') setText(shown)
      }}
      onBlur={() => text !== shown && onSave(text)}
    />
  )
}

/**
 * The disposition codes (design df-dispositions; QHS-005) in the ONE list frame: code, words (autosaved per cell), the
 * outcome, what a decision with it does to the stock and what it opens — in our words, the API's sentence as data under
 * them —, re-inspection, the approval rule (a class, and a value in the cost grain only for whoever has it), how often it is
 * used, active. The code, outcome, move and follow-up never change: a new code replaces one. Fetches nothing.
 */
export function DispositionsTable({
  rows,
  read,
  canManage,
  seesCost,
  marks,
  selected,
  updates,
  standardMissing,
  busy,
  actions,
}: {
  rows: readonly Disposition[]
  read: { loaded: boolean; problem: string | null }
  canManage: boolean
  seesCost: boolean
  marks: Readonly<Record<string, Mark>>
  selected: readonly string[]
  updates: number
  standardMissing: number
  busy: boolean
  actions?: DispositionsTableActions
}) {
  const t = useT('defects')
  const locale = useLocale()
  const latest = useRef({ actions, marks })
  latest.current = { actions, marks }
  const marksKey = JSON.stringify(marks)

  const columns = useMemo<ColDef<Disposition>[]>(() => {
    const can = canManage
    const mark = (id: string, field: string) => latest.current.marks[markKey(id, field)]
    const CodeCell = ({ data }: ICellRendererParams<Disposition>) =>
      data ? (
        <span className="fw-df-code">
          <TagGlyph icon={data.icon} color={data.colour} size={16} />
          <span className="fw-df-cell">
            <span className="fw-df-name is-static">{data.code}</span>
            <span className="fw-df-sub">{t('disp.fixed')}</span>
          </span>
        </span>
      ) : null
    const WordsCell = (field: 'labelIt' | 'labelEn') =>
      function Words({ data }: ICellRendererParams<Disposition>) {
        if (!data) return null
        return (
          <span className="fw-df-cell-row">
            <span className="fw-df-words">{data[field]}</span>
            <SaveMark mark={mark(data.id, field)} />
          </span>
        )
      }
    const OutcomeCell = ({ data }: ICellRendererParams<Disposition>) => (data ? <Pill tone={data.outcome === 'SCRAP' ? 'danger' : data.outcome === 'USE_AS_IS' ? 'success' : 'neutral'}>{t(`outcome.${data.outcome}`)}</Pill> : null)
    const ActionCell = ({ data }: ICellRendererParams<Disposition>) =>
      data ? (
        <span className="fw-df-cell">
          <span>{stockActionKeys(data).map((line) => t(line.key)).join(' · ')}</span>
          <span className="fw-df-sub fw-df-data" lang="en">
            {data.stockAction}
          </span>
        </span>
      ) : null
    const ReinspectCell = ({ data }: ICellRendererParams<Disposition>) => {
      if (!data) return null
      const held = data.outcome === 'USE_AS_IS' ? t('disp.reinspectHeld') : null
      return (
        <span className="fw-df-cell-row">
          {can && !held ? (
            <Toggle size="xs" checked={data.reinspection} aria-label={t('disp.reinspectOf', { code: data.code })} onChange={(next) => latest.current.actions?.onCell?.(data, 'reinspection', next)} />
          ) : null}
          <span className={data.reinspection ? undefined : 'fw-df-sub'} title={held ?? undefined}>
            {t(data.reinspection ? 'reinspection.on' : 'reinspection.off')}
          </span>
          <SaveMark mark={mark(data.id, 'reinspection')} />
        </span>
      )
    }
    const ApprovalCell = ({ data }: ICellRendererParams<Disposition>) => {
      if (!data) return null
      const amountShown = data.approvalAmount !== undefined && seesCost
      return (
        <span className="fw-df-cell">
          {can ? (
            <span className="fw-df-cell-row">
              <Select
                size="sm"
                aria-label={t('disp.approvalSeverityOf', { code: data.code })}
                value={data.approvalSeverity ?? ''}
                onChange={(event) => latest.current.actions?.onCell?.(data, 'approvalSeverity', event.target.value || null)}
              >
                <option value="">{t('approval.severity.none')}</option>
                {DEFECT_CLASSES.map((entry) => (
                  <option key={entry} value={entry}>
                    {t(`approval.severity.${entry}`)}
                  </option>
                ))}
              </Select>
              <SaveMark mark={mark(data.id, 'approvalSeverity')} />
            </span>
          ) : (
            <span>{approvalKeys(data).map((line) => t(line.key, line.params)).join(' · ')}</span>
          )}
          {amountShown ? (
            can ? (
              <span className="fw-df-cell-row">
                <span className="fw-df-sub">{t('disp.amountFrom')}</span>
                <AmountField row={data} locale={locale} label={t('disp.amountOf', { code: data.code })} onSave={(text) => latest.current.actions?.onCell?.(data, 'approvalAmount', text)} />
                <SaveMark mark={mark(data.id, 'approvalAmount')} />
              </span>
            ) : data.approvalAmount !== null ? (
              <span className="fw-df-sub">{t('disp.amountIs', { amount: amountText(data.approvalAmount, locale) })}</span>
            ) : null
          ) : (
            <span className="fw-df-sub">{t('disp.amountHidden')}</span>
          )}
        </span>
      )
    }
    const UsedCell = ({ data }: ICellRendererParams<Disposition>) =>
      data ? <span className={data.usedCount === 0 ? 'fw-df-sub' : undefined}>{data.usedCount === 0 ? t('used.none') : t('used.decisions', { count: data.usedCount })}</span> : null
    const ActiveCell = ({ data }: ICellRendererParams<Disposition>) =>
      data ? (
        <span className="fw-df-cell-row">
          {can && <Toggle size="xs" checked={data.active} aria-label={t(data.active ? 'status.deactivateOf' : 'status.activateOf', { code: data.code })} onChange={(next) => latest.current.actions?.onCell?.(data, 'active', next)} />}
          {data.active ? <span>{t('status.active')}</span> : <Pill tone="neutral">{t('status.inactive')}</Pill>}
          <SaveMark mark={mark(data.id, 'active')} />
        </span>
      ) : null
    const ActionsCell = ({ data }: ICellRendererParams<Disposition>) => {
      if (!data) return null
      const items: MenuItemDef[] = [
        { id: 'active', label: t(data.active ? 'row.deactivate' : 'row.activate'), disabled: !can, description: can ? undefined : t('held.noManage'), onSelect: () => latest.current.actions?.onCell?.(data, 'active', !data.active) },
        { id: 'sep', separator: true },
        { id: 'copy', label: t('row.copyCode'), onSelect: () => void navigator.clipboard?.writeText(data.code) },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { code: data.code }) }} items={items} />
    }
    const editable = (field: 'labelIt' | 'labelEn'): ColDef<Disposition> => ({
      colId: field,
      headerName: t(field === 'labelIt' ? 'col.it' : 'col.en'),
      minWidth: 150,
      flex: 1.2,
      valueGetter: (params) => params.data?.[field] ?? '',
      ...(can ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 80 } } : {}),
      cellRenderer: WordsCell(field),
      suppressKeyboardEvent: cellKeys(),
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.onCell?.(params.data, field, params.newValue)
        return false
      },
    })
    return [
      { colId: 'code', headerName: t('col.code'), minWidth: 190, flex: 1.2, cellRenderer: CodeCell, suppressKeyboardEvent: cellKeys() },
      editable('labelIt'),
      editable('labelEn'),
      { colId: 'outcome', headerName: t('col.outcome'), minWidth: 150, flex: 0.9, cellRenderer: OutcomeCell, suppressKeyboardEvent: cellKeys() },
      { colId: 'stockAction', headerName: t('col.stockAction'), minWidth: 260, flex: 2.2, cellRenderer: ActionCell, suppressKeyboardEvent: cellKeys(), wrapText: true, autoHeight: true },
      {
        colId: 'reinspection',
        headerName: t('col.reinspection'),
        minWidth: 150,
        flex: 0.9,
        cellRenderer: ReinspectCell,
        suppressKeyboardEvent: can
          ? (params: { event: KeyboardEvent; editing: boolean; data?: Disposition }) => cellKeys(() => params.data && params.data.outcome !== 'USE_AS_IS' && latest.current.actions?.onCell?.(params.data, 'reinspection', !params.data.reinspection))(params)
          : cellKeys(),
      },
      { colId: 'approval', headerName: t('col.approval'), minWidth: 230, flex: 1.5, cellRenderer: ApprovalCell, suppressKeyboardEvent: () => true, autoHeight: true },
      { colId: 'used', headerName: t('col.used'), minWidth: 130, flex: 0.8, cellRenderer: UsedCell, suppressKeyboardEvent: cellKeys() },
      {
        colId: 'active',
        headerName: t('col.status'),
        minWidth: 150,
        flex: 0.9,
        cellRenderer: ActiveCell,
        suppressKeyboardEvent: can ? (params: { event: KeyboardEvent; editing: boolean; data?: Disposition }) => cellKeys(() => params.data && latest.current.actions?.onCell?.(params.data, 'active', !params.data.active))(params) : cellKeys(),
      },
      { colId: 'actions', headerName: t('col.actions'), width: 72, minWidth: 72, cellRenderer: ActionsCell, suppressHeaderMenuButton: true, sortable: false },
    ]
  }, [t, locale, canManage, seesCost, marksKey])

  const picked = rows.filter((row) => selected.includes(row.id))
  const held = (active: boolean): string | null =>
    !canManage ? t('held.noManage') : busy ? t('held.busy') : picked.length === 0 ? t('held.pickRows') : !picked.some((row) => row.active !== active) ? t(active ? 'held.allActiveDisp' : 'held.allInactive') : null
  const count = selected.length
  const bulk = (
    <>
      <Button size="sm" heldReason={held(false)} onClick={() => actions?.onBulkActive?.(false)} aria-label={t('bulk.deactivate', { count })}>
        <XCircle size={13} aria-hidden /> <SelectionLabel>{t('bulk.deactivate', { count })}</SelectionLabel>
      </Button>
      <Button size="sm" heldReason={held(true)} onClick={() => actions?.onBulkActive?.(true)} aria-label={t('bulk.activate', { count })}>
        <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('bulk.activate', { count })}</SelectionLabel>
      </Button>
      <Button size="sm" onClick={() => actions?.onExport?.(selected)} aria-label={t('bulk.export', { count })}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count })}</SelectionLabel>
      </Button>
    </>
  )
  const state: ReactNode = read.problem ? (
    <EmptyState
      title={t('disp.failed')}
      description={t(read.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : read.loaded && rows.length === 0 ? (
    <EmptyState
      title={t('disp.empty.title')}
      description={t('disp.empty.body', { count: standardMissing })}
      action={
        <span className="fw-df-actions">
          <Button size="sm" variant="primary" heldReason={canManage ? null : t('held.noManage')} onClick={() => actions?.onStandard?.()}>
            {t('standard.add', { count: standardMissing })}
          </Button>
          <Button size="sm" heldReason={canManage ? null : t('held.noManage')} onClick={() => actions?.onNew?.()}>
            {t('head.addDisposition')}
          </Button>
        </span>
      }
    />
  ) : undefined
  const keys: ListKey[] = [{ keys: ['c'], does: t('keys.addDisposition') }]
  return (
    <ListFrame<Disposition>
      label={t('disp.table')}
      title={t('disp.title')}
      listKey="quality.defects.dispositions"
      rows={read.problem ? [] : read.loaded ? rows : null}
      rowId={(row) => row.id}
      columns={columns}
      count={!read.loaded ? t('library.countReading') : t('disp.count', { count: rows.length })}
      selection={{ selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
      updates={updates > 0 ? { count: updates, onShow: () => actions?.onShowUpdates?.() } : null}
      keys={keys}
      onHelp={() => actions?.onKeys?.()}
      state={state}
    />
  )
}
