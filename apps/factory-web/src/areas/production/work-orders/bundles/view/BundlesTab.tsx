'use client'

import { useEffect, useMemo, useState } from 'react'
import { MoreHorizontal, Printer } from 'lucide-react'
import { Card, KeyValue, Menu, Modal, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select, Spinner, Tag, TokenChip } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { BundleRow, WorkOrder, WorkOrderBundles } from '../../../_shared/api'
import { reprintHold, waitingAt } from '../../../_shared/model'
import type { WorkOrderRecordActions, WorkOrderRecordModel } from '../../record/record-model'
import { NotReleased, PartState } from '../../record/view/WorkOrderRecordView'

/**
 * SCR-072 — Bundles (design wo-bundles; MES-065, MES-068, MES-073): per cell what is cut, bundled and still to bundle;
 * every bundle of the work order with where it waits (the first scanned operation it is not done at), its last scan
 * (time, operation, station — never who), its hides and lots (genealogy) and its ticket; a bundle's scans per operation
 * in its detail. Reprint N tickets (production.bundles): a new code each, the old one refused at a scan, with the reason
 * kept on the bundle. Making bundles is the cutting table's (the floor).
 */
export function BundlesTab({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  if (workOrder.status === 'DRAFT') return <NotReleased what={t('bundles.what')} />
  const data = model.bundles.value
  if (!data) return <PartState label={t('tab.bundles')} problem={model.bundles.problem} onRetry={() => actions?.onRetryPart?.('bundles')} />
  return (
    <div className="fw-pr-stack">
      <CellsCard data={data} />
      <BundleList workOrder={workOrder} data={data} model={model} actions={actions} />
      {model.bundleOpen && <BundleDetail data={data} workOrder={workOrder} model={model} actions={actions} />}
    </div>
  )
}

function CellsCard({ data }: { data: WorkOrderBundles }) {
  const t = useT('production')
  return (
    <Card padded className="fw-pr-card">
      <h2 className="fw-pr-h2">{t('bundles.cells')}</h2>
      <SummaryTable
        label={t('bundles.cells')}
        stackOnPhone
        columns={[t('cutting.col.cell'), t('cutting.col.quantity'), t('cutting.col.cut'), t('bundles.col.bundled'), t('bundles.col.toBundle')]}
        align={[undefined, 'right', 'right', 'right', 'right']}
        rows={data.cells.map((cell) => ({
          id: cell.workOrderSizeId,
          cells: [`${cell.colourwayCode} ${cell.size}`, String(cell.quantity), cell.cut === null ? '—' : String(cell.cut), String(cell.bundled), String(cell.toBundle)],
        }))}
      />
      <p className="fw-pr-hint">{t('bundles.cellsHint')}</p>
    </Card>
  )
}

function BundleList({ workOrder, data, model, actions }: { workOrder: WorkOrder; data: WorkOrderBundles; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  const scanned = useMemo(() => workOrder.spec.operations.filter((op) => op.scanRequired).sort((a, b) => a.seq - b.seq), [workOrder.spec.operations])
  const opOf = useMemo(() => new Map(workOrder.spec.operations.map((op) => [op.seq, op])), [workOrder.spec.operations])
  const scannedSeqs = useMemo(() => scanned.map((op) => op.seq), [scanned])
  const rows = useMemo(() => (model.waitingAt === null ? data.bundles : data.bundles.filter((bundle) => waitingAt(bundle, scannedSeqs) === model.waitingAt)), [data.bundles, model.waitingAt, scannedSeqs])
  const [selected, setSelected] = useState<readonly string[]>(model.dialog?.kind === 'reprint' ? model.dialog.bundleIds : [])
  const rowsKey = rows.map((row) => row.id).join(',')
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const canReprint = model.can.bundles && (workOrder.status === 'RELEASED' || workOrder.status === 'IN_PROGRESS')

  const columns = useMemo<ColDef<BundleRow>[]>(() => {
    const CodeCell = ({ data: row }: ICellRendererParams<BundleRow>) =>
      row ? (
        <span className="fw-pr-cell">
          <span className="fw-pr-code">{row.code}</span>
          <span className="fw-pr-cell-sub">{row.replacedCodes.length ? t('bundles.replaced', { count: row.replacedCodes.length }) : t('bundles.firstTicket')}</span>
        </span>
      ) : null
    const CellCell = ({ data: row }: ICellRendererParams<BundleRow>) =>
      row ? (
        <span className="fw-pr-cell">
          <span>
            {row.colourwayCode} {row.size}
          </span>
          <span className="fw-pr-cell-sub">{row.part ? t('bundles.part', { part: row.part }) : t('bundles.whole')}</span>
        </span>
      ) : null
    const StatusCell = ({ data: row }: ICellRendererParams<BundleRow>) => (row ? <Pill tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`bundles.status.${row.status}`)}</Pill> : null)
    const WhereCell = ({ data: row }: ICellRendererParams<BundleRow>) => {
      if (!row) return null
      if (row.status !== 'ACTIVE') return <span>—</span>
      const seq = waitingAt(row, scannedSeqs)
      const op = seq === null ? null : opOf.get(seq)
      return seq === null ? <Tag tone="success">{t('bundles.done')}</Tag> : <span className="fw-pr-ellipsis">{t('bundles.waitingAt', { seq, code: op?.code ?? '' })}</span>
    }
    const LastCell = ({ data: row }: ICellRendererParams<BundleRow>) =>
      row ? (
        row.lastScan ? (
          <span className="fw-pr-cell">
            <span>{formatDateTime(row.lastScan.at, { locale })}</span>
            <span className="fw-pr-cell-sub">{[`${row.lastScan.operation.seq} ${row.lastScan.operation.code}`, row.lastScan.station?.code].filter(Boolean).join(' · ')}</span>
          </span>
        ) : (
          <span>{t('bundles.noScan')}</span>
        )
      ) : null
    const TicketCell = ({ data: row }: ICellRendererParams<BundleRow>) => {
      if (!row) return null
      const job = row.tickets?.[0] ?? null
      return (
        <span className="fw-pr-cell">
          <span>{job ? t(`bundles.job.${job.status}`) : row.tickets === null ? '—' : t('bundles.job.none')}</span>
          <span className="fw-pr-cell-sub">{row.reprints.length ? t('bundles.reprints', { count: row.reprints.length }) : ''}</span>
        </span>
      )
    }
    const MoreCell = ({ data: row }: ICellRendererParams<BundleRow>) => {
      if (!row) return null
      const hold = canReprint ? reprintHold(row, workOrder.status) : null
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('bundles.rowMenu', { code: row.code }) }}
          items={[
            { id: 'open', label: t('bundles.details'), onSelect: () => actions?.onOpenBundle?.(row.id) },
            ...(model.can.bundles
              ? [{ id: 'reprint', label: t('bundles.reprintOne'), disabled: !canReprint || !!hold, description: !canReprint ? t('bundles.hold.notOpen') : hold ? t(`bundles.hold.${hold}`) : undefined, onSelect: () => actions?.onDialog?.({ kind: 'reprint', bundleIds: [row.id] }) }]
              : []),
          ]}
        />
      )
    }
    return [
      { colId: 'code', headerName: t('bundles.col.code'), field: 'code', minWidth: 170, flex: 1.2, cellRenderer: CodeCell },
      { colId: 'cell', headerName: t('cutting.col.cell'), minWidth: 120, flex: 0.9, cellRenderer: CellCell },
      { colId: 'pieces', headerName: t('cutting.col.pieces'), field: 'quantity', minWidth: 92, flex: 0.5, type: 'rightAligned' },
      { colId: 'status', headerName: t('col.status'), field: 'status', minWidth: 100, flex: 0.6, cellRenderer: StatusCell },
      { colId: 'where', headerName: t('bundles.col.where'), minWidth: 150, flex: 1, cellRenderer: WhereCell },
      { colId: 'last', headerName: t('bundles.col.last'), minWidth: 160, flex: 1.1, cellRenderer: LastCell },
      { colId: 'hides', headerName: t('bundles.col.hides'), minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? params.data.hides.map((hide) => hide.code).join(', ') : '') },
      { colId: 'ticket', headerName: t('bundles.col.ticket'), minWidth: 120, flex: 0.8, cellRenderer: TicketCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, scannedSeqs, opOf, canReprint, workOrder.status, model.can.bundles, actions])

  const filter = (
    <>
      <Select size="sm" aria-label={t('bundles.filterLabel')} value={model.waitingAt === null ? '' : String(model.waitingAt)} onChange={(event) => actions?.onWaitingAt?.(event.target.value === '' ? null : Number(event.target.value))}>
        <option value="">{t('bundles.filterAll')}</option>
        {scanned.map((op) => (
          <option key={op.seq} value={op.seq}>
            {t('bundles.waitingAt', { seq: op.seq, code: op.code })}
          </option>
        ))}
      </Select>
      {model.waitingAt !== null && (
        <TokenChip removeLabel={t('bundles.filterClear')} onRemove={() => actions?.onWaitingAt?.(null)}>
          {t('bundles.waitingAt', { seq: model.waitingAt, code: opOf.get(model.waitingAt)?.code ?? '' })}
        </TokenChip>
      )}
    </>
  )

  return (
    <div className="fw-pr-stack">
      <h2 className="fw-pr-h2">{t('bundles.list')}</h2>
      <ListFrame<BundleRow>
        label={t('bundles.list')}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('bundles.count', { count: rows.length })}
        tools={filter}
        selection={
          canReprint
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <Button size="sm" variant="primary" aria-label={t('bundles.reprintMany', { count: selected.length })} onClick={() => actions?.onDialog?.({ kind: 'reprint', bundleIds: [...selected] })}>
                    <Printer size={13} aria-hidden /> <SelectionLabel>{t('bundles.reprintMany', { count: selected.length })}</SelectionLabel>
                  </Button>
                ),
              }
            : undefined
        }
        isRowSelectable={canReprint ? (row) => {
          const hold = reprintHold(row, workOrder.status)
          return hold ? t(`bundles.hold.${hold}`) : null
        } : undefined}
        onOpen={(row) => actions?.onOpenBundle?.(row.id)}
        state={rows.length === 0 ? <p className="fw-pr-hint">{model.waitingAt === null ? t('bundles.empty') : t('bundles.emptyFilter')}</p> : undefined}
      />
      {!model.can.bundles && <p className="fw-pr-hint">{t('bundles.noRight')}</p>}
    </div>
  )
}

