import { describe, expect, it } from 'vitest'
import { incomingListQuery } from './contracts'
import { changeSummaryOf, compareKeys, INCOMING_DESIGN_TILES, INCOMING_KINDS, INCOMING_TILES, isOpenState, mergePage, stateWords, TILE_KINDS, waitsOnUs, type IncomingCursor } from './rules'
import { QUEUE_TILES } from './rules' // B-CQ-020

/** B-TH-039: Sales › Incoming's one read, pure — the kinds in the tiles, the states, the merged page and its cursor. */
describe('Sales › Incoming over every door (B-TH-039)', () => {
  it('the five tiles of the design come first; every tile names the kinds it can hold', () => {
    expect(INCOMING_TILES.slice(0, 5)).toEqual([...INCOMING_DESIGN_TILES])
    for (const tile of INCOMING_TILES) expect(TILE_KINDS[tile].length, tile).toBeGreaterThan(0)
    expect(TILE_KINDS.WAITING_CUSTOMER).toEqual(['REQUEST'])
    expect(TILE_KINDS.NOT_AN_ORDER).toEqual(['REQUEST'])
    expect(TILE_KINDS.ALL).toEqual(INCOMING_KINDS)
  })
  it('what waits for the office, and on whom', () => {
    expect(isOpenState('REQUEST', 'NEED_INFO')).toBe(true)
    expect(waitsOnUs('REQUEST', 'NEED_INFO')).toBe(false)
    expect(waitsOnUs('CATALOGUE_ORDER', 'SENT')).toBe(true)
    expect(isOpenState('CATALOGUE_ORDER', 'ACCEPTED')).toBe(false)
    expect(waitsOnUs('CHANGE_REQUEST', 'OPEN')).toBe(true)
    expect(isOpenState('CHANGE_REQUEST', 'WITHDRAWN')).toBe(false)
  })
  it('each kind’s state in both languages, a decline with its reason, a change request with its kind', () => {
    expect(stateWords('REQUEST', 'DECLINED', 'PRICE').en).toMatch(/·/)
    expect(stateWords('CATALOGUE_ORDER', 'SENT')).toEqual({ it: 'Richiesta inviata', en: 'Request sent' })
    expect(stateWords('CHANGE_REQUEST', 'OPEN', null, 'CANCEL').en).toBe('Cancel request · Waiting for our answer')
    expect(changeSummaryOf('CHANGE', 'SO-0002', 1, 2)).toBe('Change request · SO-0002 · 1 line, 2 sizes')
    expect(changeSummaryOf('CANCEL', 'SO-0003', 0, 0)).toBe('Cancel request of order SO-0003')
  })
  it('one page of the merged kinds in (at, kind, id) order, ascending or descending, and the cursor of the next', () => {
    const row = (at: string, kind: (typeof INCOMING_KINDS)[number], id: string) => ({ key: { at, kind, id } as IncomingCursor })
    const requests = [row('2026-11-01T09:00:00.000Z', 'REQUEST', 'a'), row('2026-11-03T09:00:00.000Z', 'REQUEST', 'b')]
    const catalogue = [row('2026-11-01T09:00:00.000Z', 'CATALOGUE_ORDER', 'c'), row('2026-11-02T09:00:00.000Z', 'CATALOGUE_ORDER', 'd')]
    const up = mergePage([requests, catalogue], 3, false)
    expect(up.rows.map((entry) => entry.key.id)).toEqual(['a', 'c', 'd'])
    expect(up.next).toEqual(up.rows[2]!.key)
    const down = mergePage([[...requests].reverse(), [...catalogue].reverse()], 10, true)
    expect(down.rows.map((entry) => entry.key.id)).toEqual(['b', 'd', 'c', 'a'])
    expect(down.next).toBeNull()
    expect(compareKeys(requests[0]!.key, catalogue[0]!.key)).toBe(-1)
  })
  it('the query: tiles, kinds and a cursor; an unknown tile is refused', () => {
    expect(incomingListQuery.safeParse({ tile: 'NOT_AN_ORDER', kind: 'CHANGE_REQUEST', cursor: 'abc', limit: '50' }).success).toBe(true)
    expect(incomingListQuery.safeParse({ tile: 'SOMETHING' }).success).toBe(false)
    expect(incomingListQuery.safeParse({ limit: '500' }).success).toBe(false)
  })
  // ---- B-CQ-020 / B-CQ-021 (customer page › Quotes & incoming, settle C8): two tiles appended at the end; some kinds only
  it('B-CQ-020: TO_ANSWER and ENDED come last, hold every kind; TO_ANSWER is a queue (oldest first)', () => {
    expect(INCOMING_TILES.slice(-2)).toEqual(['TO_ANSWER', 'ENDED'])
    expect(TILE_KINDS.TO_ANSWER).toEqual(INCOMING_KINDS)
    expect(TILE_KINDS.ENDED).toEqual(INCOMING_KINDS)
    expect(QUEUE_TILES).toContain('TO_ANSWER')
    expect(QUEUE_TILES).not.toContain('ENDED')
    expect(incomingListQuery.safeParse({ tile: 'TO_ANSWER' }).success).toBe(true)
    expect(incomingListQuery.safeParse({ tile: 'ENDED' }).success).toBe(true)
  })
  it('B-CQ-021: `kinds` is a comma list of the kinds (1–3); anything else is refused', () => {
    const parsed = incomingListQuery.safeParse({ kinds: 'REQUEST,CATALOGUE_ORDER' })
    expect(parsed.success && parsed.data.kinds).toEqual(['REQUEST', 'CATALOGUE_ORDER'])
    expect(incomingListQuery.safeParse({ kinds: 'CHANGE_REQUEST' }).success).toBe(true)
    for (const kinds of ['NOPE', 'REQUEST,NOPE', '', 'REQUEST,,CATALOGUE_ORDER', 'REQUEST,CATALOGUE_ORDER,CHANGE_REQUEST,REQUEST']) expect(incomingListQuery.safeParse({ kinds }).success, kinds).toBe(false)
  })
})
