'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Ban, CheckCircle2, Copy, Layers, MoreHorizontal, Pencil, Plus, Scissors, Split, Trash2, XCircle } from 'lucide-react'
import { Card, KeyValue, Menu, ProgressBar } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, money, quantity, unitPrice } from '../../../../_shared/buying/model'
import type { PoLine, PurchaseOrder } from '../../api'
import { leatherSpecs, receivedShare, type OrderRecordActions, type OrderRecordModel } from '../../model'
import { addedInDraft, cancelLineHeld, closeShortHeld } from '../../daily-model'
import { RevisionDraftBanner } from './ChangesSections'
import { useSay } from './DailyDialogs'
import { detailsOf } from './OrderRecordView'
// B-W2b-333: the lines in depth — kinds, what each line blocks if late, the held compliance mark, the totals per currency.
import { allChecks, DEPTH, kindDraftOf, kindEditHeld, kindFields, kindPhrases, scheduleDraftOf, scheduleEditHeld } from '../../depth/model'
import { BlocksWords, HeldMarks, KindWords, LaterWords, lineHeld, SendApprovalNote, TotalsCard } from '../../depth/view/LinesDepth'

/**
 * Lines (SCR-059): what we buy, on the list frame — material and colour with the supplier's own codes, the quantity in the
 * order's unit (leather: the area and ≈ hides), the leather specs in words (grade, thickness, one dye batch, area
 * tolerance, chromium VI test), the need date, the supplier's confirmation kept apart from what we asked, what has come
 * (received by the posted receipts), and price and net (cost grain only: not drawn without it). A draft adds, changes
 * and removes lines (n adds one); a sent order is read-only. Below it, side by side: what a send checks now, the
 * details and the totals.
 */
