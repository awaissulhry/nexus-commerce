'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { MoreHorizontal, Undo2 } from 'lucide-react'
import { Card, KeyValue, Menu, SummaryTable } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { CutEntry, CutLog, WorkOrder } from '../../../_shared/api'
import { correctHold, entryPieces, hideBar, quantityText } from '../../../_shared/model'
import type { WorkOrderRecordActions, WorkOrderRecordModel } from '../../record/record-model'
import { NotReleased, PartState } from '../../record/view/WorkOrderRecordView'
import { FinishedCard, PrintButton, ReserveLeather, YieldCard } from '../../daily/view/DailyParts'
// B-W2b-130: the hide photo in an entry's detail (wo-cutlog "pieces, hide photo W2b").
import { HidePhoto } from './HidePhoto'
// ---- F-PR-06: Cutting and Bundles as ONE tab, the Cut record merged in ----
import { CUTTING_NAMESPACE } from '../../../cutting/model'
import { ORDERS_NAMESPACE } from '../../../cutting/orders/model'
import { BundlesSection } from '../../bundles/view/BundlesSection'
import { cutCellsOf, cutCellsTotal, partPhrases, type CutCellRow } from '../model'
import { CutOrdersCard, LotYieldCard, RecutsCard } from './CutParts'
// ---- end F-PR-06

/**
 * SCR-071 — Cutting & bundles (F-PR-06, 06-tree A.4 Tab 3: Cutting and Bundles are one tab, and the Cut record merged in; design
 * wo-cutlog, wo-cutplan, wo-bundles; MES-056, MES-065): ONE table of what is cut and bundled per size × colour (Planned · Cut ·
 * Bundled · Short, each cell's parts under it with what is short and what waits for a recut) and the recuts with Mark cut; hides
 * or lays — each hide's area (cut + waste + returned + left = issued) with Reserve leather…, the cut log per hide, append-only,
 * newest first (the office corrects an entry with a reason, production.cut.correct: a mirror entry; of a used-up hide only its
 * closing cut, which opens the hide again), and the cut orders this work order is in (its fabric lays); the yield, per hide and
 * per lot and supplier; every bundle and where it waits (Reprint N, Split bundle); finished to stock (its figures: Report
 * finished is the band's). A cutter's name only where the site records workers, as plain text in an entry (never a filter, group
 * or total). B-W2b-130: an entry's detail shows the photo of the hide taken at the table and the thickness measured there.
 */
