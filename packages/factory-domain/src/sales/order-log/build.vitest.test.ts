import { describe, expect, it } from 'vitest'
import { buildOrderLog, decodeLogCursor, encodeLogCursor, valuesOf, type LogAuditRow, type LogContext } from './build'
import { PICTURE_SET_ACTION } from './faces'

/** owb- (order workflow, b3.1): the ONE log's builder — three faces, the allow-list, typed values only. Made-up names only. */
const ALPHA = 'party-brand-alpha'
const ORDER = '0195f5d0-0000-7000-8000-0000000000a1'
const LINE = '0195f5d0-0000-7000-8000-0000000000a2'
const FILE_SHARED = '0195f5d0-0000-7000-8000-0000000000f1'
const FILE_OFFICE = '0195f5d0-0000-7000-8000-0000000000f2'
const row = (over: Partial<LogAuditRow> & Pick<LogAuditRow, 'id' | 'at' | 'action'>): LogAuditRow => ({ audience: 'OFFICE', actorId: 'user-sam', recordType: 'SalesOrder', recordId: ORDER, before: null, after: null, reason: null, ...over })

const ROWS: LogAuditRow[] = [
  row({ id: '0195f5d0-0000-7000-8000-000000000001', at: '2026-11-20T09:00:00.000Z', action: 'portalOrdering.send', recordType: 'PortalOrderRequest', audience: 'PARTNER', actorId: 'user-bianca', before: { status: 'DRAFT' }, after: { status: 'SENT' } }),
  row({ id: '0195f5d0-0000-7000-8000-000000000002', at: '2026-11-21T09:00:00.000Z', action: 'orders.changePromise', after: { previous: '2026-12-01', promiseDate: '2026-12-08' }, reason: 'Made-up office note: the supplier of the lining is late' }),
  row({ id: '0195f5d0-0000-7000-8000-000000000003', at: '2026-11-22T09:00:00.000Z', action: 'orders.priority', after: { priorityLevel: 'URGENT', urgentReason: 'Made-up rush for a race' } }),
  row({ id: '0195f5d0-0000-7000-8000-000000000004', at: '2026-11-23T09:00:00.000Z', action: 'production.baskets.move', audience: 'FLOOR', actorId: 'worker-pia', recordType: 'SalesOrderLine', recordId: LINE }),
  row({ id: '0195f5d0-0000-7000-8000-000000000005', at: '2026-11-24T09:00:00.000Z', action: 'portalOrdering.takePrices', recordType: 'PortalOrderRequest', audience: 'PARTNER', actorId: 'user-bianca', after: { prices: [{ lineId: LINE, unitPrice: { minor: 48000, currency: 'EUR' } }] } }),
  row({ id: '0195f5d0-0000-7000-8000-000000000006', at: '2026-11-25T09:00:00.000Z', action: PICTURE_SET_ACTION, before: { pictureFileId: FILE_OFFICE }, after: { pictureFileId: FILE_SHARED } }),
  row({ id: '0195f5d0-0000-7000-8000-000000000007', at: '2026-11-26T09:00:00.000Z', action: 'files.completeUpload', recordType: 'StoredFile', recordId: FILE_OFFICE }),
  row({ id: '0195f5d0-0000-7000-8000-000000000008', at: '2026-11-27T09:00:00.000Z', action: 'orders.markReady', before: { status: 'IN_PRODUCTION' }, after: { status: 'READY' } }),
]
const base: Omit<LogContext, 'door' | 'gate'> = {
  names: new Map([['user-sam', 'Sam Sales'], ['user-bianca', 'Bianca Buyer'], ['worker-pia', 'Pia Stitcher']]),
  actorParties: new Map([['user-bianca', ALPHA]]),
  departments: new Map([['0195f5d0-0000-7000-8000-000000000004', 4]]),
  labels: new Map([[ORDER, 'SO-2026-0042'], [LINE, 'Line 1'], [FILE_OFFICE, 'made-up price list.pdf']]),
}

