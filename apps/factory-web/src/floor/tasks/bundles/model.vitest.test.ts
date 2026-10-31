import { describe, expect, it } from 'vitest'
import { editQuantity, jobMoving, jobOfCode, liveOf, maxAt, nextBundleSize, pendingByCell, proposalOf, splitMax, ticketLayout, ticketPrint, uncounted, type JobState, type MadeTicket } from './model'

/** SCR-095's rules without a screen: the proposal, a bundle's quantity changed, what the tablet made, the print state. */

describe('the proposal (the API\'s split: full bundles, the last takes the rest)', () => {
  it('splits what is still to bundle by the size; one garment each for a made-to-measure unit', () => {
    expect(proposalOf(16, 10, false)).toEqual([10, 6])
    expect(proposalOf(12, 5, false)).toEqual([5, 5, 2])
    expect(proposalOf(3, 10, true)).toEqual([1, 1, 1])
    expect(proposalOf(0, 10, false)).toEqual([])
    expect(proposalOf(-2, 10, false)).toEqual([])
  })

  it('keeps the bundle size between 1 and 500', () => {
    expect(nextBundleSize(10, 1)).toBe(11)
    expect(nextBundleSize(1, -1)).toBe(1)
    expect(nextBundleSize(500, 1)).toBe(500)
  })

  it('a typed quantity keeps the bundles before it and splits the rest again: every garment keeps a bundle', () => {
    expect(editQuantity([10, 6], 0, 8, 16, 10)).toEqual([8, 8])
    expect(editQuantity([10, 6], 1, 3, 16, 10)).toEqual([10, 3, 3])
    expect(editQuantity([10, 6], 0, 40, 16, 10)).toEqual([16])
    expect(editQuantity([10, 6], 0, 0, 16, 10)).toEqual([1, 10, 5])
    expect(editQuantity([5, 5, 2], 1, 4, 12, 5).reduce((a, b) => a + b, 0)).toBe(12)
    expect(maxAt([10, 6], 1, 16)).toBe(6)
    expect(maxAt([10, 6], 0, 16)).toBe(16)
  })
})

describe('what this tablet made and the office does not count yet', () => {
  const made: MadeTicket[] = [
    { clientEventId: 'a', workOrderId: 'wo', workOrderSizeId: 'c1', quantity: 10 },
    { clientEventId: 'b', workOrderId: 'wo', workOrderSizeId: 'c1', quantity: 6 },
    { clientEventId: 'c', workOrderId: 'wo', workOrderSizeId: 'c2', quantity: 8 },
    { clientEventId: 'd', workOrderId: 'wo', workOrderSizeId: 'c2', quantity: 4 },
  ]
  const items = [
    { clientEventId: 'a', state: 'waiting' as const, refusal: null },
    { clientEventId: 'b', state: 'recorded' as const, refusal: null },
    { clientEventId: 'c', state: 'refused' as const, refusal: { id: 'r', code: 'FLOOR_NOT_READY', message: 'x', fix: 'y', final: false } },
    { clientEventId: 'd', state: 'refused' as const, refusal: { id: 'r2', code: 'MORE_THAN_CUT', message: 'x', fix: 'y', final: true } },
  ]

  it('counts waiting ones, refused ones sent again by themselves, and recorded ones the last read does not count', () => {
    expect(pendingByCell(made, items, new Set())).toEqual(new Map([['c1', 16], ['c2', 8]]))
    expect(pendingByCell(made, items, new Set(['b']))).toEqual(new Map([['c1', 10], ['c2', 8]]))
  })

  it('asks for a new read when the office recorded a make the read does not count', () => {
    expect(uncounted(made, items, new Set())).toEqual(['b'])
    expect(uncounted(made, items, new Set(['b']))).toEqual([])
  })
})

