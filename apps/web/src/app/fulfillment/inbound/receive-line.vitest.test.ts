/**
 * Inbound receive — every receive screen sends the total it set AND the total it saw, so the server can refuse a line
 * that moved meanwhile instead of losing another receiver's units or booking a negative from an older total.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deskReceiveLine, receiveLine, scanReceiveLine } from './receive-line'

describe('receiveLine — the new total and the total the screen saw', () => {
  it('a count: the new total, with the total shown when the person set it', () => {
    expect(receiveLine('item-1', 5, 8)).toEqual({ itemId: 'item-1', quantityReceived: 8, expectedReceived: 5 })
  })

  it('a QC-only change keeps the shown total and still says it was seen (a stale one is refused, not booked down)', () => {
    expect(receiveLine('item-1', 3, 3)).toEqual({ itemId: 'item-1', quantityReceived: 3, expectedReceived: 3 })
  })

  it('a correction down from the current total is the person\'s own: it is sent, with the total they corrected', () => {
    expect(receiveLine('item-1', 5, 4)).toEqual({ itemId: 'item-1', quantityReceived: 4, expectedReceived: 5 })
  })
})

describe('scanReceiveLine — the scan adds to the total its lookup returned', () => {
  it('3 of 10 received, +4 scanned: total 7 from 3', () => {
    expect(scanReceiveLine({ itemId: 'item-1', quantityExpected: 10, quantityReceived: 3 }, 4)).toEqual({ itemId: 'item-1', quantityReceived: 7, expectedReceived: 3 })
  })

  it('never past what the line expects: 8 of 10, +5 scanned, total 10 from 8', () => {
    expect(scanReceiveLine({ itemId: 'item-1', quantityExpected: 10, quantityReceived: 8 }, 5)).toEqual({ itemId: 'item-1', quantityReceived: 10, expectedReceived: 8 })
  })
})

describe('deskReceiveLine — a desk drawer row, against the total shown when the person started editing it', () => {
  const row = (over: Partial<{ qty: string; qc: string; photoUrl: string; seen: number }>) => ({ qty: '', qc: '', photoUrl: '', seen: 5, ...over })

  it('a typed total: sent with the total it was typed against', () => {
    expect(deskReceiveLine('item-1', row({ qty: '8', qc: 'PASS' }), 'PASS')).toEqual({ itemId: 'item-1', quantityReceived: 8, expectedReceived: 5, qcStatus: 'PASS', photoUrls: undefined })
  })

  it('a QC-only change with an empty box keeps the shown total — before, the empty box was sent as 0 and booked −5', () => {
    expect(deskReceiveLine('item-1', row({ qc: 'HOLD' }), null)).toEqual({ itemId: 'item-1', quantityReceived: 5, expectedReceived: 5, qcStatus: 'HOLD', photoUrls: undefined })
  })

  it('a photo with an empty box keeps the shown total too', () => {
    expect(deskReceiveLine('item-1', row({ photoUrl: ' https://img.example.test/a.jpg ' }), null)).toMatchObject({ quantityReceived: 5, expectedReceived: 5, photoUrls: ['https://img.example.test/a.jpg'] })
  })

  it('a row that changes nothing, or holds no readable total, is not sent', () => {
    expect(deskReceiveLine('item-1', row({ qty: '5' }), null)).toBeNull()
    expect(deskReceiveLine('item-1', row({ qty: '' }), null)).toBeNull()
    expect(deskReceiveLine('item-1', row({ qty: '-1' }), null)).toBeNull()
    expect(deskReceiveLine('item-1', row({ qty: 'abc' }), null)).toBeNull()
  })
})

describe('🔴 the desk drawer, the mobile page and the scan all build their line this way', () => {
  const desk = readFileSync(join(__dirname, 'InboundWorkspace.tsx'), 'utf8')
  const mobile = readFileSync(join(__dirname, '[id]', 'receive', 'MobileReceiveClient.tsx'), 'utf8')

  it('each one builds its receive line with these helpers, against the total it showed when editing began', () => {
    expect(desk).toContain('.map(([itemId, v]) => deskReceiveLine(itemId, v, ')
    expect(desk).toContain('{ ...v, seen: receiveBuf[it.id]?.seen ?? it.quantityReceived }')
    expect(desk).toContain('const line = scanReceiveLine(cand, qtyValue)')
    expect(mobile).toContain('const [seen] = useState<number>(item.quantityReceived)')
    expect(mobile).toContain('...receiveLine(item.id, seen, target)')
  })

  it('no screen sends a bare total any more', () => {
    for (const source of [desk, mobile]) expect(source).not.toMatch(/\bquantityReceived: (target|qty|cumulativeChanges)\b/)
  })

  it('each one re-reads on the 409 that refuses a line that moved', () => {
    expect(desk.match(/res\.status === 409/g)).toHaveLength(2)
    expect(mobile).toContain('if (res.status === 409) { onStale(')
  })
})