export function LinesTab({ order, model, actions }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('buying')
  const td = useT('purchasing-orders')
  const tw = useT(DEPTH)
  const say = useSay()
  const depth = model.depth ?? null
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const draft = order.status === 'DRAFT'
  const editable = draft && model.can.poManage
  // B-W2a-69: lines that end — cancelled (a sent order's line, or one an earlier revision sent) or closed short.
  const added = addedInDraft(model.revisions.value)
  const cancelHeldOf = (line: PoLine) => cancelLineHeld(order, line, added, model.can)
  const closeHeldOf = (line: PoLine) => closeShortHeld(order, line, model.can)
  const ending = !draft && model.can.poManage && ['SENT', 'DECLINED', 'CONFIRMED', 'PARTLY_RECEIVED'].includes(order.status)
  // B-W2b-333: lines picked to reorder (Duplicate with these lines) on any order a buyer may copy.
  const reorder = !!depth && model.can.poManage
  const selectable = editable || ending || reorder
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rowsKey = order.lines.map((line) => line.id).join(',')
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])

  // n: add a line (a draft only; never while typing or in a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.dialog || !editable) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'n') {
        event.preventDefault()
        actions?.onAddLine?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const columns = useMemo<ColDef<PoLine>[]>(() => {
    const MaterialCell = ({ data }: ICellRendererParams<PoLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-ellipsis">
            {data.item.code} · {data.item.name}
            {data.ended && (
              <>
                {' '}
                <Tag tone="neutral">{td(`ended.${data.ended.kind}`)}</Tag>
              </>
            )}
          </span>
          <span className="fw-by-cell-sub">
            {/* B-W2b-333: the held compliance mark, first on the line's second row (never cut by the name's ellipsis). */}
            {depth && lineHeld(depth, data.id, order.status) && (
              <>
                <Tag tone="danger">{tw('mark.lineHeld')}</Tag>{' '}
              </>
            )}
            {[data.colour ? `${data.colour.code} ${data.colour.name}` : null, data.supplierArticleCode ? t('po.line.theirCode', { code: [data.supplierArticleCode, data.supplierColourCode].filter(Boolean).join(' / ') }) : null].filter(Boolean).join(' · ') || t(`kind.${data.item.kind}`)}
          </span>
        </span>
      ) : null
    const QuantityCell = ({ data }: ICellRendererParams<PoLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-num">
            {quantity(data.quantity, locale)} {t(`uom.${data.uom}`)}
          </span>
          <span className="fw-by-cell-sub">
            {data.uom !== data.baseUom ? `${quantity(data.baseQuantity, locale)} ${t(`uom.${data.baseUom}`)}` : ''}
            {data.estimatedHides !== null && data.uom !== 'HIDE' ? `${data.uom !== data.baseUom ? ' · ' : ''}${t('plan.hides', { count: data.estimatedHides })}` : ''}
          </span>
        </span>
      ) : null
    const SpecsCell = ({ data }: ICellRendererParams<PoLine>) => {
      if (!data) return null
      const specs = leatherSpecs(data)
      const kind = depth?.kinds.value?.lines.find((line) => line.id === data.id)
      const own = specs.length === 0 ? null : <span className="fw-by-ellipsis">{specs.map((spec) => t(spec.key, spec.params)).join(' · ')}</span>
      // B-W2b-333: fabric and trim by rolls, a protector's certificate, the variant (B-W2b-328).
      if (!own && (!kind || kindPhrases(kind).length === 0)) return <span className="fw-by-cell-sub">—</span>
      return (
        <span className="fw-by-cell">
          {own}
          <KindWords line={kind} />
        </span>
      )
    }
    const NeedCell = ({ data }: ICellRendererParams<PoLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span>{formatDate(dayAt(data.needDate), place)}</span>
          <span className="fw-by-cell-sub">
            {data.confirmedDate
              ? t('po.line.confirmed', { quantity: quantity(data.confirmedQuantity, locale), unit: t(`uom.${data.uom}`), date: formatDate(dayAt(data.confirmedDate), place) })
              : order.status === 'DRAFT'
                ? t('po.line.notSent')
                : t('po.line.notConfirmed')}
          </span>
          {depth && <LaterWords model={depth} lineId={data.id} />}
        </span>
      ) : null
    const ReceivedCell = ({ data }: ICellRendererParams<PoLine>) => {
      if (!data) return null
      const share = receivedShare(data)
      return (
        <span className="fw-by-cell">
          <ProgressBar value={share === null ? null : Math.round(share * 100)} height={6} ariaLabel={t('po.line.receivedLabel', { seq: data.seq })} />
          <span className="fw-by-cell-sub">{t('po.line.received', { received: quantity(data.receivedBaseQuantity, locale), ordered: quantity(data.baseQuantity, locale), unit: t(`uom.${data.baseUom}`) })}</span>
        </span>
      )
    }
    const PriceCell = ({ data }: ICellRendererParams<PoLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-num">{money(data.netAmount ?? null, order.currency, locale)}</span>
          <span className="fw-by-cell-sub">{t('po.line.unitPrice', { price: unitPrice(data.unitPrice ?? null, order.currency, locale), unit: t(`uom.${data.uom}`) })}</span>
        </span>
      ) : null
    const PlanCell = ({ data }: ICellRendererParams<PoLine>) =>
      data ? (
        data.ended ? (
          <span className="fw-by-cell-sub" title={data.ended.reason ?? undefined}>
            {td(`ended.${data.ended.kind}`)}
          </span>
        ) : data.plan.length > 0 ? (
          <Tag tone="info">{t('po.line.fromPlan')}</Tag>
        ) : null
      ) : null
    const BlocksCell = ({ data }: ICellRendererParams<PoLine>) => (data && depth ? <BlocksWords model={depth} line={data} prefix={model.prefix} /> : null)
    const MoreCell = ({ data }: ICellRendererParams<PoLine>) => {
      if (!data || (!editable && !ending && !reorder)) return null
      // A draft of revision 2+ cancels the lines an earlier revision sent; a sent order cancels or closes its open lines short.
      const cancel = !data.ended && (ending || (editable && order.revision > 1 && !added.has(data.id))) ? cancelHeldOf(data) : undefined
      const close = ending && order.status === 'PARTLY_RECEIVED' && !data.ended ? closeHeldOf(data) : undefined
      // B-W2b-333: a draft line's rolls, certificate or variant and its deliveries; reorder one line.
      const kind = depth?.kinds.value?.lines.find((line) => line.id === data.id)
      const kindOpen = depth && kind && depth.kinds.value && kindEditHeld(depth.kinds.value, kind, depth.can) === null && (kindFields(kind).rolls || kindFields(kind).certificate || kindFields(kind).variant)
      const depthLine = depth?.depth.value?.lines.find((line) => line.id === data.id)
      const splitOpen = depth && depthLine && scheduleEditHeld(order.status, depthLine, depth.can) === null
      const items = [
        ...(editable && !data.ended ? [{ id: 'edit', label: t('po.line.edit'), icon: <Pencil size={14} aria-hidden />, onSelect: () => actions?.onEditLine?.(data.id) }] : []),
        ...(kindOpen && kind ? [{ id: 'kind', label: tw('kindDialog.open'), icon: <Layers size={14} aria-hidden />, onSelect: () => actions?.depth?.onDialog?.({ kind: 'lineKind', draft: kindDraftOf(kind) }) }] : []),
        ...(splitOpen && depthLine ? [{ id: 'split', label: tw(depthLine.deliveries.length > 0 ? 'schedule.change' : 'schedule.split'), icon: <Split size={14} aria-hidden />, onSelect: () => actions?.depth?.onDialog?.({ kind: 'schedule', lineId: data.id, rows: scheduleDraftOf(depthLine) }) }] : []),
        ...(reorder && data.ended?.kind !== 'CANCELLED' ? [{ id: 'reorder', label: tw('duplicate.reorderLine'), icon: <Copy size={14} aria-hidden />, onSelect: () => actions?.depth?.onDialog?.({ kind: 'duplicate', draft: { lineIds: [data.id], needDate: '' } }) }] : []),
        ...(cancel === null ? [{ id: 'cancelLine', label: td('line.cancel'), icon: <Ban size={14} aria-hidden />, tone: 'danger' as const, onSelect: () => actions?.daily?.onEndLines?.('CANCEL_LINES', [data.id]) }] : []),
        ...(close === null ? [{ id: 'closeShort', label: td('line.closeShort'), icon: <Scissors size={14} aria-hidden />, onSelect: () => actions?.daily?.onEndLines?.('CLOSE_SHORT', [data.id]) }] : []),
        ...(editable && !data.ended ? [{ id: 'remove', label: t('po.line.remove'), icon: <Trash2 size={14} aria-hidden />, tone: 'danger' as const, onSelect: () => actions?.onDialog?.({ kind: 'removeLines', lineIds: [data.id] }) }] : []),
      ]
      if (items.length === 0) return null
      return <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('po.line.menu', { seq: data.seq }) }} items={items} />
    }
    return [
      { colId: 'seq', headerName: t('po.col.seq'), field: 'seq', minWidth: 58, maxWidth: 70, type: 'rightAligned' },
      { colId: 'material', headerName: t('po.col.material'), minWidth: 210, flex: 1.7, cellRenderer: MaterialCell },
      { colId: 'quantity', headerName: t('po.col.quantity'), minWidth: 130, flex: 0.9, cellRenderer: QuantityCell },
      { colId: 'specs', headerName: t('po.col.specs'), minWidth: 200, flex: 1.5, cellRenderer: SpecsCell },
      { colId: 'need', headerName: t('po.col.needConfirmed'), minWidth: 180, flex: 1.2, cellRenderer: NeedCell },
      ...(order.status !== 'DRAFT' ? [{ colId: 'received', headerName: t('po.col.received'), minWidth: 170, flex: 1.1, cellRenderer: ReceivedCell } satisfies ColDef<PoLine>] : []),
      ...(model.can.cost ? [{ colId: 'net', headerName: t('po.col.net'), minWidth: 140, flex: 0.9, type: 'rightAligned', cellRenderer: PriceCell } satisfies ColDef<PoLine>] : []),
      // B-W2b-333 (design rec lines "For orders (W2b: what it blocks if late)"): the work and customer orders it supplies.
      ...(depth ? [{ colId: 'blocks', headerName: tw('blocks.col'), minWidth: 180, flex: 1.1, cellRenderer: BlocksCell } satisfies ColDef<PoLine>] : []),
      { colId: 'plan', headerName: t('po.col.plan'), minWidth: 124, flex: 0.6, cellRenderer: PlanCell },
      ...(selectable ? [{ colId: 'more', headerName: t('po.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell } satisfies ColDef<PoLine>] : []),
    ]
    // B-W2b-333: the depth parts' reads (state; the model object around them is new each render).
  }, [t, td, tw, locale, order.status, order.currency, order.revision, model.can.cost, model.prefix, editable, ending, reorder, added, depth?.kinds.value, depth?.demand.value, depth?.compliance.value, depth?.depth.value, depth?.can])

  // B-W2b-333: the record's own checks and the compliance gate's (the order's `send` leaves the gate out).
  const checks = order.status === 'DRAFT' ? allChecks(order.send?.checks ?? [], depth?.compliance.value ?? null) : (order.send?.checks ?? [])
  const blocking = checks.filter((check) => check.severity === 'BLOCKS')
  const warnings = checks.filter((check) => check.severity === 'WARNING')
  const details = detailsOf(order)

  const picked = order.lines.filter((line) => selected.includes(line.id))
  const cancelPicked = picked.filter((line) => cancelHeldOf(line) === null)
  const bulkCancelHeld = picked.length === 0 ? null : cancelPicked.length < picked.length ? say(cancelHeldOf(picked.find((line) => cancelHeldOf(line) !== null)!)) : null
  const reorderPicked = picked.filter((line) => line.ended?.kind !== 'CANCELLED')
  const bulkReorder = reorder && (
    <Button size="sm" heldReason={reorderPicked.length === 0 ? tw('duplicate.held.noLine') : null} aria-label={tw('duplicate.reorderN', { count: reorderPicked.length })} onClick={() => actions?.depth?.onDialog?.({ kind: 'duplicate', draft: { lineIds: reorderPicked.map((line) => line.id), needDate: '' } })}>
      <Copy size={13} aria-hidden /> <SelectionLabel>{tw('duplicate.reorderN', { count: reorderPicked.length })}</SelectionLabel>
    </Button>
  )
  const bulkCancel = (ending || (editable && order.revision > 1)) && (
    <Button size="sm" tone="danger" heldReason={bulkCancelHeld} aria-label={td('line.cancelN', { count: picked.length })} onClick={() => actions?.daily?.onEndLines?.('CANCEL_LINES', picked.map((line) => line.id))}>
      <Ban size={13} aria-hidden /> <SelectionLabel>{td('line.cancelN', { count: picked.length })}</SelectionLabel>
    </Button>
  )

  return (
    <div className="fw-by-stack">
      <RevisionDraftBanner order={order} model={model} />
      {depth && <HeldMarks order={order} model={depth} actions={actions?.depth} />}
      <div className="fw-by-stack">
        {editable && (
          <div className="fw-by-head">
            <span className="fw-by-hint">{t('po.lines.draftHint')}</span>
            <Button size="sm" variant="primary" onClick={() => actions?.onAddLine?.()} aria-keyshortcuts="n">
              <Plus size={14} aria-hidden /> {t('po.lines.add')}
            </Button>
          </div>
        )}
        <ListFrame<PoLine>
          label={t('po.lines.tableLabel')}
          rows={order.lines}
          rowId={(line) => line.id}
          columns={columns}
          count={t('po.lines.count', { count: order.lines.length })}
          selection={
            selectable
              ? {
                  selected,
                  onChange: setSelected,
                  actions: (
                    <>
                      {bulkReorder}
                      {bulkCancel}
                      {editable && (
                        <Button size="sm" tone="danger" aria-label={t('po.lines.remove', { count: selected.length })} onClick={() => actions?.onDialog?.({ kind: 'removeLines', lineIds: [...selected] })}>
                          <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('po.lines.remove', { count: selected.length })}</SelectionLabel>
                        </Button>
                      )}
                    </>
                  ),
                }
              : undefined
          }
          isRowSelectable={(line) => (line.ended ? td(`ended.${line.ended.kind}`) : null)}
          keys={editable ? [{ keys: ['n'], does: t('po.lines.keyAdd') }] : []}
          onOpen={editable ? (line) => actions?.onEditLine?.(line.id) : undefined}
          state={
            order.lines.length === 0 ? (
              <p className="fw-by-hint">{editable ? t('po.lines.empty') : t('po.lines.emptySent')}</p>
            ) : undefined
          }
        />
      </div>
      <div className="fw-by-cards">
        {order.status === 'DRAFT' && (
          <Card padded>
            <div className="fw-by-stack">
              <h3 className="fw-by-h3">{t('po.lines.checksTitle')}</h3>
              {depth && <SendApprovalNote model={depth} />}
              {checks.length === 0 ? (
                <p className="fw-by-check">
                  <CheckCircle2 size={16} className="fw-by-ico is-ok" aria-hidden /> {t('po.lines.ready')}
                </p>
              ) : (
                <ul className="fw-by-checks">
                  {[...blocking, ...warnings].map((check, index) => (
                    <li key={`${check.code}-${index}`} className="fw-by-check">
                      {check.severity === 'BLOCKS' ? <XCircle size={16} className="fw-by-ico is-blocked" aria-hidden /> : <AlertTriangle size={16} className="fw-by-ico is-warning" aria-hidden />}
                      <span className="fw-by-check-body">{t(`po.check.${check.code}`)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        )}
        <Card padded>
          <div className="fw-by-stack">
            <div className="fw-by-card-head">
              <h3 className="fw-by-h3">{t('po.details.title')}</h3>
              {editable && (
                <Button size="sm" variant="quiet" onClick={() => actions?.onDialog?.({ kind: 'details', draft: details })}>
                  <Pencil size={13} aria-hidden /> {t('common.edit')}
                </Button>
              )}
            </div>
            <KeyValue
              dense
              columns={2}
              labelCase="sentence"
              items={[
                { label: t('po.details.contact'), value: order.contact ? `${order.contact.name}${order.contact.email ? ` · ${order.contact.email}` : ''}` : t('po.details.noContact') },
                { label: t('po.details.requested'), value: order.requestedDate ? formatDate(dayAt(order.requestedDate), place) : '—' },
                { label: t('po.details.incoterms'), value: order.incoterms ?? '—' },
                { label: t('po.details.paymentTerms'), value: order.paymentTerms ?? '—' },
                { label: t('po.details.note'), value: order.note ?? '—', hint: t('po.details.noteHint') },
                { label: t('po.details.internalNote'), value: order.internalNote ?? '—', hint: t('po.details.internalHint') },
              ]}
            />
          </div>
        </Card>
        {/* B-W2b-333: the net per currency; another currency with its rate at order (the cost grain only). */}
        {model.can.cost && <TotalsCard order={order} model={depth} actions={actions?.depth} />}
      </div>
    </div>
  )
}