describe('a ticket\'s print', () => {
  const job = (id: string, status: JobState['status'], scanId: string | null, createdAt: string): JobState => ({ id, status, version: 1, scanId, lastError: null, createdAt })

  it('takes the newest job of the ticket\'s code (a reprint has a new code)', () => {
    const jobs = [job('1', 'PRINTED', 'BN-OLD', '2026-10-29T08:00:00Z'), job('2', 'QUEUED', 'BN-NEW', '2026-10-29T09:00:00Z')]
    expect(jobOfCode(jobs, 'BN-OLD')?.id).toBe('1')
    expect(jobOfCode(jobs, 'BN-NEW')?.id).toBe('2')
    expect(jobOfCode(jobs, null)?.id).toBe('2')
    expect(jobOfCode([], 'BN-NEW')).toBeNull()
  })

  it('watches a job while it moves; never invents a state', () => {
    expect(jobMoving(null)).toBe(true)
    expect(jobMoving(job('1', 'SENT', null, ''))).toBe(true)
    expect(jobMoving(job('1', 'FAILED', null, ''))).toBe(false)
    expect(ticketPrint({ recorded: false, printer: 'some', seesJobs: true, job: null })).toEqual({ kind: 'waiting' })
    expect(ticketPrint({ recorded: true, printer: 'none', seesJobs: true, job: null })).toEqual({ kind: 'none' })
    expect(ticketPrint({ recorded: true, printer: 'some', seesJobs: false, job: null })).toEqual({ kind: 'hidden' })
    expect(ticketPrint({ recorded: true, printer: 'some', seesJobs: true, job: null })).toEqual({ kind: 'looking' })
  })
})

describe('the ticket as a label', () => {
  const words = { name: (code: string) => `Ticket ${code}`, workOrder: 'WO', style: 'Style', colour: 'Colour', size: 'Size', pieces: 'Pieces', operations: 'Ops', numbering: 'Numbered by the office' }
  const ticket = { code: 'BN-7K-00003R-M', workOrder: { number: 'WO-1', batchNumber: 'B-1' }, style: { code: 'S', name: 'Jacket' }, colourway: 'BLK', size: '52', quantity: 10, part: null, operations: [{ seq: 10, code: 'A', name: 'a' }, { seq: 20, code: 'B', name: 'b' }] }

  it('carries the code as QR and Code 128, the facts and the operations; no barcode before the office numbers it', () => {
    const layout = ticketLayout(ticket, words)
    const json = JSON.stringify(layout)
    expect(layout.widthMm).toBe(100)
    expect(json).toContain('"kind":"barcode","value":"BN-7K-00003R-M"')
    expect(json).toContain('"kind":"qr","value":"BN-7K-00003R-M"')
    expect(json).toContain('WO-1 · B-1')
    expect(json).toContain('Ops: 10 · 20')
    const pending = JSON.stringify(ticketLayout({ ...ticket, code: null }, words))
    expect(pending).not.toContain('barcode')
    expect(pending).toContain('Numbered by the office')
  })
})

describe('split a bundle (B-W2a-75; the API\'s rule: factory-domain liveGarments)', () => {
  it('the garments still in a bundle: as cut, less its children that are not void; at least one stays', () => {
    const bundles = [
      { id: 'p', parentBundleId: null, quantity: 10, status: 'ACTIVE' as const },
      { id: 'c1', parentBundleId: 'p', quantity: 3, status: 'ACTIVE' as const },
      { id: 'c2', parentBundleId: 'p', quantity: 2, status: 'VOID' as const },
      { id: 'other', parentBundleId: 'x', quantity: 4, status: 'ACTIVE' as const },
    ]
    expect(liveOf({ id: 'p', quantity: 10 }, bundles)).toBe(7)
    expect(liveOf({ id: 'c1', quantity: 3 }, bundles)).toBe(3)
    expect(splitMax(7)).toBe(6)
    expect(splitMax(1)).toBe(0)
    expect(splitMax(0)).toBe(0)
  })
})
