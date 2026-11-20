import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { abilitiesOf } from '../model'
import { canOf, LINE_BLK, LINE_RED, order, type Role } from '../_demo/fixtures'
import type { Order } from '../api'
import { closeLinesHeld, reopenHeld } from '../daily-model'
import { CONFIRMED_READ, LINES } from './overview/fixtures'
import { lineRowsOf } from './overview/progress'
import type { ProductionLine } from './overview/api'
import { makeHeldOf } from './production'
import { lineMovesOf, lineMovesShown, lineTargetOf, MAKE_STATUSES, type LineMove } from './line-moves'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { LOCALES } from '../../../../lib/i18n/locales'

/**
 * F-OL-01 (c) (Order LINES lane; 11-design-dialogs §1.1–§1.3, 18-lead-settles F6, F29): ONE line ⋯ list for the Lines table and
 * Overview › Progress by line — the items of this round in their groups, hidden by right (Read-only and Warehouse: no ⋯; Finance:
 * Discuss; the production manager: Make work orders + Discuss), held by the order's or the line's state with words. Made-up data.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const movesOf = (value: Order, role: Role | 'readOnly' | 'warehouse', lineIds: readonly string[], lines: readonly ProductionLine[] = LINES, extra: { thread?: boolean; draft?: { removed?: boolean; isNew?: boolean }; busy?: boolean } = {}) =>
  lineMovesOf(lineTargetOf(lineIds, value), value, role === 'readOnly' ? abilitiesOf(['orders.view']) : role === 'warehouse' ? abilitiesOf(['orders.view', 'shipping.manage']) : canOf(role), { lines, thread: extra.thread ?? true, draft: extra.draft, busy: extra.busy })
const brief = (moves: readonly LineMove[]) => moves.map((move) => [move.id, move.held?.key ?? null])

describe('F-OL-01 (c): lineMovesOf — this round\'s items, in their groups', () => {
  it('in production, the Owner: Options · Ready-by · Close with fewer pieces · Move (held: all in work orders) · Make (held) · Discuss · Remove', () => {
    const value = order('IN_PRODUCTION')
    const moves = movesOf(value, 'owner', [LINE_BLK])
    expect(moves.map((move) => [move.id, move.group])).toEqual([
      ['options', 'change'],
      ['readyBy', 'change'],
      ['close', 'pieces'],
      ['split', 'pieces'],
      ['make', 'pieces'],
      ['discuss', 'talk'],
      ['remove', 'danger'],
    ])
    expect(moves.find((move) => move.id === 'close')).toMatchObject({ lineIds: [LINE_BLK], held: closeLinesHeld(value, canOf('owner')) })
    expect(moves.find((move) => move.id === 'make')).toMatchObject({ lineId: LINE_BLK, held: { key: 'progress.held.allInWork' } })
    // Every piece is in work orders: nothing can move to a new order (the split's own words).
    expect(moves.find((move) => move.id === 'split')!.held).toEqual({ key: 'split.held.nothing' })
    // No conversation on the page: no Discuss.
    expect(movesOf(value, 'owner', [LINE_BLK], LINES, { thread: false }).map((move) => move.id)).not.toContain('discuss')
  })

  it('confirmed: Move to a new order runs with this line; Make is held with its due day (makeHeldOf, the band\'s words)', () => {
    const value = order('CONFIRMED')
    const moves = movesOf(value, 'owner', [LINE_RED], CONFIRMED_READ.lines!)
    expect(moves.find((move) => move.id === 'split')).toMatchObject({ lineId: LINE_RED, held: null })
    expect(moves.find((move) => move.id === 'make')!.held).toEqual(makeHeldOf(value, canOf('owner')))
  })

  it('a line closed with fewer pieces: Reopen this line… (no Close), Move held, Make held "reopen it first", Remove held', () => {
    const value = order('IN_PRODUCTION')
    const closed: Order = { ...value, lines: value.lines.map((line) => (line.id === LINE_RED ? { ...line, closedShort: { quantity: 2, at: null, byId: null, reason: null, reasonCode: null } } : line)) }
    expect(brief(movesOf(closed, 'owner', [LINE_RED]))).toEqual([
      ['options', null],
      ['readyBy', null],
      ['reopen', reopenHeld(closed, canOf('owner'))?.key ?? null],
      ['split', 'split.held.nothing'],
      ['make', 'progress.held.closedLine'],
      ['discuss', null],
      ['remove', 'lineMenu.held.removeClosed'],
    ])
  })

  it('a shipped or closed order: every act held with the state\'s words (never hidden); no Make', () => {
    const shipped = order('SHIPPED')
    expect(MAKE_STATUSES).toEqual(['CONFIRMED', 'IN_PRODUCTION'])
    const moves = movesOf(shipped, 'owner', [LINE_BLK])
    expect(moves.map((move) => move.id)).not.toContain('make')
    expect(moves.find((move) => move.id === 'readyBy')!.held).toEqual({ key: 'lineMenu.held.readyByShipped' })
    expect(moves.find((move) => move.id === 'remove')!.held).toEqual({ key: 'held.amendShipped' })
    const final = movesOf(order('CLOSED'), 'owner', [LINE_BLK])
    expect(final.find((move) => move.id === 'options')!.held).toEqual({ key: 'held.final' })
    expect(final.find((move) => move.id === 'remove')!.held).toEqual({ key: 'held.final' })
  })

  it('a draft row: a removed one offers Put back (and Discuss); a new one only Remove; a save running holds all but Discuss', () => {
    const value = order('IN_PRODUCTION')
    expect(brief(movesOf(value, 'owner', [LINE_BLK], LINES, { draft: { removed: true } }))).toEqual([
      ['putBack', null],
      ['discuss', null],
    ])
    expect(brief(movesOf(value, 'owner', ['new:x:y'], LINES, { draft: { isNew: true } }))).toEqual([['remove', null]])
    const busy = movesOf(value, 'owner', [LINE_BLK], LINES, { busy: true })
    expect(busy.find((move) => move.id === 'discuss')!.held).toBeNull()
    expect(busy.find((move) => move.id === 'options')!.held).toEqual({ key: 'held.busy' })
  })
})

describe('F-OL-01 (c): hidden by right (F6) — Read-only and Warehouse have no ⋯; Finance reads Discuss; the manager makes work orders', () => {
  const value = order('IN_PRODUCTION')
  const short = LINES.map((line) => ({ ...line, inWorkOrders: 0 }))

  it('Sales: every change and pieces act; Make held "needs the production manager\'s right" (F-OO-122 kept)', () => {
    const moves = movesOf(value, 'sales', [LINE_RED], short)
    expect(moves.map((move) => move.id)).toEqual(['options', 'readyBy', 'close', 'split', 'make', 'discuss', 'remove'])
    expect(moves.find((move) => move.id === 'make')!.held).toEqual({ key: 'held.noWorkOrders' })
  })

  it('the production manager: Make work orders and Discuss only; Finance: Discuss only', () => {
    expect(brief(movesOf(value, 'manager', [LINE_RED], short))).toEqual([
      ['make', null],
      ['discuss', null],
    ])
    expect(brief(movesOf(value, 'finance', [LINE_RED], short))).toEqual([['discuss', null]])
  })

  it('Read-only and Warehouse: nothing at all (no ⋯)', () => {
    expect(movesOf(value, 'readOnly', [LINE_RED])).toEqual([])
    expect(movesOf(value, 'warehouse', [LINE_RED])).toEqual([])
    expect(lineMovesShown(abilitiesOf(['orders.view']))).toBe(false)
    expect(lineMovesShown(abilitiesOf(['orders.view', 'shipping.manage']))).toBe(false)
    for (const role of ['owner', 'sales', 'manager', 'finance'] as const) expect(lineMovesShown(canOf(role)), role).toBe(true)
  })

  it('a made-to-measure unit: no Move, no Remove (it keeps its size and price)', () => {
    const mtm: Order = { ...value, lines: value.lines.map((line) => (line.id === LINE_RED ? { ...line, kind: 'MADE_TO_MEASURE' } : line)) }
    const moves = movesOf(mtm, 'owner', [LINE_RED])
    expect(moves.map((move) => move.id)).not.toContain('split')
    expect(moves.map((move) => move.id)).not.toContain('remove')
  })
})

describe('F-OL-01 (c): parity — Overview › Progress by line and the Lines table call the same function with the same target', () => {
  it('the same rows give the same list (Overview\'s row = the line ids it stands for)', () => {
    const value = order('IN_PRODUCTION')
    for (const row of lineRowsOf(LINES, value)) {
      const overview = lineMovesOf(lineTargetOf(row.lineIds, value), value, canOf('sales'), { lines: LINES, thread: true })
      const table = lineMovesOf(lineTargetOf([row.id], value), value, canOf('sales'), { lines: LINES, thread: true })
      expect(overview).toEqual(table)
    }
  })

  it('the sources: both doors use the ONE router (view/LineMenu.tsx); the old list left overview/progress.ts', () => {
    const card = read('./view/overview/ProgressCard.tsx')
    expect(card).toContain("import { LineMenuButton, useLineMenu } from '../LineMenu'")
    expect(card).toContain('menu.itemsOf(menu.movesOf(row.lineIds), { seq: row.seq, name }, first)')
    const table = read('./view/LinesTab.tsx')
    expect(table).toContain("from './LineMenu'")
    const menu = read('./view/LineMenu.tsx')
    expect(menu).toContain('lineMovesOf(lineTargetOf(lineIds, order), order, model.can,')
    for (const door of ["actions?.onDialog?.({ kind: 'promise', lineIds: [move.lineId] })", "actions?.onDialog?.({ kind: 'closeLines', lineIds: move.lineIds })", "actions?.onDialog?.({ kind: 'reopenLines', lineIds: move.lineIds })", "actions?.onDialog?.({ kind: 'split', lineId: move.lineId })", 'actions?.makeWorkOrders?.onOpenLine?.(move.lineId)', 'actions?.linesTab?.onRemove?.(move.lineId)', 'actions?.linesTab?.onOptions?.(move.lineId)'])
      expect(menu, door).toContain(door)
    expect(read('./overview/progress.ts')).not.toContain('export function lineMovesOf')
  })

  it('every item, group and held word exists in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['options', 'readyBy', 'close', 'reopen', 'split', 'make', 'discuss', 'remove', 'putBack', 'group.change', 'group.pieces', 'held.readyByShipped', 'held.splitClosed', 'held.splitInWork', 'held.removeClosed']) expect(t(`lineMenu.${key}`), `${locale}: lineMenu.${key}`).not.toBe(`lineMenu.${key}`)
    }
    const it = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(it('lineMenu.close')).toBe('Chiudi con meno capi…')
  })
})