function BundleDetail({ data, workOrder, model, actions }: { data: WorkOrderBundles; workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  const open = model.bundleOpen!
  const bundle = data.bundles.find((row) => row.id === open.bundleId)
  if (!bundle) return null
  const hold = model.can.bundles ? reprintHold(bundle, workOrder.status) : null
  const scans = open.scans.value
  const index = data.bundles.findIndex((row) => row.id === bundle.id)
  return (
    <Modal
      open
      onClose={() => actions?.onOpenBundle?.(null)}
      title={t('bundles.detailTitle', { code: bundle.code })}
      subtitle={`${bundle.colourwayCode} ${bundle.size}${bundle.part ? ` · ${bundle.part}` : ''} · ${t('bundles.pieces', { count: bundle.quantity })}`}
      size="lg"
      footer={
        <>
          <Button size="sm" variant="quiet" heldReason={index <= 0 ? t('bundles.first') : null} onClick={() => actions?.onOpenBundle?.(data.bundles[index - 1]!.id)}>
            {t('bundles.previous')}
          </Button>
          <Button size="sm" variant="quiet" heldReason={index >= data.bundles.length - 1 ? t('bundles.last') : null} onClick={() => actions?.onOpenBundle?.(data.bundles[index + 1]!.id)}>
            {t('bundles.next')}
          </Button>
          <span className="grow" />
          {model.can.bundles && (
            <Button size="sm" heldReason={hold ? t(`bundles.hold.${hold}`) : null} onClick={() => actions?.onDialog?.({ kind: 'reprint', bundleIds: [bundle.id] })}>
              <Printer size={13} aria-hidden /> {t('bundles.reprintOne')}
            </Button>
          )}
          <Button size="sm" onClick={() => actions?.onOpenBundle?.(null)}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="fw-pr-dialog">
        <KeyValue
          columns={2}
          items={[
            { label: t('col.status'), value: t(`bundles.status.${bundle.status}`) },
            { label: t('bundles.col.hides'), value: bundle.hides.map((hide) => `${hide.code} (${hide.lotCode})`).join(', ') || '—' },
            { label: t('bundles.made'), value: formatDateTime(bundle.createdAt, { locale }) },
            { label: t('bundles.oldCodes'), value: bundle.replacedCodes.join(', ') || '—' },
          ]}
        />
        <h3 className="fw-pr-h3">{t('bundles.scans')}</h3>
        {!scans ? (
          open.scans.problem ? (
            <p className="fw-pr-hint">{t(open.scans.problem)}</p>
          ) : (
            <p className="fw-pr-hint" role="status">
              <Spinner size={12} /> {t('common.loading')}
            </p>
          )
        ) : scans.length === 0 ? (
          <p className="fw-pr-hint">{t('bundles.noScan')}</p>
        ) : (
          <SummaryTable
            label={t('bundles.scans')}
            stackOnPhone
            columns={[t('bundles.col.when'), t('bundles.col.operation'), t('bundles.col.kind'), t('bundles.col.good'), t('bundles.col.scrap'), t('bundles.col.rework'), t('bundles.col.station')]}
            align={[undefined, undefined, undefined, 'right', 'right', 'right', 'left']}
            rows={scans.map((scan) => ({
              id: scan.id,
              cells: [
                formatDateTime(scan.serverTime, { locale }),
                `${scan.operation.seq} ${scan.operation.code}`,
                <span key="k" className="fw-pr-inline">
                  {t(`bundles.scanKind.${scan.kind}`)}
                  {scan.voidedById && <Tag tone="warning">{t('bundles.voided')}</Tag>}
                </span>,
                String(scan.goodQuantity),
                String(scan.scrapQuantity),
                String(scan.reworkQuantity),
                [scan.station?.code, scan.worker?.name].filter(Boolean).join(' · ') || '—',
              ],
            }))}
          />
        )}
        {bundle.reprints.length > 0 && (
          <>
            <h3 className="fw-pr-h3">{t('bundles.reprintsTitle')}</h3>
            <SummaryTable
              label={t('bundles.reprintsTitle')}
              columns={[t('bundles.col.when'), t('bundles.col.newCode'), t('bundles.col.oldCode'), t('bundles.col.reason'), t('bundles.col.where')]}
              rows={bundle.reprints.map((reprint, i) => ({
                id: String(i),
                cells: [formatDateTime(reprint.at, { locale }), reprint.code, reprint.replacedCode, reprint.reason, t(`bundles.postedBy.${reprint.postedBy}`)],
              }))}
            />
          </>
        )}
      </div>
    </Modal>
  )
}
