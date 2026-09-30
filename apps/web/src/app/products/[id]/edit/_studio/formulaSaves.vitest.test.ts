/**
 * WP3 (audit 2026-09-30) — what a formula save costs and leaves behind.
 *
 *  - A06: the save moves the row's version (the value is written through the bulk writer with a CAS); the answer now
 *    states it and both sheets adopt it, so the next plain edit on the row sends the right token (was a false 409).
 *  - B07: a formula save refreshes readiness on both sheets, like any other save.
 *  - B29: the batch formula reads skip the rows the sheet read already seeded; the function list is read once.
 *  - B30: removing a formula (a reset of a formula cell) re-reads nothing, and a bulk reset removes a few at a time.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { adoptFormulaVersions, forgetFormulaFunctions, formulaBatchRequests, readFormulaFunctionsOnce } from './formulaReadiness'

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8')

describe('B29 — formula batch reads on load', () => {
  // GALE eBay IT: 5 listing aliases × 21 rows, one language.
  const rowIds = Array.from({ length: 105 }, (_, i) => `a${i % 5}:p${i}`)
  const aliasOf = (id: string) => id.split(':')[0]
  it('a sheet read that seeded every row owes no batch read (before: one per alias — 5; with 3 languages 15)', () => {
    const before = formulaBatchRequests({ rowIds, languages: ['it'], forced: true, seeded: () => true, aliasOf })
    const after = formulaBatchRequests({ rowIds, languages: ['it'], forced: false, seeded: () => true, aliasOf })
    expect(before).toHaveLength(5)
    expect(formulaBatchRequests({ rowIds, languages: ['it', 'en', 'de'], forced: true, seeded: () => true, aliasOf })).toHaveLength(15)
    expect(after).toHaveLength(0)
  })
  it('rows the sheet read did not carry (a legacy read) are still read, in batches of 250 per alias and language', () => {
    const requests = formulaBatchRequests({ rowIds, languages: ['it'], forced: false, seeded: id => !id.startsWith('a0:'), aliasOf })
    expect(requests).toEqual([{ language: 'it', listingAlias: 'a0', batch: rowIds.filter(id => id.startsWith('a0:')) }])
  })
  it('the function list is read once per session; a failed read is asked again', async () => {
    forgetFormulaFunctions()
    const fetchList = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(['UPPER'])
    await expect(readFormulaFunctionsOnce(fetchList)).rejects.toThrow('offline')
    expect(await readFormulaFunctionsOnce(fetchList)).toEqual(['UPPER'])
    expect(await readFormulaFunctionsOnce(fetchList)).toEqual(['UPPER'])
    expect(fetchList).toHaveBeenCalledTimes(2)
  })
})

describe('A06 — a formula save’s versions are adopted', () => {
  it('the product version is taught to the writer, the listing version to the row', () => {
    const seed = vi.fn()
    const row = { id: 'p1', listing: { version: 7 } }
    expect(adoptFormulaVersions(row, { ok: true, versions: { product: 12, channelListing: 8 } }, seed)).toBe(true)
    expect(seed).toHaveBeenCalledWith(12)
    expect(row.listing.version).toBe(8)
  })
  it('the translation the save moved hands its token to its cells', () => {
    const cell = { value: 'x', contentVersion: 3, contentAddress: { tier: 'language', language: 'de' } }
    const row = { id: 'p1', values: { 'title@de': cell } }
    adoptFormulaVersions(row, { versions: { product: 5, channelListing: null }, contentVersions: [{ id: 'p1', tier: 'language', language: 'de', version: 4 }] }, () => undefined)
    expect((row.values['title@de'] as { contentVersion: number }).contentVersion).toBe(4)
  })
  it('an answer without versions (an older API) changes nothing', () => {
    const seed = vi.fn()
    expect(adoptFormulaVersions({ id: 'p1' }, { ok: true, value: 1 }, seed)).toBe(false)
    expect(seed).not.toHaveBeenCalled()
  })
  it.each([['master', read('sheet', 'master', 'useMasterSheetAdapter.tsx')], ['channel', read('sheet', 'channel', 'useChannelSheetAdapter.tsx')]])('%s sheet adopts them on every formula save', (_scope, src) => {
    expect(src).toMatch(/onValueSaved: \(rowId, fieldKey, value, answer\) => \{\s*const node = getGridApi\(\)\?\.getRowNode\(rowId\);\s*\/\/ A06[^\n]*\n\s*adoptFormulaVersions\(/)
  })
  it('the hook hands the answer to the sheet', () => {
    expect(read('useCellFormulas.ts')).toMatch(/onValueSaved\?\.\(rowId, fieldKey, body\.value, body\)/)
  })
})

describe('B07 — a formula save refreshes readiness', () => {
  it('master: the sheet and the progress bars', () => {
    expect(read('sheet', 'master', 'useMasterSheetAdapter.tsx')).toMatch(/onSettled: \(\) => \{ void refresh\(\); refreshReadinessSoon\(\); \}/)
  })
  it('channel: the rows and the coordinate’s readiness', () => {
    expect(read('sheet', 'channel', 'useChannelSheetAdapter.tsx')).toMatch(/onSettled: \(\) => \{ void refresh\([^\n]*\); refreshReadinessSoonRef\.current\(\); \}/)
  })
})

describe('B30 — a reset of formula cells', () => {
  const hook = read('useCellFormulas.ts')
  const pinOver = hook.slice(hook.indexOf('const pinOver = useCallback('), hook.indexOf('void productId'))
  it('removing a formula is known locally and asks for no read (no sheet read, no batch re-read)', () => {
    expect(pinOver).toMatch(/saveLocally\(previous, rowId, fieldKey, null\)/)
    expect(pinOver).not.toMatch(/settleWanted|setNonce/)
  })
  it('the queue settle asks the sheet to read only after a save that wrote a value, and never re-reads the formulas', () => {
    const queue = hook.slice(hook.indexOf('const queue = useMemo('), hook.indexOf('useEffect(() => { queue.activate()'))
    expect(queue).toMatch(/!settleWanted\.current\) return/)
    expect(queue).not.toMatch(/setNonce/)
  })
  it('a bulk reset removes formulas a few at a time', () => {
    const control = read('sheet', 'useSheetControl.tsx')
    expect(control).toMatch(/runBounded\(formulas\.map\(/)
    expect(control).not.toMatch(/Promise\.all\(formulas\.map/)
  })
})
