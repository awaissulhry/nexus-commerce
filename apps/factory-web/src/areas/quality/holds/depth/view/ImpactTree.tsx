'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Checkbox, Pill } from '@nexus/ui/primitives'
import { TraceTree as DsTraceTree, type TraceNode as DsTraceNode } from '@nexus/ui/patterns/trace-tree/index'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { quantity } from '../../../../_shared/stock/model'
import type { Impact, ImpactNodeView } from '../api'
import { useUomWord } from '../../view/parts'
import { nodeRecord, onlyAffected, registerHref, type TreeItem } from '../model'

type Translate = (key: string, params?: Record<string, string | number>) => string

const STATES: Readonly<Record<string, readonly string[]>> = {
  LOT: ['QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED'],
  HIDE: ['FULL', 'PARTLY_CUT', 'REMNANT', 'CONSUMED', 'SCRAPPED', 'RETURNED'],
  BUNDLE: ['ACTIVE', 'VOID'],
  SERIAL: ['MADE', 'RELEASED', 'SHIPPED', 'VOID'],
  SHIPMENT: ['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'],
}
const GAP_TONE = { BROKEN: 'danger', COARSE: 'warning', IN_WORK: 'info' } as const
const GAP_CODES = ['OPENING_STOCK', 'NO_SUPPLIER', 'NO_ISSUE', 'BUNDLE_WITHOUT_CUTS', 'SERIAL_WITHOUT_BUNDLE', 'LINE_WITHOUT_SERIALS', 'BATCH_TRACKED', 'ISSUED_BY_QUANTITY', 'SUBCONTRACT_RETURN', 'SERIALS_COLLAPSED', 'ISSUED_NOT_CUT', 'CUT_NOT_BUNDLED']
const isUom = (uom: string | null | undefined): uom is (typeof UOMS)[number] => !!uom && (UOMS as readonly string[]).includes(uom)

/** A record's state in our words, only when the catalogue knows it (a new code is left out, never drawn as a code). */
function stateWords(node: ImpactNodeView, t: Translate): string | null {
  if (!node.state) return null
  if (node.kind === 'WORK_ORDER') return (WORK_ORDER_STATUSES as readonly string[]).includes(node.state) ? t(`woStatus.${node.state}`) : null
  return STATES[node.kind]?.includes(node.state) ? t(`node.state.${node.kind}.${node.state}`) : null
}

/** One line of facts about a node in our words: its item, size, garments, on hand, DDTs, the party. */
function detailOf(node: ImpactNodeView, t: Translate, locale: ReturnType<typeof useLocale>, uomWord: (uom: string) => string): string {
  const parts: (string | null)[] = []
  if (node.lot) parts.push(`${node.lot.itemCode} · ${node.lot.itemName}`, node.lot.colourCode, isUom(node.lot.uom) ? t('node.onHand', { quantity: `${quantity(node.lot.onHand, locale)} ${uomWord(node.lot.uom)}` }) : null)
  if (node.workOrder) parts.push(node.workOrder.styleCode, node.workOrder.batchNumber ? t('node.batch', { batch: node.workOrder.batchNumber }) : null)
  if (node.cell) parts.push(t('node.size', { colourway: node.cell.colourwayCode, size: node.cell.size }), t('node.cellGarments', { count: node.cell.quantity, shipped: node.cell.shipped }))
  if (node.bundle) parts.push(t('quantity.garments', { count: node.bundle.quantity }), node.bundle.part)
  if (node.shipment?.ddtNumbers.length) parts.push(t('node.ddt', { number: node.shipment.ddtNumbers.join(', ') }))
  if (node.kind === 'CUSTOMER' || node.kind === 'SUPPLIER') parts.push(node.partyName ?? t('node.partyHidden'))
  parts.push(stateWords(node, t))
  return parts.filter(Boolean).join(' · ')
}

export interface ImpactTreeProps {
  readonly impact: Pick<Impact, 'levels' | 'gaps' | 'restricted' | 'nodes'>
  readonly items: readonly TreeItem[]
  readonly label: string
  readonly prefix: string
  readonly reasons: ReadonlyMap<string, { labelIt: string; labelEn: string }>
  /** Tickable branches (a hold by genealogy); left out: read only (Affected). */
  readonly selection?: { readonly selected: readonly string[]; readonly onChange: (ids: string[]) => void } | null
  /** Why a node cannot be ticked, in our words (null: it can). */
  readonly heldOf?: (item: TreeItem) => string | null
  readonly affectedOnly: boolean
  readonly onAffectedOnly: (on: boolean) => void
  readonly empty: string
  /** Nodes open at first above this depth (the genealogy opens deep: what has left must be seen before the click). */
  readonly openDepth?: number
}

/**
 * The impact tree of holds in depth (design qh-genealogy "TraceTree … with counts per state", Hold › Affected "What it
 * touches"): the DS TraceTree (B-W2b-09) over the forest of the forward traces — the levels with their counts first
 * (exact, and "may hold it" for what the records know only per work order or size), the gaps of the chain in words, what
 * the reader may not see, "Show only affected customers", then the tree the arrow keys walk (Space ticks a branch when the
 * tree takes a selection; a node that cannot be ticked says why; what has left offers the PPE register). Read only data.
 */