describe('buildOrderLog: one log, three faces', () => {
  it('office: every row, newest first, names (a worker behind a closed gate: the department), the reason, typed values', () => {
    const rows = buildOrderLog(ROWS, { ...base, door: 'office', gate: { workerNamesOpen: true }, hiddenWorkerRows: new Set(['0195f5d0-0000-7000-8000-000000000004']) })
    expect(rows.map((entry) => entry.id.slice(-1))).toEqual(['8', '7', '6', '5', '4', '3', '2', '1'])
    expect(rows.find((entry) => entry.action === 'PROMISE_MOVED')).toMatchObject({ who: { face: 'PERSON', name: 'Sam Sales' }, from: { kind: 'DATE', date: '2026-12-01' }, to: { kind: 'DATE', date: '2026-12-08' }, reason: 'Made-up office note: the supplier of the lining is late' })
    expect(rows.find((entry) => entry.id.endsWith('4'))?.who).toEqual({ face: 'DEPARTMENT', name: null, departmentNo: 4 })
    expect(rows.find((entry) => entry.action === 'READY')).toMatchObject({ from: { kind: 'LIFE', life: 'IN_PRODUCTION' }, to: { kind: 'LIFE', life: 'READY_TO_SHIP' }, icon: 'package-check', subject: { kind: 'ORDER', label: 'SO-2026-0042' } })
  })

  it('portal: the ALLOW-list only; "The factory" for every factory person; no reason, no office note, no worker, no price; a file only when shared', () => {
    const rows = buildOrderLog(ROWS, { ...base, door: 'portal', gate: { workerNamesOpen: false, viewerPartyId: ALPHA }, visibleFileIds: new Set([FILE_SHARED]) })
    expect(rows.map((entry) => entry.action)).toEqual(['READY', 'PICTURE_SET', 'PROMISE_MOVED', 'SENT'])
    for (const entry of rows) expect(entry.reason).toBeNull()
    expect(rows.find((entry) => entry.action === 'PROMISE_MOVED')?.who).toEqual({ face: 'THE_FACTORY', name: null, departmentNo: null })
    expect(rows.find((entry) => entry.action === 'SENT')?.who).toEqual({ face: 'PERSON', name: 'Bianca Buyer', departmentNo: null })
    // The picture's former file is office only: the customer reads "no picture", never its id.
    expect(rows.find((entry) => entry.action === 'PICTURE_SET')).toMatchObject({ from: { kind: 'PICTURE', fileId: null }, to: { kind: 'PICTURE', fileId: FILE_SHARED } })
    const said = JSON.stringify(rows)
    for (const secret of ['Pia', 'Sam', 'office note', 'rush', 'URGENT', '48000', 'EUR', 'price list', FILE_OFFICE]) expect(said, secret).not.toContain(secret)
  })

  it('floor: "You" / "Office" / the department, never a name, never a reason', () => {
    const rows = buildOrderLog(ROWS, { ...base, door: 'floor', gate: { workerNamesOpen: true, viewerWorkerId: 'worker-ola' } })
    expect(new Set(rows.map((entry) => entry.who.face))).toEqual(new Set(['OFFICE', 'DEPARTMENT']))
    expect(rows.every((entry) => entry.who.name === null && entry.reason === null)).toBe(true)
    const mine = buildOrderLog(ROWS.filter((entry) => entry.audience === 'FLOOR'), { ...base, door: 'floor', gate: { workerNamesOpen: true, viewerWorkerId: 'worker-pia' } })
    expect(mine.map((entry) => entry.who)).toEqual([{ face: 'YOU', name: null, departmentNo: null }])
  })

  it('a price never becomes a log value, whatever the reader (no money kind exists)', () => {
    expect(valuesOf({ action: 'portalOrdering.takePrices', recordType: 'PortalOrderRequest', before: null, after: { prices: [{ unitPrice: { minor: 48000, currency: 'EUR' } }] } })).toEqual({ from: null, to: null })
    expect(valuesOf({ action: 'brandPrices.fromRequest', recordType: 'SalesOrder', before: { netAmount: 1 }, after: { netAmount: 2 } })).toEqual({ from: null, to: null })
    expect(valuesOf({ action: 'portalOrdering.addLines', recordType: 'PortalOrderRequest', before: null, after: { lines: [{}, {}] } })).toEqual({ from: null, to: { kind: 'COUNT', n: 2 } })
    expect(valuesOf({ action: 'orders.cancel', recordType: 'SalesOrder', before: { status: 'CONFIRMED' }, after: { status: 'CANCELLED' } })).toEqual({ from: { kind: 'LIFE', life: 'CONFIRMED' }, to: { kind: 'LIFE', life: 'WITHDRAWN' } })
  })
})

describe('the page cursor', () => {
  it('round-trips a row\'s time and id; a cursor that is not ours is null', () => {
    const cursor = encodeLogCursor({ at: '2026-11-20T09:00:00.000Z', id: '0195f5d0-0000-7000-8000-000000000001' })
    expect(decodeLogCursor(cursor)).toEqual({ at: new Date('2026-11-20T09:00:00.000Z'), id: '0195f5d0-0000-7000-8000-000000000001' })
    for (const wrong of ['', 'x', '123', '12_not-an-id', undefined, null]) expect(decodeLogCursor(wrong as string | undefined)).toBeNull()
  })
})
