'use client'

import { Lock } from 'lucide-react'
import type { SizeGridIssue } from '@nexus/ui/grid/size-grid/index'
import { Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Order } from '../../api'
import { FREEZE_TONE, frozenCells, frozenGroups, NAMESPACE, type FrozenCell } from '../model'
import type { OrderDepthModel } from '../use-order-depth'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** "Cutting started — size frozen" (the stage the cell reached and what freezes), or the rule's words for a blocked one. */
export function frozenText(cell: Pick<FrozenCell, 'stage' | 'state'>, d: Translate): string {
  const stage = cell.stage ? d(`stage.${cell.stage}`) : d('stage.none')
  return d(cell.state === 'BLOCKED' ? 'frozen.blocked' : 'frozen.cell', { stage, field: d('frozenField.SIZE_QUANTITY') })
}

/**
 * The size cells already cut are locked with their reason (design order.lines.cards, SAL-218): under each style's grid, per
 * colour line, the sizes a rule froze, "Cutting started — size frozen: 48 · 50" (a priced change the customer accepts), or
 * frozen for good. Read from GET …/freeze; nothing when the company keeps no rule. Fetches nothing.
 */
export function FrozenSizes({ model, lines }: { model: OrderDepthModel | undefined; lines: Order['lines'] }) {
  if (!model?.freeze?.value) return null
  const cells = frozenCells(model.freeze.value)
  if (!lines.some((line) => cells.some((cell) => cell.lineId === line.id))) return null
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Frozen cells={cells} lines={lines} />
    </WithMessages>
  )
}

function Frozen({ cells, lines }: { cells: FrozenCell[]; lines: Order['lines'] }) {
  const d = useT(NAMESPACE)
  return (
    <ul className="fw-sod-frozen" aria-label={d('frozen.label')}>
      {lines.flatMap((line) =>
        frozenGroups(cells, line.id).map((group) => (
          <li key={`${line.id}-${group.stage}-${group.state}`} className="fw-sod-frozen-row">
            <Lock size={13} aria-hidden />
            <span className="fw-sod-frozen-colour">{line.colourway ? `${line.colourway.code} · ${line.colourway.name}` : '—'}</span>
            <Tag tone={FREEZE_TONE[group.state]}>{frozenText(group, d)}</Tag>
            <span className="fw-sod-frozen-sizes">{group.sizes.join(' · ')}</span>
            <span className="fw-sod-hint">{d(group.state === 'BLOCKED' ? 'frozen.blockedHow' : 'frozen.how')}</span>
          </li>
        )),
      )}
    </ul>
  )
}

/** The amendment editor's marks on the locked cells (the DS SizeGridEditor's warnings: the value stands, the reason shows). */
export function frozenIssues(model: OrderDepthModel | undefined, d: Translate): SizeGridIssue[] {
  if (!model?.freeze?.value) return []
  return frozenCells(model.freeze.value).map((cell) => ({ colour: cell.lineId, size: cell.size, tone: 'warning' as const, message: frozenText(cell, d) }))
}
