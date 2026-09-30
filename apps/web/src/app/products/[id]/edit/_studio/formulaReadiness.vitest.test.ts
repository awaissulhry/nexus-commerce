/**
 * P0 (2026-09-30) — no editor waits for `/pim/formulas/batch`.
 *
 * Before: one global `ready` flag, set only after EVERY batch read (one per alias and language, one after another)
 * had answered. Until then every editor was "Loading formulas… Retry / Close" and every edit was refused and lost.
 * These cases pin the pieces that replace it: the sheet read seeds each cell, readiness is per cell, the reads run
 * in parallel with a bound, and an edit to a still-unknown cell is held and applied, never refused.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import {
  FORMULA_READS_AT_ONCE, FORMULAS_LOADING, clearFailures, createHeldEdits, effectiveFormulas, emptyReads, failRead, failureFor,
  formulaState, landRead, rowKnown, runBounded, saveLocally, seedFromSheet,
} from './formulaReadiness'

const plain = { value: 'Pakistan', source: 'channel' }
const sheetRows = [
  { rowId: 'parent', values: { paese_di_origine: plain, titolo: { value: 'GALE', formula: '$name & " Jacket"' } } },
  { rowId: 'child', values: { paese_di_origine: plain, colore: { value: null, formula: '$color', formulaError: 'Not in the list.' } } },
]
const IT = ['it']
const state = (reads: ReturnType<typeof emptyReads>, seed: ReturnType<typeof seedFromSheet>, rowId: string, key: string, languages = IT) =>
  formulaState(reads, seed, languages, 'it', rowId, key)

describe('the sheet read seeds every cell it carries', () => {
  const seed = seedFromSheet(sheetRows)

  it('a plain cell of a row the sheet carried is known, with no formula, before any batch read', () => {
    expect(state(emptyReads('k'), seed, 'child', 'paese_di_origine')).toEqual({ known: true, formula: null })
  })

  it('a cell with a formula is known with its expression and the server’s own error', () => {
    expect(state(emptyReads('k'), seed, 'parent', 'titolo').formula).toEqual({ expr: '$name & " Jacket"', lastError: null })
    expect(state(emptyReads('k'), seed, 'child', 'colore').formula).toEqual({ expr: '$color', lastError: 'Not in the list.' })
  })

  it('a row the sheet did not carry stays unknown until a read answers for it', () => {
    expect(state(emptyReads('k'), seed, 'other', 'paese_di_origine').known).toBe(false)
    expect(rowKnown(emptyReads('k'), seed, IT, 'other')).toBe(false)
    expect(rowKnown(emptyReads('k'), seed, IT, 'child')).toBe(true)
  })

  it('ignores anything that is not an expression string', () => {
    const odd = seedFromSheet([{ rowId: 'r', values: { a: { formula: true }, b: null, c: undefined, d: { formula: '1', formulaError: 7 } } }])
    expect([...odd.rows.get('r')!]).toEqual([['d', { expr: '1', lastError: null }]])
  })

  it('the same content gives the same signature, a changed formula a different one', () => {
    expect(seedFromSheet(sheetRows).signature).toBe(seed.signature)
    const changed = seedFromSheet([sheetRows[0], { rowId: 'child', values: { colore: { formula: '$colour' } } }])
    expect(changed.signature).not.toBe(seed.signature)
  })
})

describe('precedence: this tab’s save > a batch read that answered > the sheet read', () => {
  const seed = seedFromSheet(sheetRows)
  const answered = (formulas: Record<string, Record<string, string>>, rowIds = ['parent', 'child'], language = 'it') =>
    landRead(emptyReads('k'), { language, locale: 'it', rowIds, formulas: new Map(Object.entries(formulas).map(([row, cells]) => [row, new Map(Object.entries(cells).map(([k, expr]) => [k, { expr }]))])) })

  it('a batch read replaces the seed for the rows it answered — including "no formula any more"', () => {
    const reads = answered({ child: { paese_di_origine: '"Italia"' } })
    expect(state(reads, seed, 'child', 'paese_di_origine').formula?.expr).toBe('"Italia"')
    expect(state(reads, seed, 'parent', 'titolo')).toEqual({ known: true, formula: null })
  })

  it('this tab’s own save wins until a later read answers for that cell', () => {
    const saved = saveLocally(answered({}), 'child', 'paese_di_origine', { expr: '"Cina"' })
    expect(state(saved, seed, 'child', 'paese_di_origine').formula?.expr).toBe('"Cina"')
    const replaced = saveLocally(saved, 'parent', 'titolo', null)
    expect(state(replaced, seed, 'parent', 'titolo')).toEqual({ known: true, formula: null })
    const reread = landRead(replaced, { language: 'it', locale: 'it', rowIds: ['child'], formulas: new Map() })
    expect(state(reread, seed, 'child', 'paese_di_origine').formula).toBeNull()
    expect(reread.saved.has('parent')).toBe(true)
  })

  it('effectiveFormulas agrees with formulaState, and its signature ignores a read that changed nothing', () => {
    const before = effectiveFormulas(emptyReads('k'), seed, IT, 'it')
    const same = effectiveFormulas(answered({ parent: { titolo: '$name & " Jacket"' }, child: { colore: '$color' } }), seed, IT, 'it')
    expect([...before.formulas.get('parent')!.keys()]).toEqual(['titolo'])
    // The seed carries the server's error too; the batch row here does not, so only the error part differs.
    expect(same.formulas.get('child')!.get('colore')!.expr).toBe('$color')
    const unchanged = effectiveFormulas(landRead(emptyReads('k'), { language: 'it', locale: 'it', rowIds: ['parent'], formulas: new Map([['parent', new Map([['titolo', { expr: '$name & " Jacket"', lastError: null }]])]]) }), seed, IT, 'it')
    expect(unchanged.signature).toBe(before.signature)
    const removed = effectiveFormulas(answered({}, ['parent']), seed, IT, 'it')
    expect(removed.signature).not.toBe(before.signature)
    expect(removed.formulas.get('parent')?.get('titolo')).toBeUndefined()
  })
})

describe('language columns: a read answers only for its own language', () => {
  const languages = ['it', 'de']
  const reads = landRead(emptyReads('k'), { language: 'de', locale: 'it', rowIds: ['r'], formulas: new Map([['r', new Map([['title@de', { expr: '$name' }]])]]) })
  const none = seedFromSheet([])

  it('`title@de` is known once the de read answered; `title@it` and plain keys wait for the it read', () => {
    expect(formulaState(reads, none, languages, 'it', 'r', 'title@de')).toEqual({ known: true, formula: { expr: '$name' } })
    expect(formulaState(reads, none, languages, 'it', 'r', 'title@it').known).toBe(false)
    expect(formulaState(reads, none, languages, 'it', 'r', 'brand').known).toBe(false)
    const both = landRead(reads, { language: 'it', locale: 'it', rowIds: ['r'], formulas: new Map() })
    expect(formulaState(both, none, languages, 'it', 'r', 'brand')).toEqual({ known: true, formula: null })
    expect(rowKnown(both, none, languages, 'r')).toBe(true)
  })

  it('a plain key whose language no read asks for is known once every read of its row answered', () => {
    const deFr = landRead(landRead(emptyReads('k'), { language: 'de', locale: 'it', rowIds: ['r'], formulas: new Map() }), { language: 'fr', locale: 'it', rowIds: ['r'], formulas: new Map() })
    expect(formulaState(deFr, none, ['de', 'fr'], 'it', 'r', 'brand').known).toBe(true)
    expect(formulaState(landRead(emptyReads('k'), { language: 'de', locale: 'it', rowIds: ['r'], formulas: new Map() }), none, ['de', 'fr'], 'it', 'r', 'brand').known).toBe(false)
  })
})

describe('a failed read affects only the cells that need it', () => {
  const seed = seedFromSheet(sheetRows)
  const failed = failRead(emptyReads('k'), { language: 'it', rowIds: ['parent', 'child', 'other'], error: 'Could not load formulas.' })

  it('a row the sheet carried stays editable; only an unknown row reports the read’s error', () => {
    expect(state(failed, seed, 'child', 'paese_di_origine').known).toBe(true)
    expect(state(failed, seed, 'other', 'paese_di_origine').known).toBe(false)
    expect(failureFor(failed, IT, 'it', 'other', 'paese_di_origine')).toBe('Could not load formulas.')
  })

  it('an earlier answer still stands when a refresh fails', () => {
    const answered = landRead(emptyReads('k'), { language: 'it', locale: 'it', rowIds: ['other'], formulas: new Map() })
    expect(state(failRead(answered, { language: 'it', rowIds: ['other'], error: 'x' }), seed, 'other', 'a').known).toBe(true)
  })

  it('a retry clears the errors (the cell says Loading again) and a later answer clears its own error', () => {
    expect(failureFor(clearFailures(failed), IT, 'it', 'other', 'a')).toBeNull()
    expect(FORMULAS_LOADING).toBe('Loading formulas…')
    const recovered = landRead(failed, { language: 'it', locale: 'it', rowIds: ['other'], formulas: new Map() })
    expect(recovered.failed.has('other')).toBe(false)
    expect(recovered.failed.has('parent')).toBe(true)
  })
})

describe('runBounded — the batch reads run in parallel, at most FORMULA_READS_AT_ONCE at a time', () => {
  const gate = () => {
    let inFlight = 0, most = 0
    const started: number[] = []
    const releases: Array<() => void> = []
    const task = (i: number) => () => new Promise<number>(resolve => {
      inFlight++; most = Math.max(most, inFlight); started.push(i)
      releases.push(() => { inFlight--; resolve(i) })
    })
    return { task, started, releases, most: () => most }
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))

  it('five alias reads start four at once (the old loop started one), and every one runs', async () => {
    const g = gate()
    const run = runBounded([0, 1, 2, 3, 4].map(g.task), FORMULA_READS_AT_ONCE)
    await tick()
    expect(FORMULA_READS_AT_ONCE).toBe(4)
    expect(g.started).toEqual([0, 1, 2, 3])
    g.releases[1]()
    await tick()
    expect(g.started).toEqual([0, 1, 2, 3, 4])
    for (const release of g.releases) release()
    const results = await run
    expect(results.map(r => r?.status === 'fulfilled' && r.value)).toEqual([0, 1, 2, 3, 4])
    expect(g.most()).toBe(4)
  })

  it('a failed read does not stop the others', async () => {
    const results = await runBounded([() => Promise.reject(new Error('500')), () => Promise.resolve('ok')], 1)
    expect(results.map(r => r?.status)).toEqual(['rejected', 'fulfilled'])
  })

  it('no new read starts once the load is abandoned', async () => {
    const controller = new AbortController()
    const seen: number[] = []
    await runBounded([0, 1, 2].map(i => async () => { seen.push(i); if (i === 0) controller.abort() }), 1, controller.signal)
    expect(seen).toEqual([0])
  })
})

describe('an edit to a cell whose formula state is unknown is held, never refused', () => {
  it('applies held edits in the order they were made, as soon as their cell is known', () => {
    const held = createHeldEdits()
    const applied: string[] = []
    held.hold({ rowId: 'r1', fieldKey: 'a', apply: () => applied.push('r1.a=1') })
    held.hold({ rowId: 'r2', fieldKey: 'a', apply: () => applied.push('r2.a') })
    held.hold({ rowId: 'r1', fieldKey: 'a', apply: () => applied.push('r1.a=2') })
    expect(held.release(() => false)).toBe(0)
    expect(held.release((rowId) => rowId === 'r1')).toBe(2)
    expect(applied).toEqual(['r1.a=1', 'r1.a=2'])
    expect(held.size).toBe(1)
    held.release(() => true)
    expect(applied).toEqual(['r1.a=1', 'r1.a=2', 'r2.a'])
    expect(held.size).toBe(0)
  })

  it('an edit the sheet dropped first says so instead of vanishing', () => {
    const held = createHeldEdits()
    const apply = vi.fn(), drop = vi.fn()
    held.hold({ rowId: 'r', fieldKey: 'a', apply, drop })
    expect(held.drop()).toBe(1)
    held.release(() => true)
    expect(apply).not.toHaveBeenCalled()
    expect(drop).toHaveBeenCalledOnce()
  })
})

describe('the wiring: both sheets hold an unknown cell’s edit and ask per cell', () => {
  const channel = readFileSync(new URL('./sheet/channel/useChannelSheetAdapter.tsx', import.meta.url), 'utf8')
  const master = readFileSync(new URL('./sheet/master/useMasterSheetAdapter.tsx', import.meta.url), 'utf8')
  const hook = readFileSync(new URL('./useCellFormulas.ts', import.meta.url), 'utf8')

  it.each([['channel', channel], ['master', master]])('the %s sheet never refuses an edit because formulas are loading', (_scope, source) => {
    expect(source).not.toMatch(/Formulas are still loading/)
    expect(source).not.toMatch(/formulas\.ready\s*\)\s*\{/)
    expect(source).toMatch(/formulas\.whenKnown\(/)
    expect(source).toMatch(/unavailableReason: \(rowId[^)]*\) => formulaLive\.current\.formulas\.unavailableFor\(rowId, fieldKey\)/)
    expect(source).toMatch(/seedRows: /)
  })

  it('the reads are not awaited one after another', () => {
    expect(hook).not.toMatch(/for \(const language of languages\)[\s\S]{0,400}await fetch/)
    expect(hook).toMatch(/runBounded\(/)
  })
})