export function CuttingTab({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  if (workOrder.status === 'DRAFT') return <NotReleased what={t('cutting.what')} />
  const log = model.cutLog.value
  const bundles = model.bundles.value
  if (!log && !bundles) return <PartState label={t('tab.cutting')} problem={model.cutLog.problem ?? model.bundles.problem} onRetry={() => actions?.onRetryPart?.('cutLog')} />
  const cut = model.cut ?? null
  const yieldValue = model.daily?.yield?.value ?? null
  return (
    <WithMessages namespaces={[CUTTING_NAMESPACE, ORDERS_NAMESPACE]}>
      <div className="fw-pr-stack">
        {/* O-WO-cut-cells: ONE table (the cut-vs-plan grid and the bundles' per-cell card were the same figures twice). */}
        <CellsCard rows={cutCellsOf(log, bundles, cut?.recuts?.value ?? [])} />
        {cut && <RecutsCard log={log} cut={cut} actions={actions?.cut} />}
        {/* O-WO-cut-lays: the leather's hides and cut log, the cut orders (fabric lays) this work order is in. */}
        {log ? (
          <>
            <HidesCard log={log} workOrder={workOrder} model={model} actions={actions} />
            <CutLogList log={log} model={model} actions={actions} />
            {model.cutOpen && <EntryDetail log={log} entryId={model.cutOpen} model={model} actions={actions} />}
          </>
        ) : (
          <PartState label={t('cutting.log')} problem={model.cutLog.problem} onRetry={() => actions?.onRetryPart?.('cutLog')} />
        )}
        {cut && <CutOrdersCard prefix={model.prefix} orders={cut.orders} onRetry={() => actions?.cut?.onRetry?.('orders')} />}
        {/* O-WO-cut-yield (B-W2a-46 wo-yield), then per lot and supplier with the leather's issued against used (the Cut record's). */}
        {model.daily && <YieldCard daily={model.daily} actions={actions?.daily} />}
        {yieldValue && <LotYieldCard prefix={model.prefix} workOrder={workOrder} hides={yieldValue.hides} plannedPct={yieldValue.overall.plannedPct} log={log} claims={cut?.can.claims ?? false} />}
        {/* O-WO-cut-bundles: every bundle and where it waits; Reprint N, Split bundle. */}
        {bundles ? <BundlesSection workOrder={workOrder} data={bundles} model={model} actions={actions} /> : <PartState label={t('bundles.list')} problem={model.bundles.problem} onRetry={() => actions?.onRetryPart?.('bundles')} />}
        {/* B-W2a-46 (wo-finish): finished to stock, its figures — Report finished is the band's main step (F-PR-05a). */}
        {model.daily && <FinishedCard daily={model.daily} actions={actions?.daily} />}
        {/* B-W2a-46 (wo-docs "cutting list (W2a)"). */}
        {model.daily && (
          <div className="fw-pr-actions">
            <PrintButton what="cutting" actions={actions?.daily} />
          </div>
        )}
      </div>
    </WithMessages>
  )
}

const cellText = (value: number | null): string => (value === null ? '—' : String(value))

function CellsCard({ rows }: { rows: readonly CutCellRow[] }) {
  const t = useT('production')
  const total = cutCellsTotal(rows)
  return (
    <Card padded className="fw-pr-card">
      <h2 className="fw-pr-h2">{t('cutting.cells.title')}</h2>
      <div className="fw-pr-table">
        <SummaryTable
          label={t('cutting.cells.title')}
          stackOnPhone
          columns={[t('cutting.col.cell'), t('cutting.cells.col.planned'), t('cutting.col.cut'), t('bundles.col.bundled'), t('cutting.cells.col.short')]}
          align={[undefined, 'right', 'right', 'right', 'right']}
          widths={['40%', '15%', '15%', '15%', undefined]}
          rows={[
            ...rows.map((row) => ({
              id: row.id,
              cells: [
                <span key="c" className="fw-pr-cell">
                  <span>
                    {row.colourwayCode} {row.size}
                  </span>
                  {row.parts.length > 0 && <span className="nds-summary-sub">{row.parts.map((part) => partPhrases(part).map((words) => t(words.key, words.params)).join(', ')).join(' · ')}</span>}
                </span>,
                String(row.planned),
                cellText(row.cut),
                <span key="b" className="fw-pr-cell">
                  <span>{cellText(row.bundled)}</span>
                  {row.toBundle !== null && row.toBundle > 0 && <span className="nds-summary-sub">{t('cutting.cells.toBundle', { count: row.toBundle })}</span>}
                </span>,
                row.short === 0 ? (
                  <Tag key="s" tone="success">
                    {t('cutting.cells.cutInFull')}
                  </Tag>
                ) : (
                  cellText(row.short)
                ),
              ],
            })),
            { id: 'total', cells: [<b key="t">{t('cutting.cells.total')}</b>, <b key="p">{total.planned}</b>, <b key="c">{cellText(total.cut)}</b>, <b key="b">{cellText(total.bundled)}</b>, <b key="s">{cellText(total.short)}</b>] },
          ]}
        />
      </div>
      <p className="fw-pr-hint">{t('cutting.cells.hint')}</p>
    </Card>
  )
}

function HidesCard({ log, workOrder, model, actions }: { log: CutLog; workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  const q = (value: string) => quantityText(value, locale)
  // F-PR-06: a hide opens its record with the stock right (the Cut record's link); Reserve leather… is the Cut record's Allocate hides.
  const hideRecords = model.cut?.can.stock ?? false
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('cutting.hides')}</h2>
        {model.daily && <ReserveLeather workOrder={workOrder} daily={model.daily} actions={actions?.daily} />}
      </div>
      {log.hides.length === 0 ? (
        <p className="fw-pr-hint">{t('cutting.noHides')}</p>
      ) : (
        <div className="fw-pr-hides">
          {log.hides.map((hide) => {
            const bar = hideBar(hide)
            return (
              <div key={hide.hideId} className="fw-pr-hide">
                <div className="fw-pr-card-head">
                  {hideRecords ? (
                    <Link className="fw-pr-link fw-pr-code" href={`${model.prefix}/warehouse/hides/${encodeURIComponent(hide.hideId)}`}>
                      {hide.code}
                    </Link>
                  ) : (
                    <span className="fw-pr-code">{hide.code}</span>
                  )}
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
      { colId: 'by', headerName: t('cutting.col.by'), minWidth: 120, flex: 0.9, valueGetter: (params) => params.data?.worker?.name ?? (params.data?.workerHidden ? t('cutting.workerHiddenShort') : '—') },
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
            { label: t('cutting.col.by'), value: entry.worker?.name ?? t(entry.workerHidden ? 'cutting.workerHidden' : 'cutting.noWorker') },
          ]}
        />
        <HidePhoto entry={entry} photo={model.cutPhoto?.entryId === entry.id ? model.cutPhoto : null} />
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
