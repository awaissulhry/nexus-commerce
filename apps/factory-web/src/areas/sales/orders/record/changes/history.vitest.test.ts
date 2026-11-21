import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { changeRowsOf, chipCountsOf, historyChipOf, HISTORY_OPEN, restoreOf, rowsForChip } from './history'

// F-OC-301 … 303 (order CHANGES tab, W3; 10-design §5; 13-backend B-OC-009 … 014; L12): What changed — one row per change, grouped on
// certain links only, chips as filters, the told line by the speaker's own ids, Restore as before… as the server offers it.

const request = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'CHANGE', status: 'ACCEPTED', askedAt: '2026-11-10T09:00:00Z', answeredAt: '2026-11-11T09:00:00Z', withdrawnAt: null, cells: [], wholeOrder: false, requestedDate: null, note: null, answer: null, askedBy: null, answeredBy: null, ...over }) as never
const change = (id: string, revision: number, at: string, over: Record<string, unknown> = {}) =>
  ({ id, revision, reason: 'r', reasonCode: null, createdAt: at, createdBy: 'Bea Esempio', priced: false, diff: { lines: [{ change: 'CHANGED', piecesBefore: 8, piecesAfter: 9 }] }, deposit: null, yes: { state: 'NOT_ASKED', taskId: null, reason: null }, customer: { decision: 'NOT_NEEDED', requestId: null, answeredAt: null }, putBack: { may: true, offered: false, why: null }, changeRequestId: null, restores: null, restoredBy: null, ...over }) as never
const woc = (id: string, over: Record<string, unknown> = {}) => ({ id, status: 'APPLIED', requestId: null, amendmentId: null, proposedAt: '2026-11-12T09:00:00Z', decidedAt: '2026-11-12T10:00:00Z', workOrder: { id: 'wo1', number: 'SEED-WO-0412', status: 'RELEASED' }, madeWorkOrder: null, decisionNote: null, words: { title: { en: 'x', it: 'x' }, status: { en: 'Applied', it: 'Applicata' }, cells: '54: 1 → 0' }, ...over }) as never
const told = (batchId: string, speaker: Record<string, unknown> | null, at = '2026-11-15T09:00:00Z') => ({ batchId, messageId: `m-${batchId}`, occurredAt: at, at, eventType: 'x', requestId: null, people: 2, floor: { at: null, workOrders: [], leftOut: 0 }, workshop: { at: null, told: 0, waiting: 0 }, speaker }) as never
const input = (over: Record<string, unknown> = {}) => ({ requests: [], changes: [], amendments: null, confirmation: null, workOrderChanges: [], told: [], ...over }) as never

describe('F-OC-302: one row per change — grouped on certain links only, never by time', () => {
  it('a request and the revision it became are ONE row (changeRequestId); its work-order changes ride with it (requestId / amendmentId)', () => {
    const rows = changeRowsOf(input({ requests: [request('r1')], changes: [change('a2', 2, '2026-11-11T09:00:05Z', { changeRequestId: 'r1' })], workOrderChanges: [woc('c1', { amendmentId: 'a2' })] }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'request', id: 'r1', revision: { id: 'a2', revision: 2 }, workOrderChanges: [{ id: 'c1' }] })
    // L12: a request done as a revision is in Revisions too — the count is never 0 while a row says "Done as revision 2".
    expect(chipCountsOf(rows)).toMatchObject({ all: 1, requests: 1, revisions: 1, workOrders: 1, confirmations: 0 })
  })

  it('no link: two rows, even a second apart; a decided work-order change no row carries is its own row; a waiting one is Waiting\'s', () => {
    const rows = changeRowsOf(input({ requests: [request('r1')], changes: [change('a2', 2, '2026-11-11T09:00:01Z')], workOrderChanges: [woc('c1'), woc('c2', { status: 'PROPOSED', decidedAt: null })] }))
    expect(rows.map((row) => row.kind).sort()).toEqual(['request', 'revision', 'workOrderChange'])
    expect(rows.find((row) => row.kind === 'workOrderChange')).toMatchObject({ id: 'woc-c1', chips: ['workOrders'] })
  })

  it('every confirmation made and every send (B-OC-014); before the server lists the sends, the last one', () => {
    const versions = [{ version: 2, createdAt: '2026-11-04T09:00:00Z', createdBy: 'Alex Demo' }, { version: 1, createdAt: '2026-10-30T09:00:00Z', createdBy: null }]
    const both = changeRowsOf(input({ confirmation: { versions, sentAt: '2026-11-04T10:00:00Z', sentVersion: 2, sends: [{ version: 2, at: '2026-11-04T10:00:00Z', to: ['lia.cliente@example.com'], by: 'Alex Demo' }, { version: 1, at: '2026-10-30T10:00:00Z', to: ['lia.cliente@example.com'], by: null }] } }))
    expect(both.filter((row) => row.kind === 'confirmationSent').map((row) => row.kind === 'confirmationSent' && row.version)).toEqual([2, 1])
    const last = changeRowsOf(input({ confirmation: { versions, sentAt: '2026-11-04T10:00:00Z', sentVersion: 2 } }))
    expect(last.filter((row) => row.kind === 'confirmationSent')).toHaveLength(1)
    expect(rowsForChip(last, 'confirmations')).toHaveLength(3)
  })

  it('B-OC-009: the told read\'s speaker names the new kinds — cancelled, lines closed / reopened, a pause placed / lifted, a style change released', () => {
    const rows = changeRowsOf(input({ told: [told('b1', { kind: 'CANCELLED' }), told('b2', { kind: 'LINES', change: 'CLOSED' }), told('b3', { kind: 'LINES', change: 'REOPENED' }), told('b4', { kind: 'HOLD', hold: { placed: true, workOrder: null, leftOut: 1 } }), told('b5', { kind: 'HOLD', hold: { placed: false, workOrder: { id: 'wo1', number: 'SEED-WO-0411' }, leftOut: 0 } }), told('b6', { kind: 'ECO', changeOrder: { number: 'SEED-ECO-0004' } }), told('b7', { kind: 'PROMISE', from: '2026-12-07', to: '2026-12-11' }), told('b8', null)] }))
    expect(rows.map((row) => row.kind).sort()).toEqual(['cancelled', 'linesClosed', 'linesReopened', 'pauseLifted', 'paused', 'styleReleased'])
    // A pause on a work order this reader does not reach names none (the view says "a work order").
    const paused = rows.find((row) => row.kind === 'paused')
    expect(paused?.kind === 'paused' && paused.told.speaker?.hold?.workOrder).toBeNull()
    expect(rowsForChip(rows, 'workOrders').map((row) => row.kind).sort()).toEqual(['pauseLifted', 'paused'])
  })
})

