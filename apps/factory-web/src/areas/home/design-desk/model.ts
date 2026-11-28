import type { DeskRead } from './api'

/**
 * owb-of7 step 1 (design plan § 5f, § 5zl "a counter tile is a button: it goes to its part of the page"; prototype office.js
 * designDesk) — the Design desk's rules, pure: its four sections in order, each tile's count, where a row opens, the scan codes in
 * words. No price anywhere (the read has none).
 */
export const DESK_SECTIONS = ['asked', 'approvals', 'codes', 'floor'] as const
export type DeskSection = (typeof DESK_SECTIONS)[number]

/** The tiles: one per section, its count (Scan codes: the orders not yet all placed; null before S3's placements). */
export function deskTilesOf(read: DeskRead): { readonly key: DeskSection; readonly count: number | null }[] {
  return [
    { key: 'asked', count: read.asked.length },
    { key: 'approvals', count: read.approvals.length },
    { key: 'codes', count: read.codes ? read.codes.filter((row) => row.placed < row.pages).length : null },
    { key: 'floor', count: read.floor.length },
  ]
}

/** The section's address on the page (a tile scrolls there). */
export const deskAnchorOf = (section: DeskSection): string => `desk-${section}`

/** Where a row opens: a confirmed order its page, a Draft or Sent order the office's draft page (L3). */
export const deskHrefOf = (prefix: string, row: { readonly kind: 'ORDER' | 'REQUEST'; readonly id: string }): string =>
  row.kind === 'ORDER' ? `${prefix}/sales/orders/${encodeURIComponent(row.id)}` : `${prefix}/sales/orders/new?draft=${encodeURIComponent(row.id)}`

/** "2 of 3 placed" and its tone: all placed → success; else warning. */
export const placedOf = (row: { readonly placed: number; readonly pages: number }): { readonly done: boolean; readonly placed: number; readonly pages: number } => ({ done: row.pages > 0 && row.placed >= row.pages, placed: Math.min(row.placed, row.pages), pages: row.pages })

/** Who may place a code here: production.print.start, or the designer (on his orders: the read lists only those). */
export const mayPlaceCode = (permissions: readonly string[]): boolean => permissions.includes('production.print.start') || permissions.includes('orders.view.own')

/** Who answers the floor's asks: production.calls.answer (the designer has it). */
export const mayAnswerFloor = (permissions: readonly string[]): boolean => permissions.includes('production.calls.answer')
