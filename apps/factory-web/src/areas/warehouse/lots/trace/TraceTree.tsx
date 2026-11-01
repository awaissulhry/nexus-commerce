'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Checkbox, Pill } from '@nexus/ui/primitives'
import { TraceTree as DsTraceTree, type TraceNode as DsTraceNode } from '@nexus/ui/patterns/trace-tree/index'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { PickerReason } from '../../../_shared/reasons/api'
import { QUALITY_STATUSES, HIDE_STATES } from '../../../_shared/stock/api'
import { quantity } from '../../../_shared/stock/model'
import type { Trace, TraceNode } from '../../stock/daily/api'
import { reasonLabel } from '../../stock/daily/model'
import { useWords, type Words } from '../shared/parts'
import { GAP_TONE, gapPlace, nodeRecord, onlyAffected, TRACE_OPEN_DEPTH, traceTree, type TreeItem } from './model'
import './trace.css'

export interface TraceTreeProps {
  trace: Trace
  prefix: string
  holdReasons: readonly PickerReason[]
  /** Design cases: "Show only affected customers" already on. */
  affectedOnly?: boolean
}

const isUom = (uom: string | null): uom is (typeof UOMS)[number] => !!uom && (UOMS as readonly string[]).includes(uom)
const SERIAL_STATUSES: readonly string[] = ['MADE', 'RELEASED', 'SHIPPED', 'VOID']
const SHIPMENT_STATUSES: readonly string[] = ['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED']
/** A status in words only when the catalogue knows it (a new status is left out, never drawn as a code). */
const known = (list: readonly string[], value: string, key: string, t: Words): string | null => (list.includes(value) ? t(key) : null)

/**
 * The trace tree (design warehouse.lots lt-trace-tree): the DS TraceTree (B-W2b-18; it was composed here until B-W2b-09
 * built the part) over the trace — the levels with their counts first (exact, and "may hold it" for what the records
 * know only per work order or size), the gaps of the chain in words by severity, what the reader may not see, "Show only
 * affected customers", then the tree — the start, Came from, Went to — that the arrow keys walk (the DS's WAI-ARIA tree;
 * Enter opens the node's record; its keys in the one information icon under it). A node on hold shows the hold's
 * reason. Read only.
 */
export function TraceTree({ trace, prefix, holdReasons, affectedOnly = false }: TraceTreeProps) {
  const t = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const [affected, setAffected] = useState(affectedOnly)
  const base = useMemo(() => traceTree(trace), [trace])
  const root = useMemo(() => (base && affected ? onlyAffected(base) : base), [base, affected])
  const roots = useMemo(() => {
    if (!root || (affected && root.children.every((section) => section.children.length === 0))) return []
    const draw = (item: TreeItem): DsTraceNode => ({ ...nodeOf(item, prefix, holdReasons, t, locale, ds.traceTree.possibleCount), children: item.children.map(draw) })
    return [draw(root)]
  }, [root, affected, prefix, holdReasons, t, locale, ds.traceTree])

  const gapsBy = (severity: keyof typeof GAP_TONE) => trace.gaps.filter((gap) => gap.severity === severity)
  const received = trace.customersReceived.exact + trace.customersReceived.possible

  return (
    <DsTraceTree
      label={t('lt.tree.label', { code: trace.start.code })}
      roots={roots}
      levels={trace.levels.map((level) => ({ id: level.kind, label: t(`lt.tree.count.${level.kind}`, { count: level.exact + level.possible }), possible: level.possible }))}
      defaultOpenDepth={TRACE_OPEN_DEPTH}
      before={
        <>
          {(['BROKEN', 'COARSE', 'IN_WORK'] as const).map((severity) =>
            gapsBy(severity).length > 0 ? (
              <Banner key={severity} tone={GAP_TONE[severity]} title={t(`lt.tree.gapTitle.${severity}`)}>
                <ul className="fw-tt-gaps">
                  {gapsBy(severity).map((gap) => (
                    <li key={`${gap.code}:${gap.at}`}>{t(`lt.tree.gap.${gap.code}`, { at: gapPlace(trace, gap.at), count: gap.count })}</li>
                  ))}
                </ul>
              </Banner>
            ) : null,
          )}
          {trace.restricted.map((entry) => (
            <p key={entry.permission} className="fw-wl-hint">
              {t('lt.tree.restricted', { count: entry.nodes, permission: entry.permission })}
            </p>
          ))}
          <div className="fw-tt-tools">
            <Checkbox checked={affected} onChange={(event) => setAffected(event.target.checked)} label={t('lt.tree.affected', { count: received })} />
          </div>
        </>
      }
      empty={<EmptyState title={affected ? t('lt.tree.noAffected') : t('lt.tree.empty')} />}
      labels={ds.traceTree}
    />
  )
}

