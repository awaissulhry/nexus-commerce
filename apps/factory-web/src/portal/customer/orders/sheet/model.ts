import type { OrderLife } from '@nexus/factory-domain/sales/order-life'
import type { OwnColumn, OwnValue } from '../../../../lib/order-lines/schema'
import type { OrderRow, SheetWaitKind } from '../api'

/**
 * owb-po7.2 + po7.3 (design § 5b, § 5h, § 5zj A; prototype sheet.js `newsChips`, `sheetBulk`, portal.js `draftsBar`, `sentBanner`) —
 * the customer's orders sheet, pure: the drafts (a bin each, "Delete the drafts", "Send…"), what the bulk bar may do with the rows
 * picked, the line after Send with "Take it back" while the factory has not confirmed, withdrawn rows behind a chip, the "Waits · news"
 * chips and where each one leads, the picture's door and the Details of a row. No price anywhere. No React, no API.
 */

/** A row's ONE page: its order, or its request (a draft or a sent order, until the factory confirms). */
export type RowPage = { readonly kind: 'order' | 'request'; readonly id: string }

/** The row's page: the server's `page`, else from its kind (an older answer: an ORDER opens its order; a request has none). */
export function pageOf(row: Pick<OrderRow, 'kind' | 'id' | 'page'>): RowPage | null {
  if (row.page) return row.page
  return row.kind === 'ORDER' ? { kind: 'order', id: row.id } : null
}

/** The drafts of the read (the drafts bar, Send…, Delete the drafts), in the read's order. */
export const draftsOf = (rows: readonly OrderRow[]): OrderRow[] => rows.filter((row) => row.kind === 'DRAFT')

/** The rows the sheet lists: no draft (the drafts bar holds them), no withdrawn row unless its chip is on. */
export function listedRows(rows: readonly OrderRow[], showWithdrawn: boolean): OrderRow[] {
  return rows.filter((row) => row.kind !== 'DRAFT' && (showWithdrawn || row.life !== 'WITHDRAWN'))
}

/** How many withdrawn rows the chip "Withdrawn" shows again. */
export const withdrawnCount = (rows: readonly OrderRow[]): number => rows.filter((row) => row.life === 'WITHDRAWN').length

/** What the bulk bar may do with the rows picked: Send (drafts the reader may send) · Delete the drafts (drafts the reader may delete). */
export function bulkOf(rows: readonly OrderRow[], picked: readonly string[]): { readonly send: readonly OrderRow[]; readonly remove: readonly OrderRow[] } {
  const chosen = rows.filter((row) => picked.includes(row.id) && row.kind === 'DRAFT')
  return { send: chosen.filter((row) => row.may?.send ?? true), remove: chosen.filter((row) => row.may?.delete ?? true) }
}

/** A row's name in the sheet's words: its subject, else its PO, else null (the host says "No subject"). */
export const rowTitleOf = (row: Pick<OrderRow, 'subject' | 'customerRef'>): string | null => row.subject?.trim() || row.customerRef?.trim() || null

/**
 * The line after Send: the orders just sent and which of them may still be taken back (the factory has not confirmed: the row is
 * still a REQUEST and the server says `may.takeBack`). Gone when none of them is in the read any more as a request.
 */
export function sentLineOf(rows: readonly OrderRow[], sentIds: readonly string[]): { readonly ids: readonly string[]; readonly titles: readonly (string | null)[]; readonly takeBack: readonly string[] } | null {
  const sent = rows.filter((row) => sentIds.includes(row.id))
  if (sentIds.length === 0) return null
  return {
    ids: sentIds,
    titles: sentIds.map((id) => {
      const row = sent.find((entry) => entry.id === id)
      return row ? rowTitleOf(row) : null
    }),
    takeBack: sent.filter((row) => row.kind === 'REQUEST' && (row.may?.takeBack ?? false)).map((row) => row.id),
  }
}

/** Where a "Waits · news" chip leads: the order's chat · the design window · the order (the label, an ask, a detail, late). */
export type WaitDoor = 'chat' | 'design' | 'page'

export interface WaitChip {
  readonly kind: SheetWaitKind
  /** A word key of the orders catalogue (`waits.<KIND>`), with its count. */
  readonly key: string
  readonly count: number | null
  readonly tone: 'info' | 'warning' | 'danger' | 'neutral'
  readonly door: WaitDoor
}

const WAIT_FACE: Readonly<Record<SheetWaitKind, { tone: WaitChip['tone']; door: WaitDoor }>> = {
  NEW_MESSAGES: { tone: 'info', door: 'chat' },
  DESIGN_APPROVAL: { tone: 'warning', door: 'design' },
  SEND_LABEL: { tone: 'warning', door: 'page' },
  ASKED: { tone: 'neutral', door: 'page' },
  OPEN_DETAILS: { tone: 'warning', door: 'page' },
  LATE: { tone: 'danger', door: 'page' },
}

/** The chips of a row's `waits` in the design's order ("1 new" · "Design: your yes?" · "Send the shipping label" · "n asked" · "n open" · "Late"). */
export function waitChipsOf(waits: OrderRow['waits']): WaitChip[] {
  const order: readonly SheetWaitKind[] = ['NEW_MESSAGES', 'DESIGN_APPROVAL', 'SEND_LABEL', 'ASKED', 'OPEN_DETAILS', 'LATE']
  return order.flatMap((kind) => {
    const wait = (waits ?? []).find((entry) => entry.kind === kind)
    if (!wait || (wait.count !== null && wait.count <= 0)) return []
    return [{ kind, key: `waits.${kind}`, count: wait.count, ...WAIT_FACE[kind] }]
  })
}

/** The picture's door of a row: its record (order or request) when the reader may change it (never on a withdrawn row); else null. */
export function pictureDoorOf(row: Pick<OrderRow, 'kind' | 'id' | 'page' | 'may' | 'life'>): RowPage | null {
  if (!row.may?.picture || row.life === 'WITHDRAWN') return null
  return pageOf(row)
}

/** The life word a row's chip draws (never today's `chip`): the server's life, else from its kind (an older answer). */
export function lifeOf(row: Pick<OrderRow, 'life' | 'kind'>): OrderLife | null {
  if (row.life) return row.life
  return row.kind === 'DRAFT' ? 'DRAFT' : row.kind === 'REQUEST' ? 'SENT' : null
}

/** A row's Details: the own columns it uses (in the page's order) and every line's values (the chips read them). */
export function detailsOf(row: Pick<OrderRow, 'lines' | 'ownColumnIds'>, columns: readonly OwnColumn[]): { readonly columns: readonly OwnColumn[]; readonly lines: readonly Readonly<Record<string, OwnValue['value']>>[] } {
  const ids = row.ownColumnIds ?? []
  return {
    columns: columns.filter((column) => ids.includes(column.id)),
    lines: (row.lines ?? []).map((line) => Object.fromEntries(Object.entries(line.ownValues).map(([columnId, value]) => [columnId, value.value]))),
  }
}
