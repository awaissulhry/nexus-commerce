'use client'

import { useMemo } from 'react'
import { MoreHorizontal, Undo2 } from 'lucide-react'
import { Card, KeyValue, Menu, SummaryTable } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { CutEntry, CutLog, WorkOrder } from '../../../_shared/api'
import { correctHold, entryPieces, hideBar, quantityText } from '../../../_shared/model'
import type { WorkOrderRecordActions, WorkOrderRecordModel } from '../../record/record-model'
import { NotReleased, PartState } from '../../record/view/WorkOrderRecordView'
import { PrintButton, YieldCard } from '../../daily/view/DailyParts'

/**
 * SCR-071 — Cutting (design wo-cutlog, wo-cutplan; MES-056): cut against plan per cell, each hide's area (cut + waste +
 * returned + left = issued), and the cut log per hide, append-only, newest first. The office corrects an entry with a
 * reason (production.cut.correct): a mirror entry; of a used-up hide only its closing cut, which opens the hide again. A
 * cutter's name only where the site records workers, as plain text in the entry (never a filter, group or total).
 */
export function CuttingTab({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  if (workOrder.status === 'DRAFT') return <NotReleased what={t('cutting.what')} />
  const log = model.cutLog.value
  if (!log) return <PartState label={t('tab.cutting')} problem={model.cutLog.problem} onRetry={() => actions?.onRetryPart?.('cutLog')} />
  return (
    <div className="fw-pr-stack">
      <div className="fw-pr-cards">
        <PlanCard log={log} />
        <HidesCard log={log} />
      </div>
      <CutLogList log={log} model={model} actions={actions} />
      {model.cutOpen && <EntryDetail log={log} entryId={model.cutOpen} model={model} actions={actions} />}
      {/* B-W2a-46 (wo-yield; wo-docs "cutting list (W2a)"). */}
      {model.daily && <YieldCard daily={model.daily} actions={actions?.daily} />}
      {model.daily && (
        <div className="fw-pr-actions">
          <PrintButton what="cutting" actions={actions?.daily} />
        </div>
      )}
    </div>
  )
}

function PlanCard({ log }: { log: CutLog }) {
  const t = useT('production')
  return (
    <Card padded className="fw-pr-card">
      <h2 className="fw-pr-h2">{t('cutting.plan')}</h2>
      <SummaryTable
        label={t('cutting.plan')}
        stackOnPhone
        columns={[t('cutting.col.cell'), t('cutting.col.quantity'), t('cutting.col.cut'), t('cutting.col.toCut'), t('cutting.col.parts')]}
        align={[undefined, 'right', 'right', 'right', 'left']}
        widths={['16%', '12%', '12%', '24%', undefined]}
        rows={log.cells.map((cell) => ({
          id: cell.id,
          cells: [
            `${cell.colourwayCode} ${cell.size}`,
            String(cell.quantity),
            cell.cut === null ? '—' : String(cell.cut),
            cell.toCut === null ? '—' : cell.toCut === 0 ? <Tag key="r" tone="success">{t('cutting.readyToBundle')}</Tag> : String(cell.toCut),
            cell.parts.length ? cell.parts.map((part) => t('cutting.partPieces', { part: part.part, pieces: part.pieces })).join(' · ') : '—',
          ],
        }))}
      />
      <p className="fw-pr-hint">{t('cutting.planHint')}</p>
    </Card>
  )
}

function HidesCard({ log }: { log: CutLog }) {
  const t = useT('production')
  const locale = useLocale()
  const q = (value: string) => quantityText(value, locale)
  return (
    <Card padded className="fw-pr-card">
      <h2 className="fw-pr-h2">{t('cutting.hides')}</h2>
      {log.hides.length === 0 ? (
        <p className="fw-pr-hint">{t('cutting.noHides')}</p>
      ) : (
        <div className="fw-pr-hides">
          {log.hides.map((hide) => {
            const bar = hideBar(hide)
            return (
              <div key={hide.hideId} className="fw-pr-hide">
                <div className="fw-pr-card-head">
                  <span className="fw-pr-code">{hide.code}</span>
                  <Tag tone={hide.state === 'CONSUMED' ? 'neutral' : hide.state === 'REMNANT' ? 'info' : 'warning'}>{t(`hideState.${hide.state}`)}</Tag>
                </div>
                <span className="fw-pr-hint">{t('cutting.hideOf', { lot: hide.lotCode, issued: q(hide.issued) })}</span>
                <div className="fw-pr-bar" role="img" aria-label={bar.parts.map((part) => `${t(`cutting.area.${part.part}`)} ${q(part.value)}`).join(', ')}>
                  {bar.parts
                    .filter((part) => part.percent > 0)
                    .map((part) => (
                      <span key={part.part} className={`is-${part.part}`} style={{ width: `${part.percent}%` }} />
                    ))}
                </div>
                <ul className="fw-pr-legend">
                  {bar.parts.map((part) => (
                    <li key={part.part}>
                      <span className={`fw-pr-swatch is-${part.part}`} aria-hidden />
                      {t(`cutting.area.${part.part}`)} {q(part.value)}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

const entryState = (entry: CutEntry): 'reversal' | 'reversed' | 'closing' | 'live' => (entry.reversalOfId ? 'reversal' : !entry.live || entry.reversedById ? 'reversed' : entry.closing ? 'closing' : 'live')
const STATE_TONE = { reversal: 'neutral', reversed: 'warning', closing: 'info', live: 'success' } as const

function CutLogList({ log, model, actions }: { log: CutLog; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  const columns = useMemo<ColDef<CutEntry>[]>(() => {
    const WhenCell = ({ data }: ICellRendererParams<CutEntry>) =>
      data ? (
        <span className="fw-pr-cell">
          <span>{formatDateTime(data.serverTime, { locale })}</span>
          <span className="fw-pr-cell-sub">{data.station ? data.station.code : t('cutting.office')}</span>
        </span>
      ) : null
    const HideCell = ({ data }: ICellRendererParams<CutEntry>) =>
      data ? (
        <span className="fw-pr-cell">
          <span className="fw-pr-code">{data.hideCode}</span>
          <span className="fw-pr-cell-sub">{t('cutting.lot', { lot: data.lotCode })}</span>
        </span>
      ) : null
    const StateCell = ({ data }: ICellRendererParams<CutEntry>) => {
      if (!data) return null
      const state = entryState(data)
      return <Pill tone={STATE_TONE[state]}>{t(`cutting.state.${state}`)}</Pill>
    }
    const MoreCell = ({ data }: ICellRendererParams<CutEntry>) => {
      if (!data) return null
      const hold = correctHold(data, log, model.can)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('cutting.rowMenu', { hide: data.hideCode }) }}
          items={[
            { id: 'open', label: t('cutting.details'), onSelect: () => actions?.onOpenCut?.(data.id) },
            ...(hold === 'reversal' || hold === 'reversed'
              ? []
              : [{ id: 'correct', label: t('cutting.correct'), disabled: !!hold, description: hold ? t(`cutting.hold.${hold}`) : undefined, onSelect: () => actions?.onDialog?.({ kind: 'correct', entryId: data.id }) }]),
          ]}
        />
      )
    }
    return [
      { colId: 'when', headerName: t('cutting.col.when'), field: 'serverTime', minWidth: 160, flex: 1.1, cellRenderer: WhenCell },
      { colId: 'hide', headerName: t('cutting.col.hide'), field: 'hideCode', minWidth: 160, flex: 1.1, cellRenderer: HideCell },
      { colId: 'cells', headerName: t('cutting.col.cells'), minWidth: 120, flex: 1, valueGetter: (params) => (params.data ? [...new Set(params.data.cells.map((cell) => `${cell.colourwayCode} ${cell.size}`))].join(', ') : '') },
      { colId: 'pieces', headerName: t('cutting.col.pieces'), minWidth: 90, flex: 0.6, type: 'rightAligned', valueGetter: (params) => (params.data ? params.data.pieces.reduce((sum, piece) => sum + piece.pieces, 0) : 0) },
      { colId: 'area', headerName: t('cutting.col.area'), field: 'baseAreaUsed', minWidth: 100, flex: 0.7, type: 'rightAligned', valueFormatter: (params) => (params.data ? quantityText(params.data.baseAreaUsed, locale) : '') },
      { colId: 'remnant', headerName: t('cutting.col.remnant'), field: 'baseRemnantArea', minWidth: 100, flex: 0.7, type: 'rightAligned', valueFormatter: (params) => (params.data ? quantityText(params.data.baseRemnantArea, locale) : '') },
      { colId: 'by', headerName: t('cutting.col.by'), minWidth: 120, flex: 0.9, valueGetter: (params) => params.data?.worker?.name ?? '—' },
      { colId: 'state', headerName: t('cutting.col.state'), minWidth: 120, flex: 0.8, cellRenderer: StateCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, log, model.can, actions])

  return (
    <div className="fw-pr-stack">
      <h2 className="fw-pr-h2">{t('cutting.log')}</h2>
      <ListFrame<CutEntry>
        label={t('cutting.log')}
        rows={log.entries}
        rowId={(row) => row.id}
        columns={columns}
        count={t('cutting.count', { count: log.entries.length })}
        onOpen={(row) => actions?.onOpenCut?.(row.id)}
        state={log.entries.length === 0 ? <p className="fw-pr-hint">{t('cutting.empty')}</p> : undefined}
      />
      <p className="fw-pr-hint">{t('cutting.logHint')}</p>
    </div>
  )
}

function EntryDetail({ log, entryId, model, actions }: { log: CutLog; entryId: string; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  const entry = log.entries.find((row) => row.id === entryId)
  if (!entry) return null
  const hold = correctHold(entry, log, model.can)
  const reversed = entry.reversedById ? log.entries.find((row) => row.id === entry.reversedById) : null
  return (
    <Modal
      open
      onClose={() => actions?.onOpenCut?.(null)}
      title={t('cutting.entryTitle', { hide: entry.hideCode })}
      subtitle={formatDateTime(entry.serverTime, { locale })}
      size="md"
      footer={
        <>
          <span className="grow" />
          {hold !== 'reversal' && hold !== 'reversed' && (
            <Button size="sm" variant="danger-outline" heldReason={hold ? t(`cutting.hold.${hold}`) : null} onClick={() => actions?.onDialog?.({ kind: 'correct', entryId: entry.id })}>
              <Undo2 size={13} aria-hidden /> {t('cutting.correct')}
            </Button>
          )}
          <Button size="sm" onClick={() => actions?.onOpenCut?.(null)}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="fw-pr-dialog">
        <KeyValue
          columns={2}
          items={[
            { label: t('cutting.col.hide'), value: entry.hideCode, hint: t('cutting.lot', { lot: entry.lotCode }) },
            { label: t('cutting.col.state'), value: t(`cutting.state.${entryState(entry)}`), hint: entry.closing ? t('cutting.closingHint') : reversed ? t('cutting.reversedAt', { when: formatDateTime(reversed.serverTime, { locale }) }) : undefined },
            { label: t('cutting.col.area'), value: quantityText(entry.baseAreaUsed, locale), hint: entry.pattern ? t('cutting.pattern', { area: quantityText(entry.pattern, locale) }) : undefined },
            { label: t('cutting.col.remnant'), value: quantityText(entry.baseRemnantArea, locale) },
            { label: t('cutting.station'), value: entry.station ? `${entry.station.code} · ${entry.station.name}` : t('cutting.office') },
            { label: t('cutting.col.by'), value: entry.worker?.name ?? t('cutting.noWorker') },
          ]}
        />
        {entry.pieces.length > 0 && (
          <SummaryTable
            label={t('cutting.col.pieces')}
            columns={[t('cutting.col.cell'), t('cutting.col.parts')]}
            rows={entryPieces(entry).map((group) => ({ id: group.cell, cells: [group.cell, group.parts.map((part) => t('cutting.partPieces', { part: part.part, pieces: part.pieces })).join(' · ')] }))}
          />
        )}
        {entry.reversalOfId ? (
          <p className="fw-pr-hint">{t('cutting.correctionOf', { when: formatDateTime(log.entries.find((row) => row.id === entry.reversalOfId)?.serverTime ?? entry.serverTime, { locale }) })}</p>
        ) : (
          entry.note && <p className="fw-pr-hint">{entry.note}</p>
        )}
      </div>
    </Modal>
  )
}