/** One item of the trace as a DS tree node (without its children): its level word, code, record, facts and holds. */
function nodeOf(item: TreeItem, prefix: string, holdReasons: readonly PickerReason[], t: Words, locale: ReturnType<typeof useLocale>, possibleCount: (count: number) => string): Omit<DsTraceNode, 'children'> {
  if (item.type === 'section') return { id: item.id, label: t(item.side === 'BACKWARD' ? 'lt.tree.cameFrom' : 'lt.tree.wentTo', { count: item.count }) }
  if (item.type === 'group')
    return {
      id: item.id,
      label: t(`lt.tree.count.${item.kind}`, { count: item.exact + item.possible }),
      ...(item.possible > 0 ? { meta: <span className="fw-st-sub">{possibleCount(item.possible)}</span> } : {}),
    }
  const node = item.node
  const record = nodeRecord(node)
  const qty = item.edge?.quantity ? `${quantity(item.edge.quantity, locale)} ${isUom(item.edge.uom) ? t(`stock:uom.${item.edge.uom}`) : (item.edge.uom ?? '')}`.trim() : null
  const detail = nodeDetail(node, t, locale)
  const meta: ReactNode = (
    <>
      {detail && <span className="fw-tt-detail">{detail}</span>}
      {qty && <span className="fw-st-num fw-tt-qty">{qty}</span>}
      {node.kind === 'CUSTOMER' && node.received && <Pill tone="info">{t('lt.tree.received')}</Pill>}
    </>
  )
  return {
    id: item.id,
    kind: t(`lt.tree.kind.${node.kind}`),
    label: node.code ?? t('lt.tree.hidden'),
    href: record ? `${prefix}${recordAddress({ type: record.type, id: record.id }, OFFICE_PAGES)}${record.tab ? `?tab=${record.tab}` : ''}` : null,
    possible: node.reach === 'POSSIBLE',
    meta,
    ...(node.holds.length > 0
      ? {
          note: (
            <span className="fw-tt-holds">
              {node.holds.map((hold) => (
                <Pill key={hold.id} tone="danger">
                  {t('lt.tree.onHold', { reason: reasonLabel(holdReasons, hold.reasonCode, locale) })}
                </Pill>
              ))}
            </span>
          ),
        }
      : {}),
  }
}

/** One line about the node in our words (no status code drawn as such). */
function nodeDetail(node: TraceNode, t: Words, locale: ReturnType<typeof useLocale>): string {
  const parts: (string | null)[] = []
  switch (node.kind) {
    case 'SUPPLIER':
    case 'CUSTOMER':
      parts.push(node.party ? node.party.name : t('lt.tree.partyHidden'))
      break
    case 'RECEIPT':
      parts.push(node.receipt?.supplierDdtNumber ? t('lt.tree.ddt', { number: node.receipt.supplierDdtNumber }) : null)
      break
    case 'LOT':
      if (node.lot) {
        parts.push(`${node.lot.item.code} · ${node.lot.item.name}`, node.lot.colourCode)
        if ((QUALITY_STATUSES as readonly string[]).includes(node.lot.qualityStatus)) parts.push(t(`stock:quality.${node.lot.qualityStatus}`))
        if (isUom(node.lot.item.baseUom)) parts.push(t('lt.tree.onHand', { quantity: `${quantity(node.lot.onHand, locale)} ${t(`stock:uom.${node.lot.item.baseUom}`)}` }))
      }
      break
    case 'HIDE':
      if (node.hide && (HIDE_STATES as readonly string[]).includes(node.hide.state)) parts.push(t(`stock:hideState.${node.hide.state}`))
      break
    case 'WORK_ORDER':
      if (node.workOrder) parts.push(node.workOrder.styleCode, node.workOrder.batchNumber ? t('lt.tree.batch', { batch: node.workOrder.batchNumber }) : null, known(WORK_ORDER_STATUSES, node.workOrder.status, `lt.tree.woStatus.${node.workOrder.status}`, t))
      break
    case 'CELL':
      if (node.cell) parts.push(`${node.cell.colourwayCode} · ${node.cell.size}`, t('lt.tree.garments', { count: node.cell.quantity }))
      break
    case 'BUNDLE':
      if (node.bundle) parts.push(t('lt.tree.garments', { count: node.bundle.quantity }), node.bundle.part)
      break
    case 'SERIAL':
      if (node.serial) parts.push(known(SERIAL_STATUSES, node.serial.status, `lt.tree.serialStatus.${node.serial.status}`, t))
      break
    case 'SHIPMENT':
      if (node.shipment) parts.push(known(SHIPMENT_STATUSES, node.shipment.status, `lt.shipmentStatus.${node.shipment.status}`, t), node.shipment.ddtNumbers.length > 0 ? t('lt.tree.ddt', { number: node.shipment.ddtNumbers.join(', ') }) : null)
      break
    case 'SUBCONTRACT':
      parts.push(node.subcontract?.workshop?.name ?? t('lt.tree.partyHidden'))
      break
  }
  return parts.filter(Boolean).join(' · ')
}
