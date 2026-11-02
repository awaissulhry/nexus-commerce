'use client'

import { createContext, useContext, useMemo, useState } from 'react'
import Link from 'next/link'
import { Send } from 'lucide-react'
import { DetailPopover, EmptyState, KeyValue, Sparkline } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { OperationRow } from '../api'
import { differenceText, type EfficiencyCan, operationHeld, operationHref, operationLabel, sparkValues, standardText, stateKey, stateTone, styleLabel } from '../model'
import type { EfficiencyActions, EfficiencyModel, OperationPop } from './EfficiencyView'
import { SectionFailed } from './FiguresPanels'

type Props = { model: EfficiencyModel; actions?: EfficiencyActions | undefined; days: readonly string[]; onHelp: () => void }

/** What a cell needs while it is open: the grid draws its cells once, so they read this, not the columns. */
interface PopState {
  openId: string | null
  pop: OperationPop | null
  can: EfficiencyCan
  sending: boolean
  prefix: string
  onOpen: (row: OperationRow | null) => void
  onSend: (row: OperationRow) => void
}
const PopContext = createContext<PopState | null>(null)

/** The operation's pop-over: its days and where it stands; no minutes per bundle, a bundle is usually one person's work. */
function PopBody({ row, close }: { row: OperationRow; close: () => void }) {
  const t = useT('people-efficiency')
  const locale = useLocale()
  const state = useContext(PopContext)!
  const detail = state.pop?.id === row.routingOperationId ? state.pop.detail : null
  const heldSend = !state.can.review ? t('held.noReview') : row.tooFew ? t('refused.TOO_FEW_PEOPLE') : state.sending ? t('held.busy') : null
  return (
    <div className="fw-ef-pop">
      <h3 className="fw-ef-h3">{operationLabel(row)}</h3>
      <p className="fw-pp-hint">{styleLabel(row)}</p>
      {!detail || detail.status === 'loading' || detail.status === 'idle' ? (
        <p className="fw-pp-hint" role="status">
          <Spinner size={12} /> {t('common.loading')}
        </p>
      ) : detail.status === 'error' ? (
        <SectionFailed title={t('operations.popFailed')} problem={detail.problem} />
      ) : (
        <KeyValue
          dense
          labelCase="sentence"
          columns={2}
          items={[
            { label: t('operations.smv'), value: standardText(detail.value.standardMinutes, locale) },
            { label: t('operations.actual'), value: detail.value.tooFew ? '—' : standardText(detail.value.figures.actualMinutes, locale) },
            { label: t('operations.difference'), value: detail.value.tooFew ? '—' : differenceText(detail.value.figures.differencePercent, locale) },
            { label: t('operations.bundles'), value: detail.value.tooFew || detail.value.figures.bundles === null ? '—' : String(detail.value.figures.bundles) },
            { label: t('operations.days'), value: String(detail.value.days.filter((day) => !day.tooFew).length), hint: detail.value.days.some((day) => day.tooFew) ? t('operations.daysHidden', { count: detail.value.days.filter((day) => day.tooFew).length }) : undefined },
            { label: t('operations.lastDecision'), value: detail.value.review.lastDecision ? t(`decision.${detail.value.review.lastDecision.decision}`) : t('operations.noDecision') },
          ]}
        />
      )}
      <span className="fw-pp-row">
        <Button
          size="sm"
          heldReason={heldSend}
          onClick={() => {
            close()
            state.onSend(row)
          }}
        >
          <Send size={13} aria-hidden /> {t('operations.send')}
        </Button>
        {state.can.operations && (
          <Button size="sm" variant="quiet" asChild>
            <Link href={operationHref(state.prefix, row.operation.id)} target="_blank" rel="noopener noreferrer">
              {t('operations.inProducts')}
            </Link>
          </Button>
        )}
      </span>
    </div>
  )
}

/** The operation's cell: Enter or a click opens the pop-over, ⌘-click opens it in Products in a new tab. */
function OperationCell({ row }: { row: OperationRow }) {
  const t = useT('people-efficiency')
  const state = useContext(PopContext)!
  return (
    <span
      className="fw-ef-cell"
      onClickCapture={(event) => {
        if (!(event.metaKey || event.ctrlKey) || !state.can.operations) return
        event.preventDefault()
        event.stopPropagation()
        window.open(operationHref(state.prefix, row.operation.id), '_blank', 'noopener')
      }}
    >
      <DetailPopover
        trigger={<span className="fw-ef-link">{operationLabel(row)}</span>}
        triggerLabel={t('operations.openPop', { operation: operationLabel(row) })}
        label={operationLabel(row)}
        hoverDelay={0}
        open={state.openId === row.routingOperationId}
        onOpenChange={(next) => state.onOpen(next ? row : null)}
      >
        {({ close }) => <PopBody row={row} close={() => close({ returnFocus: true })} />}
      </DetailPopover>
    </span>
  )
}

/**
 * Planned against actual by operation (design sec:operations; MES-250): Style · operation · SMV · actual average · bundles
 * counted · difference · a sparkline of the days · state. Enter opens the operation's pop-over, ⌘-click opens it in Products,
 * "Send to standard review" one by one or for the rows chosen. A row with too few people shows "—" and cannot be chosen; a
 * day with too few people is a break in the sparkline, never a zero. Nothing sorts: one operation is often one person.
 */
