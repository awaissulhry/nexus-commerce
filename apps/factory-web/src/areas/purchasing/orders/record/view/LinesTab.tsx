'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, MoreHorizontal, Pencil, Plus, Trash2, XCircle } from 'lucide-react'
import { Card, KeyValue, Menu, ProgressBar } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, money, quantity, unitPrice } from '../../../../_shared/buying/model'
import type { PoLine, PurchaseOrder } from '../../api'
import { leatherSpecs, receivedShare, type OrderRecordActions, type OrderRecordModel } from '../../model'
import { detailsOf } from './OrderRecordView'

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
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const draft = order.status === 'DRAFT'
  const editable = draft && model.can.poManage
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
          </span>
          <span className="fw-by-cell-sub">
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
      return specs.length === 0 ? <span className="fw-by-cell-sub">—</span> : <span className="fw-by-ellipsis">{specs.map((spec) => t(spec.key, spec.params)).join(' · ')}</span>
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
    const PlanCell = ({ data }: ICellRendererParams<PoLine>) => (data && data.plan.length > 0 ? <Tag tone="info">{t('po.line.fromPlan')}</Tag> : null)
    const MoreCell = ({ data }: ICellRendererParams<PoLine>) =>
      data && editable ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('po.line.menu', { seq: data.seq }) }}
          items={[
            { id: 'edit', label: t('po.line.edit'), icon: <Pencil size={14} aria-hidden />, onSelect: () => actions?.onEditLine?.(data.id) },
            { id: 'remove', label: t('po.line.remove'), icon: <Trash2 size={14} aria-hidden />, tone: 'danger', onSelect: () => actions?.onDialog?.({ kind: 'removeLines', lineIds: [data.id] }) },
          ]}
        />
      ) : null
    return [
      { colId: 'seq', headerName: t('po.col.seq'), field: 'seq', minWidth: 58, maxWidth: 70, type: 'rightAligned' },
      { colId: 'material', headerName: t('po.col.material'), minWidth: 210, flex: 1.7, cellRenderer: MaterialCell },
      { colId: 'quantity', headerName: t('po.col.quantity'), minWidth: 130, flex: 0.9, cellRenderer: QuantityCell },
      { colId: 'specs', headerName: t('po.col.specs'), minWidth: 200, flex: 1.5, cellRenderer: SpecsCell },
      { colId: 'need', headerName: t('po.col.needConfirmed'), minWidth: 180, flex: 1.2, cellRenderer: NeedCell },
      ...(order.status !== 'DRAFT' ? [{ colId: 'received', headerName: t('po.col.received'), minWidth: 170, flex: 1.1, cellRenderer: ReceivedCell } satisfies ColDef<PoLine>] : []),
      ...(model.can.cost ? [{ colId: 'net', headerName: t('po.col.net'), minWidth: 140, flex: 0.9, type: 'rightAligned', cellRenderer: PriceCell } satisfies ColDef<PoLine>] : []),
      { colId: 'plan', headerName: t('po.col.plan'), minWidth: 124, flex: 0.6, cellRenderer: PlanCell },
      ...(editable ? [{ colId: 'more', headerName: t('po.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell } satisfies ColDef<PoLine>] : []),
    ]
  }, [t, locale, order.status, order.currency, model.can.cost, editable])

  const checks = order.send?.checks ?? []
  const blocking = checks.filter((check) => check.severity === 'BLOCKS')
  const warnings = checks.filter((check) => check.severity === 'WARNING')
  const details = detailsOf(order)

  return (
    <div className="fw-by-stack">
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
            editable
              ? {
                  selected,
                  onChange: setSelected,
                  actions: (
                    <Button size="sm" tone="danger" aria-label={t('po.lines.remove', { count: selected.length })} onClick={() => actions?.onDialog?.({ kind: 'removeLines', lineIds: [...selected] })}>
                      <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('po.lines.remove', { count: selected.length })}</SelectionLabel>
                    </Button>
                  ),
                }
              : undefined
          }
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
        {model.can.cost && (
          <Card padded>
            <div className="fw-by-stack">
              <h3 className="fw-by-h3">{t('po.totals.title')}</h3>
              <KeyValue
                dense
                labelCase="sentence"
                items={[
                  { label: t('po.totals.net'), value: <span className="fw-by-num">{money(order.netAmount ?? null, order.currency, locale)}</span>, hint: t('po.totals.netHint') },
                  { label: t('po.totals.lines'), value: String(order.lines.length) },
                ]}
              />
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
