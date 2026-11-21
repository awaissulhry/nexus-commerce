'use client'

import { MoreHorizontal } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import type { Order } from '../../api'
import { dayInstant, type Phrase } from '../../model'
import { discussAboutOf } from '../dock/discuss'
import { lineMovesOf, lineTargetOf, type LineMove, type LineMoveGroup, type LineMoveId, type LineMovesInput } from '../line-moves'
import { readOf } from '../overview/model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'

/**
 * F-OL-01 (c) / F-OL-04 (Order LINES lane; 11-design-dialogs §1.1–§1.3) — the ONE line ⋯ of both doors: the Lines table's row and
 * Overview › Progress by line call `lineMovesOf` (line-moves.ts) with the same target, and run its moves through this one router into
 * TODAY's windows — Options (OrderLineOptions), the promise dialog on this line, close / reopen with this line ticked, the split with
 * this line's pieces, Make work orders (as Overview does), the thread at the line, Remove (into the Lines draft) and Put back. The DS
 * Menu with its group headings; a held move is a held item with its words (keyboard reachable, never run). Fetches nothing.
 */

const LABEL: Readonly<Record<LineMoveId, string>> = Object.freeze({
  options: 'lineMenu.options',
  readyBy: 'lineMenu.readyBy',
  close: 'lineMenu.close',
  reopen: 'lineMenu.reopen',
  split: 'lineMenu.split',
  make: 'lineMenu.make',
  discuss: 'lineMenu.discuss',
  remove: 'lineMenu.remove',
  putBack: 'lineMenu.putBack',
})

export interface LineMenu {
  /** The moves of a row (its line ids; the Lines table adds its draft state). */
  readonly movesOf: (lineIds: readonly string[], draft?: LineMovesInput['draft']) => LineMove[]
  /** The menu's items; `first` runs before the move (a window closes first: one dialog at a time). */
  readonly itemsOf: (moves: readonly LineMove[], row: { readonly seq: number; readonly name: string }, first?: () => void) => MenuItemDef[]
}

export function useLineMenu(order: Order, model: OrderRecordModel, actions?: OrderRecordActions): LineMenu {
  const t = useT('orders')
  const locale = useLocale()
  const frame = useRecordFrame()
  const lines = readOf(model.production)?.lines ?? []
  const heldWords = (held: Phrase) => t(held.key, held.params?.date ? { ...held.params, date: formatDate(dayInstant(String(held.params.date)), { locale }) } : held.params)
  // F-SA-266: the line's Discuss, as DiscussDoor builds it (one line: its reference; a made-to-measure group: words, an office note).
  const discuss = (move: LineMove, row: { readonly seq: number; readonly name: string }) => {
    const yourOrder = order.customerSeq ? t('discuss.yourOrderSeq', { seq: order.customerSeq }) : t('discuss.yourOrder')
    const about = discussAboutOf(order, { yourOrder, firstLine: (words) => t('discuss.firstLine', { thing: words }) }, { part: t('discuss.line', { seq: row.seq, name: row.name }), target: move.lineIds.length === 1 ? { kind: 'SalesOrderLine', id: move.lineIds[0]! } : null })
    frame?.discuss?.({ record: { type: 'SalesOrder', id: order.id }, about })
  }
  const run = (move: LineMove, row: { readonly seq: number; readonly name: string }) => {
    switch (move.id) {
      case 'options':
        return actions?.linesTab?.onOptions?.(move.lineId)
      case 'readyBy':
        return actions?.onDialog?.({ kind: 'promise', lineIds: [move.lineId] })
      case 'close':
        return actions?.onDialog?.({ kind: 'closeLines', lineIds: move.lineIds })
      case 'reopen':
        return actions?.onDialog?.({ kind: 'reopenLines', lineIds: move.lineIds })
      case 'split':
        return actions?.onDialog?.({ kind: 'split', lineId: move.lineId })
      case 'make':
        return actions?.makeWorkOrders?.onOpenLine?.(move.lineId)
      case 'discuss':
        return discuss(move, row)
      case 'remove':
        return actions?.linesTab?.onRemove?.(move.lineId)
      case 'putBack':
        return actions?.linesTab?.onPutBack?.(move.lineId)
    }
  }
  return {
    movesOf: (lineIds, draft) => lineMovesOf(lineTargetOf(lineIds, order), order, model.can, { lines, thread: !!frame?.discuss, draft, busy: model.busy || !!model.linesTab?.saving }),
    itemsOf: (moves, row, first) => {
      const items: MenuItemDef[] = []
      let group: LineMoveGroup | null = null
      for (const move of moves) {
        if (move.group !== group) {
          if (move.group === 'change' || move.group === 'pieces') items.push({ id: `group-${move.group}`, heading: true, label: t(`lineMenu.group.${move.group}`) })
          else if (items.length > 0) items.push({ id: `rule-${move.group}`, separator: true })
          group = move.group
        }
        items.push({
          id: move.id,
          label: t(LABEL[move.id]),
          ...(move.id === 'remove' ? { tone: 'danger' as const } : {}),
          disabled: !!move.held,
          description: move.held ? heldWords(move.held) : undefined,
          onSelect: move.held
            ? undefined
            : () => {
                first?.()
                run(move, row)
              },
        })
      }
      return items
    },
  }
}

/** The row's ⋯ (the DS Menu; its name says the line: "Actions for line 2 · SEED-JKT-02 Red"). A square DS icon button (OL fix 3). */
export function LineMenuButton({ label, items }: { label: string; items: MenuItemDef[] }) {
  return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': label, className: 'nds-btn icon' }} items={items} />
}