export function OperationsPanel({ model, actions, days, onHelp }: Props) {
  const t = useT('people-efficiency')
  const locale = useLocale()
  const read = model.operations
  const value = read.status === 'ready' ? read.value : null
  const rows = value ? value.operations : read.status === 'error' ? [] : null
  const [selected, setSelected] = useState<string[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const picked = (rows ?? []).filter((row) => selected.includes(row.routingOperationId))

  const columns = useMemo<ColDef<OperationRow>[]>(
    () => [
      { colId: 'style', headerName: t('operations.style'), sortable: false, minWidth: 180, flex: 1.5, valueGetter: (params) => (params.data ? styleLabel(params.data) : '') },
      {
        colId: 'operation',
        headerName: t('operations.operation'),
        sortable: false,
        minWidth: 200,
        flex: 1.7,
        valueGetter: (params) => (params.data ? operationLabel(params.data) : ''),
        cellRenderer: (params: ICellRendererParams<OperationRow>) => (params.data ? <OperationCell row={params.data} /> : null),
      },
      { colId: 'smv', headerName: t('operations.smv'), sortable: false, minWidth: 90, flex: 0.7, type: 'rightAligned', valueGetter: (params) => (params.data ? standardText(params.data.standardMinutes, locale) : '') },
      { colId: 'actual', headerName: t('operations.actual'), sortable: false, minWidth: 96, flex: 0.7, type: 'rightAligned', valueGetter: (params) => (params.data ? (params.data.tooFew ? '—' : standardText(params.data.figures.actualMinutes, locale)) : '') },
      { colId: 'bundles', headerName: t('operations.bundles'), sortable: false, minWidth: 96, flex: 0.7, type: 'rightAligned', valueGetter: (params) => (params.data ? (params.data.tooFew ? '—' : String(params.data.figures.bundles ?? '—')) : '') },
      { colId: 'difference', headerName: t('operations.difference'), sortable: false, minWidth: 96, flex: 0.7, type: 'rightAligned', valueGetter: (params) => (params.data ? (params.data.tooFew ? '—' : differenceText(params.data.figures.differencePercent, locale)) : '') },
      {
        colId: 'trend',
        headerName: t('operations.trend'),
        sortable: false,
        minWidth: 110,
        flex: 0.7,
        valueGetter: () => '',
        cellRenderer: (params: ICellRendererParams<OperationRow>) =>
          params.data ? <Sparkline values={sparkValues(params.data.series)} shape="line" label={t('operations.spark', { operation: operationLabel(params.data) })} emptyLabel={t('operations.sparkEmpty')} format={(n) => differenceText(String(n), locale)} /> : null,
      },
      {
        colId: 'state',
        headerName: t('operations.state'),
        sortable: false,
        minWidth: 150,
        flex: 1,
        valueGetter: (params) => (params.data ? t(stateKey(params.data.figures, params.data.tooFew)) : ''),
        cellRenderer: (params: ICellRendererParams<OperationRow>) => (params.data ? <Pill tone={stateTone(params.data.figures, params.data.tooFew)}>{t(stateKey(params.data.figures, params.data.tooFew))}</Pill> : null),
      },
    ],
    [t, locale],
  )

  const held = !model.can.review ? t('held.noReview') : model.sending ? t('held.busy') : null
  const popState: PopState = {
    openId,
    pop: model.pop,
    can: model.can,
    sending: model.sending,
    prefix: model.prefix,
    onOpen: (row) => {
      setOpenId(row?.routingOperationId ?? null)
      actions?.onPop?.(row)
    },
    onSend: (row) => void actions?.onSend?.([row]),
  }

  return (
    <PopContext.Provider value={popState}>
      <div id="fw-ef-operations" className="fw-pp-stack tight">
        <ListFrame<OperationRow>
          label={t('operations.tableLabel')}
          title={t('section.operations')}
          rows={rows}
          rowId={(row) => row.routingOperationId}
          columns={columns}
          count={rows ? t('operations.count', { count: rows.length }) : t('common.loading')}
          listKey="people.efficiency.operations"
          tools={
            <>
              <b className="fw-ef-list-title">{t('section.operations')}</b>
              <Select size="sm" aria-label={t('operations.dayFilter')} value={model.address.day ?? ''} onChange={(event) => actions?.onAddress?.({ day: event.target.value || null })}>
                <option value="">{t('operations.allDays')}</option>
                {days.map((day) => (
                  <option key={day} value={day}>
                    {formatDate(`${day}T12:00:00Z`, { locale })}
                  </option>
                ))}
              </Select>
            </>
          }
          isRowSelectable={(row) => {
            const why = operationHeld(row)
            return why ? t(why) : null
          }}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <Button
                size="sm"
                aria-label={t('operations.sendCount', { count: picked.length })}
                heldReason={held}
                onClick={() => {
                  void actions?.onSend?.(picked).then((all) => all && setSelected([]))
                }}
              >
                <Send size={13} aria-hidden /> <SelectionLabel>{t('operations.sendCount', { count: picked.length })}</SelectionLabel>
              </Button>
            ),
          }}
          onHelp={onHelp}
          onOpen={(row) => popState.onOpen(row)}
          state={
            read.status === 'error' ? (
              <SectionFailed title={t('operations.failed')} problem={read.problem} onRetry={actions?.onRetry} />
            ) : read.status === 'idle' ? (
              <EmptyState title={t('common.waitsForPrivacy')} />
            ) : rows && rows.length === 0 ? (
              <EmptyState title={t('operations.empty')} />
            ) : null
          }
        />
        {value && (
          <ul className="fw-pp-list">
            {value.hiddenGroups > 0 && <li>{t('operations.hidden', { count: value.hiddenGroups })}</li>}
            {value.traineeBundles > 0 && <li>{t('operations.trainees', { count: value.traineeBundles })}</li>}
            {value.untimedReports > 0 && <li>{t('operations.untimed', { count: value.untimedReports })}</li>}
            <li>{t('operations.rule', { percent: value.rule.tolerancePercent, bundles: value.rule.minBundles })}</li>
          </ul>
        )}
      </div>
    </PopContext.Provider>
  )
}