export function ImpactTree({ impact, items, label, prefix, reasons, selection, heldOf, affectedOnly, onAffectedOnly, empty, openDepth = 3 }: ImpactTreeProps) {
  const t = useT('holds')
  const locale = useLocale()
  const ds = useDsWords()
  const uomWord = useUomWord()
  const shown = useMemo(() => (affectedOnly ? onlyAffected(items) : [...items]), [items, affectedOnly])
  const roots = useMemo(() => {
    const draw = (item: TreeItem): DsTraceNode => {
      const held = heldOf?.(item) ?? null
      if (item.type === 'group')
        return {
          id: item.id,
          kind: t(`node.kind.${item.kind}`),
          label: t(`node.count.${item.kind}`, { count: item.exact + item.possible }),
          ...(item.possible > 0 ? { meta: <span className="fw-q-hint">{ds.traceTree.possibleCount(item.possible)}</span> } : {}),
          ...(selection ? { held } : {}),
          children: item.children.map(draw),
        }
      const node = item.node
      const record = nodeRecord(node)
      const qty = item.quantity ? `${quantity(item.quantity.amount, locale)} ${isUom(item.quantity.uom) ? uomWord(item.quantity.uom) : (item.quantity.uom ?? '')}`.trim() : null
      const detail = detailOf(node, t, locale, uomWord)
      const reason = (code: string) => {
        const found = reasons.get(code)
        return found ? (locale === 'it' ? found.labelIt || found.labelEn : found.labelEn || found.labelIt) : code
      }
      const meta: ReactNode = (
        <>
          {detail && <span className="fw-q-hint">{detail}</span>}
          {qty && <span className="fw-q-num">{qty}</span>}
          {node.kind === 'CUSTOMER' && node.received && <Pill tone="info">{t('node.received')}</Pill>}
          {node.hold === 'LEFT' && <Pill tone="neutral">{t('node.left')}</Pill>}
        </>
      )
      const notes: ReactNode[] = node.holds.map((hold) => (
        <Pill key={hold.id} tone="danger">
          {t('node.onHold', { reason: reason(hold.reasonCode) })}
        </Pill>
      ))
      if (selection && node.hold === 'LEFT')
        notes.push(
          <Link key="register" className="fw-q-link" href={registerHref(prefix)}>
            {t('genealogy.register')}
          </Link>,
        )
      if (selection && held) notes.push(<span key="held" className="fw-q-hint">{held}</span>)
      return {
        id: item.id,
        kind: t(`node.kind.${node.kind}`),
        label: node.code ?? t('node.hidden'),
        href: record ? `${prefix}${recordAddress({ type: record.type, id: record.id }, OFFICE_PAGES)}${record.tab ? `?tab=${record.tab}` : ''}` : null,
        possible: node.reach === 'POSSIBLE',
        meta,
        ...(notes.length > 0 ? { note: <span className="fw-hd-tree-notes">{notes}</span> } : {}),
        ...(selection ? { held } : {}),
        children: item.children.map(draw),
      }
    }
    return shown.map(draw)
  }, [shown, heldOf, selection, t, locale, prefix, reasons, ds.traceTree, uomWord])
  const received = impact.nodes.filter((node) => node.kind === 'CUSTOMER' && node.received).length
  const gapsBy = (severity: keyof typeof GAP_TONE) => impact.gaps.filter((gap) => gap.severity === severity && GAP_CODES.includes(gap.code))
  const codeAt = (key: string) => impact.nodes.find((node) => node.key === key)?.code ?? '—'
  return (
    <DsTraceTree
      label={label}
      roots={roots}
      levels={impact.levels.map((level) => ({ id: level.kind, label: t(`node.count.${level.kind}`, { count: level.exact + level.possible }), possible: level.possible }))}
      defaultOpenDepth={openDepth}
      before={
        <>
          {(['BROKEN', 'COARSE', 'IN_WORK'] as const).map((severity) =>
            gapsBy(severity).length > 0 ? (
              <Banner key={severity} tone={GAP_TONE[severity]} title={t(`gap.title.${severity}`)}>
                <ul className="fw-q-lines">
                  {gapsBy(severity).map((gap) => (
                    <li key={`${gap.code}:${gap.at}`}>{t(`gap.${gap.code}`, { at: codeAt(gap.at), count: gap.count })}</li>
                  ))}
                </ul>
              </Banner>
            ) : null,
          )}
          {impact.restricted.map((entry) => (
            <p key={entry.permission} className="fw-q-hint">
              {t(entry.permission === 'parties.view' ? 'node.restrictedParties' : 'node.restrictedSites', { count: entry.nodes })}
            </p>
          ))}
          <div className="fw-hd-tree-tools">
            <Checkbox checked={affectedOnly} onChange={(event) => onAffectedOnly(event.target.checked)} label={t('node.affectedOnly', { count: received })} />
          </div>
        </>
      }
      empty={<EmptyState title={affectedOnly ? t('node.noAffected') : empty} />}
      {...(selection ? { selection: { selected: selection.selected, onChange: selection.onChange } } : {})}
      labels={ds.traceTree}
    />
  )
}
