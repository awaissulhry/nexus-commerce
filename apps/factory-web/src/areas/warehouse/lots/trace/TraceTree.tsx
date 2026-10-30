'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Checkbox, Pill, Tag } from '@nexus/ui/primitives'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { useLocale } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { ListKeysInfo } from '../../../../list-frame/ListKeysInfo'
import type { PickerReason } from '../../../_shared/reasons/api'
import { QUALITY_STATUSES, HIDE_STATES } from '../../../_shared/stock/api'
import { quantity } from '../../../_shared/stock/model'
import type { Trace, TraceNode } from '../../stock/daily/api'
import { reasonLabel } from '../../stock/daily/model'
import { useWords, type Words } from '../shared/parts'
import { defaultOpen, GAP_TONE, gapPlace, nodeRecord, onlyAffected, traceTree, treeMove, visibleRows, type TreeItem, type TreeKey, type VisibleRow } from './model'
import './trace.css'

export interface TraceTreeProps {
  trace: Trace
  prefix: string
  holdReasons: readonly PickerReason[]
  /** Design cases: "Show only affected customers" already on. */
  affectedOnly?: boolean
}

const TREE_KEYS: readonly string[] = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']
const isUom = (uom: string | null): uom is (typeof UOMS)[number] => !!uom && (UOMS as readonly string[]).includes(uom)
const SERIAL_STATUSES: readonly string[] = ['MADE', 'RELEASED', 'SHIPPED', 'VOID']
const SHIPMENT_STATUSES: readonly string[] = ['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED']
/** A status in words only when the catalogue knows it (a new status is left out, never drawn as a code). */
const known = (list: readonly string[], value: string, key: string, t: Words): string | null => (list.includes(value) ? t(key) : null)

/**
 * The trace tree (design warehouse.lots lt-trace-tree; "TraceTree (new)", a DS gap composed here): the levels with their
 * counts first (exact, and "may hold it" for what the records know only per work order or size), the gaps of the chain
 * in words by severity, what the reader may not see, "Show only affected customers", and the tree — the start, Came
 * from, Went to — that the arrow keys walk (WAI-ARIA tree: ↑ ↓, → opens or goes in, ← closes or goes out, Home / End;
 * Enter opens the node's record; a click opens or closes a row). A node on hold shows the hold's reason. Read only.
 */
export function TraceTree({ trace, prefix, holdReasons, affectedOnly = false }: TraceTreeProps) {
  const t = useWords()
  const locale = useLocale()
  const [affected, setAffected] = useState(affectedOnly)
  const base = useMemo(() => traceTree(trace), [trace])
  const root = useMemo(() => (base && affected ? onlyAffected(base) : base), [base, affected])
  const [open, setOpen] = useState<Set<string>>(() => defaultOpen(base))
  useEffect(() => setOpen(defaultOpen(base)), [base])
  const rows = useMemo(() => visibleRows(root, open), [root, open])
  const [focus, setFocus] = useState<string>('start')
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const moved = useRef(false)
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    rowRefs.current.get(focus)?.focus()
  }, [focus, rows])

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const onKey = (event: KeyboardEvent<HTMLDivElement>, row: VisibleRow) => {
    if (event.key === 'Enter') {
      const link = rowRefs.current.get(row.item.id)?.querySelector<HTMLAnchorElement>('a[href]')
      if (link) {
        event.preventDefault()
        link.click()
      } else if (row.expandable) {
        event.preventDefault()
        toggle(row.item.id)
      }
      return
    }
    if (event.key === ' ' && row.expandable) {
      event.preventDefault()
      toggle(row.item.id)
      return
    }
    if (!TREE_KEYS.includes(event.key)) return
    event.preventDefault()
    const step = treeMove(rows, row.item.id, event.key as TreeKey)
    if (step.toggle) toggle(step.toggle)
    moved.current = true
    setFocus(step.focus)
  }

  const gapsBy = (severity: keyof typeof GAP_TONE) => trace.gaps.filter((gap) => gap.severity === severity)
  const received = trace.customersReceived.exact + trace.customersReceived.possible
  const focusable = rows.some((row) => row.item.id === focus) ? focus : (rows[0]?.item.id ?? 'start')

  return (
    <div className="fw-tt">
      <ul className="fw-tt-levels" aria-label={t('lt.tree.levels')}>
        {trace.levels.map((level) => (
          <li key={level.kind}>
            <Tag tone="neutral">{t(`lt.tree.count.${level.kind}`, { count: level.exact + level.possible })}</Tag>
            {level.possible > 0 && <span className="fw-st-sub">{t('lt.tree.possibleCount', { count: level.possible })}</span>}
          </li>
        ))}
      </ul>
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
      {!root || (affected && root.children.every((section) => section.children.length === 0)) ? (
        <EmptyState title={affected ? t('lt.tree.noAffected') : t('lt.tree.empty')} />
      ) : (
        <div className="fw-tt-tree" role="tree" aria-label={t('lt.tree.label', { code: trace.start.code })}>
          {rows.map((row) => (
            <div
              key={row.item.id}
              ref={(element) => {
                if (element) rowRefs.current.set(row.item.id, element)
                else rowRefs.current.delete(row.item.id)
              }}
              className={row.item.type === 'section' ? 'fw-tt-row is-section' : row.item.type === 'group' ? 'fw-tt-row is-group' : 'fw-tt-row'}
              role="treeitem"
              aria-level={row.depth}
              aria-setsize={row.setSize}
              aria-posinset={row.posInSet}
              aria-expanded={row.expandable ? row.expanded : undefined}
              tabIndex={row.item.id === focusable ? 0 : -1}
              style={{ ['--fw-tt-depth' as string]: row.depth - 1 }}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('a')) return
                setFocus(row.item.id)
                if (row.expandable) toggle(row.item.id)
              }}
              onKeyDown={(event) => onKey(event, row)}
            >
              <span className="fw-tt-chevron" aria-hidden>
                {row.expandable ? row.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
              </span>
              <RowBody item={row.item} prefix={prefix} holdReasons={holdReasons} t={t} locale={locale} />
            </div>
          ))}
        </div>
      )}
      {/* The tree's keys in ONE information icon under it (Owner rule 2026-10-29: never key hints above a list). */}
      <div className="fw-tt-foot">
        <ListKeysInfo
          keys={[
            { keys: ['↑', '↓'], does: t('lt.tree.key.walk') },
            { keys: ['→'], does: t('lt.tree.key.open') },
            { keys: ['←'], does: t('lt.tree.key.close') },
            { keys: ['Home', 'End'], does: t('lt.tree.key.ends') },
            { keys: ['Enter'], does: t('lt.tree.key.enter') },
          ]}
        />
      </div>
    </div>
  )
}