describe('F-OC-302: the Told line by the speaker\'s own ids (an older line without one: the old match)', () => {
  it('REQUEST → its request, AMENDED → its revision, WORK_ORDER_CHANGE → its change; never another row\'s', () => {
    const rows = changeRowsOf(
      input({
        requests: [request('r1')],
        changes: [change('a3', 3, '2026-11-14T09:00:00Z')],
        workOrderChanges: [woc('c9')],
        told: [told('t1', { kind: 'REQUEST', requestId: 'r1' }), told('t2', { kind: 'AMENDED', amendmentId: 'a3' }), told('t3', { kind: 'WORK_ORDER_CHANGE', workOrderChangeId: 'c9' })],
      }),
    )
    const byKind = Object.fromEntries(rows.map((row) => [row.kind, 'told' in row ? row.told?.batchId : null]))
    expect(byKind).toEqual({ request: 't1', revision: 't2', workOrderChange: 't3' })
  })
})

describe('F-OC-301 / 303: chips in the address, the fold, Restore as before…', () => {
  it('?history= picks the chip; anything else is All; the newest five open', () => {
    expect(historyChipOf('revisions')).toBe('revisions')
    expect(historyChipOf('amendments')).toBe('all')
    expect(historyChipOf(null)).toBe('all')
    expect(HISTORY_OPEN).toBe(5)
  })

  it('B-OC-013 (D5): offered by the server — after a refused or expired yes too; held with the server\'s words in the reader\'s language', () => {
    expect(restoreOf(change('a2', 2, 'x', { customer: { decision: 'EXPIRED', requestId: null, answeredAt: null }, putBack: { may: true, offered: true, why: null } }) as never, 'en')).toEqual({ may: true, why: null })
    expect(restoreOf(change('a2', 2, 'x', { putBack: { may: false, offered: true, why: { en: 'Goods have left: the lines no longer change.', it: 'Della merce è partita: le righe non cambiano più.' } } }) as never, 'it')).toEqual({ may: false, why: 'Della merce è partita: le righe non cambiano più.' })
    expect(restoreOf(change('a2', 2, 'x') as never, 'en')).toBeNull()
    expect(restoreOf(null, 'en')).toBeNull()
  })

  it('the view: chips with counts kept in the address, Restore only for orders.manage, the ONE row ⋯ on every row, Before → after on a revision', () => {
    const view = readFileSync(new URL('./view/HistorySection.tsx', import.meta.url), 'utf8')
    expect(view).toContain("router.replace(`${pathname}${text ? `?${text}` : ''}#history`, { scroll: false })")
    expect(view).toContain('const restore = !ask && model.can.manage ? restoreOf(revised, locale) : null')
    expect(view).toContain("actions?.onDialog?.({ kind: 'compare', amendmentId: revision!.id })")
    expect(view).toContain('<RowMenu order={order} prefix={model.prefix}')
    expect(view).not.toContain('<DiscussDoor')
    // A part that could not be read says so; the rest is shown — never "No changes".
    expect(view).toContain("{failed && <PartFailed part={t('changesTab.history.revisionsPart')}")
    expect(view).toContain(': failed ? null :')
  })
})
