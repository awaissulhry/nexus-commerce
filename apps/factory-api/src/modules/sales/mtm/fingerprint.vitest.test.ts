import { describe, expect, it } from 'vitest'
import { fingerprintOf } from '../quotes/pricing'
import type { LineRecord, VersionRow } from '../quotes/store'
import { oncePerRevision, unitFingerprint } from './fingerprint'

/**
 * B-W2b-368 (XF1:05): what makes a made-to-measure document the same — the quote's approval fingerprint names a unit's measurement
 * profile revision and base size (a size-grid line's part is as before), and a worksheet revision's PDF is prepared once at a time.
 */

const dec = (value: string) => ({ toString: () => value, toFixed: (places: number) => Number(value).toFixed(places) })
const VERSION = { currency: 'EUR', taxMode: 'IT_B2B', depositPct: null, netAmount: 50_000, vatAmount: 11_000, grossAmount: 61_000, costAmount: 20_000 } as unknown as VersionRow
const line = (over: Partial<Record<string, unknown>>): LineRecord =>
  ({ seq: 10, kind: 'SIZE_GRID', styleId: 'style', styleRevisionId: null, colourwayId: 'blk', unitPrice: dec('500'), listUnitPrice: null, costAmount: 20_000, vatRatePct: dec('22'), vatNature: null, measurementProfileId: null, baseSize: null, sizes: [{ size: '52', quantity: 1, unitPrice: null }], ...over }) as unknown as LineRecord

describe('the quote approval fingerprint names a unit’s revision (XF1:05)', () => {
  it('a unit adds its revision and base size; a size-grid line adds nothing', () => {
    expect(unitFingerprint({ kind: 'MADE_TO_MEASURE', measurementProfileId: 'rev-2', baseSize: '54' })).toEqual([['rev-2', '54']])
    expect(unitFingerprint({ kind: 'SIZE_GRID', measurementProfileId: null, baseSize: null })).toEqual([])
  })

  it('a unit moved to another revision or base size changes the fingerprint (a pending approval goes STALE)', () => {
    const unit = line({ kind: 'MADE_TO_MEASURE', measurementProfileId: 'rev-1', baseSize: '52', sizes: [] })
    const same = fingerprintOf(VERSION, [unit])
    expect(fingerprintOf(VERSION, [unit])).toBe(same)
    expect(fingerprintOf(VERSION, [{ ...unit, measurementProfileId: 'rev-2' } as LineRecord])).not.toBe(same)
    expect(fingerprintOf(VERSION, [{ ...unit, baseSize: '54' } as LineRecord])).not.toBe(same)
  })

  it('a size-grid quote hashes as before: its line holds no profile part', () => {
    const grid = line({})
    expect(fingerprintOf(VERSION, [grid])).toBe(fingerprintOf(VERSION, [{ ...grid, measurementProfileId: 'ignored', baseSize: 'ignored' } as LineRecord]))
  })
})

describe('the worksheet PDF of a revision is prepared once at a time (XF1:05)', () => {
  it('a second caller with the same key shares the first run; after it ends a new run starts', async () => {
    let runs = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const make = async () => {
      runs += 1
      await gate
      return { version: runs }
    }
    const first = oncePerRevision('rev-1|A|en', make)
    const second = oncePerRevision('rev-1|A|en', make)
    const other = oncePerRevision('rev-1|A|it', async () => ({ version: 99 }))
    release()
    expect(await first).toEqual({ version: 1 })
    expect(await second).toEqual({ version: 1 })
    expect(await other).toEqual({ version: 99 })
    expect(runs).toBe(1)
    expect(await oncePerRevision('rev-1|A|en', make)).toEqual({ version: 2 })
  })

  it('a failed run is shared too, and the next call tries again', async () => {
    let tries = 0
    const failing = async () => {
      tries += 1
      throw new Error('store down')
    }
    await expect(Promise.all([oncePerRevision('rev-9', failing), oncePerRevision('rev-9', failing)])).rejects.toThrow('store down')
    expect(tries).toBe(1)
    await expect(oncePerRevision('rev-9', failing)).rejects.toThrow('store down')
    expect(tries).toBe(2)
  })
})