function RowBody({ item, prefix, holdReasons, t, locale }: { item: TreeItem; prefix: string; holdReasons: readonly PickerReason[]; t: Words; locale: ReturnType<typeof useLocale> }) {
  if (item.type === 'section') return <span className="fw-tt-main">{t(item.side === 'BACKWARD' ? 'lt.tree.cameFrom' : 'lt.tree.wentTo', { count: item.count })}</span>
  if (item.type === 'group')
    return (
      <span className="fw-tt-main">
        {t(`lt.tree.count.${item.kind}`, { count: item.exact + item.possible })}
        {item.possible > 0 && <span className="fw-st-sub"> · {t('lt.tree.possibleCount', { count: item.possible })}</span>}
      </span>
    )
  const node = item.node
  const record = nodeRecord(node)
  const href = record ? `${prefix}${recordAddress({ type: record.type, id: record.id }, OFFICE_PAGES)}${record.tab ? `?tab=${record.tab}` : ''}` : null
  const code = node.code ?? t('lt.tree.hidden')
  const qty = item.edge?.quantity ? `${quantity(item.edge.quantity, locale)} ${isUom(item.edge.uom) ? t(`stock:uom.${item.edge.uom}`) : (item.edge.uom ?? '')}`.trim() : null
  return (
    <>
      <span className="fw-tt-main">
        <span className="fw-tt-kind">{t(`lt.tree.kind.${node.kind}`)}</span>{' '}
        {href ? (
          <Link className="fw-st-link fw-wl-code" href={href} tabIndex={-1}>
            {code}
          </Link>
        ) : (
          <span className="fw-wl-code">{code}</span>
        )}
      </span>
      <span className="fw-tt-detail">{nodeDetail(node, t, locale)}</span>
      {qty && <span className="fw-st-num fw-tt-qty">{qty}</span>}
      {node.reach === 'POSSIBLE' && <Pill tone="warning">{t('lt.tree.possible')}</Pill>}
      {node.kind === 'CUSTOMER' && node.received && <Pill tone="info">{t('lt.tree.received')}</Pill>}
      {node.holds.map((hold) => (
        <Pill key={hold.id} tone="danger">
          {t('lt.tree.onHold', { reason: reasonLabel(holdReasons, hold.reasonCode, locale) })}
        </Pill>
      ))}
    </>
  )
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
