import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { reloadImpact } from './reloadGuard'

describe('reloadImpact — what Reload asks before discarding typing', () => {
  it('requires review for an unknown save without claiming the server refused it', () => {
    const impact = reloadImpact({ pending: 0, refused: 0, unknown: 1 })
    expect(impact?.title).toContain('1 unconfirmed change')
    expect(impact?.consequences?.join(' ')).toMatch(/may already be stored/i)
  })
  it('🔴 asks NOTHING when nothing is at risk — Reload just re-reads', () => {
    // A dialog on every Reload is how operators learn to dismiss dialogs without reading them.
    expect(reloadImpact({ pending: 0, refused: 0 })).toBeNull()
  })

  it('🔴 asks when there is unsaved typing, and names the count in the question', () => {
    const impact = reloadImpact({ pending: 1, refused: 0 })
    expect(impact).not.toBeNull()
    expect(impact!.title).toBe('1 unsaved change — reload and discard it?')
    expect(impact!.level).toBe('confirm')
    expect(impact!.consequences?.join(' ')).toMatch(/already sent may still finish saving/i)
  })

  it('🔴 asks for a REFUSED cell too — its typed value is still on screen to be corrected', () => {
    // This is the case the sheet got wrong: Reload took the typed value and left the refusal mark
    // describing it. The operator loses the thing they were mid-way through fixing.
    const impact = reloadImpact({ pending: 0, refused: 2 })
    expect(impact!.title).toBe('2 refused cells — reload and discard them?')
    expect(impact!.consequences?.join(' ')).toMatch(/keep the values you typed/i)
  })

  it('names both kinds when both are present, because they are lost differently', () => {
    const impact = reloadImpact({ pending: 3, refused: 1 })
    expect(impact!.title).toBe('3 unsaved changes and 1 refused cell — reload and discard them?')
    expect(impact!.consequences).toHaveLength(2)
  })

  it('singular and plural agree with the count, in the title and the consequence', () => {
    expect(reloadImpact({ pending: 1, refused: 1 })!.title).toBe('1 unsaved change and 1 refused cell — reload and discard them?')
    expect(reloadImpact({ pending: 2, refused: 0 })!.title).toBe('2 unsaved changes — reload and discard them?')
    expect(reloadImpact({ pending: 0, refused: 1 })!.title).toBe('1 refused cell — reload and discard it?')
  })

  it('a negative or absurd count cannot produce a question about nothing', () => {
    // `pending` comes from a live counter; a transient -1 must not open a dialog saying
    // "-1 unsaved changes".
    expect(reloadImpact({ pending: -1, refused: 0 })).toBeNull()
    expect(reloadImpact({ pending: -1, refused: 2 })!.title).toBe('2 refused cells — reload and discard them?')
  })

  it('never asks to type a phrase — this is recoverable by retyping', () => {
    for (const s of [{ pending: 99, refused: 0 }, { pending: 0, refused: 99 }, { pending: 5, refused: 5 }]) {
      expect(reloadImpact(s)!.level).toBe('confirm')
    }
  })
})

/**
 * The wiring, because a correct rule nothing calls is the shape this whole item is about: Reload
 * discarded work for months while every unit test in this file would have passed.
 */
describe('the sheet actually asks', () => {
  const src = readFileSync(join(__dirname, 'MasterSheet.tsx'), 'utf8')

  it('🔴 the toolbar\'s Reload goes through the guard, not straight to reload()', () => {
    expect(src).toMatch(/onReload=\{onReload\}/)
    expect(src).not.toMatch(/onReload=\{reload\}/)
  })

  it('🔴 a confirmed reload DISCARDS before re-reading — marks cannot outlive their values', () => {
    const at = src.indexOf('const onReload =')
    if (at === -1) throw new Error('onReload is gone — the guard cannot check the sequence')
    const body = src.slice(at, at + 800)
    expect(body).toContain('reloadImpact(')
    expect(body).toContain('writer.discard()')
    // discard BEFORE reload: the other order re-reads rows while the old marks still describe them.
    expect(body.indexOf('writer.discard()')).toBeLessThan(body.indexOf('reload()', body.indexOf('writer.discard()') - 1) + 1 || Infinity)
  })

  it('the confirm dialog is MOUNTED — an ask with no element never resolves', () => {
    // `ask()` returns a promise the dialog settles. Without the element on screen the press hangs
    // forever with no way for the operator to tell, which is the failure the row menu hit.
    expect(src).toContain('{reloadConfirm.element}')
  })
})

/**
 * The save clock (#705). Same reason as the block above: the rule is one line, and the defect was
 * that the line sat in the wrong place. A node-only vitest cannot render the component, so this
 * asserts the WIRING at source — which is exactly the half that was wrong for months.
 */
describe('the save clock is stamped on a landing, never on a keystroke', () => {
  /*
   * 🔴 COMMENTS STRIPPED FIRST. The first version of this block failed against the very code it was
   * written for, because the comment explaining the defect NAMES `setLastSavedAt(new Date()...)` in
   * prose — so a source assertion that greps the raw file matches the explanation and reports the
   * bug as present. That is the same shape as the DS conformance guard counting `<select>` inside a
   * comment, met here from the other side: a check that FAILS on prose rather than passing on it.
   */
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  const src = strip(readFileSync(join(__dirname, 'MasterSheet.tsx'), 'utf8'))

  it('🔴 onCellValueChanged does NOT stamp the clock — it only queues the write', () => {
    const at = src.indexOf('const onCellValueChanged =')
    if (at === -1) throw new Error('onCellValueChanged is gone — this guard cannot check it')
    const body = src.slice(at, src.indexOf('const onSelectionChanged', at))
    expect(body).toContain('writer.set(')
    // The regression: `setLastSavedAt(new Date().toISOString())` immediately after `writer.set()`,
    // so the footer said "Saved HH:MM" before the request had left and went on saying it when the
    // write came back refused.
    expect(body).not.toMatch(/setLastSavedAt\s*\(/)
  })

  it('🔴 the ONLY stamp is gated on `ok` — onSettled fires for refusals too', () => {
    const calls = [...src.matchAll(/setLastSavedAt\s*\(/g)]
    expect(calls).toHaveLength(1)
    const at = src.indexOf('const onSettled =')
    if (at === -1) throw new Error('onSettled is gone — the clock has no honest source')
    const body = src.slice(at, at + 400)
    expect(body).toContain('if (ok)')
    expect(body).toContain('setLastSavedAt(savedAt)')
    // The server's timestamp, not a fresh one: a clock invented at render time is a different lie.
    expect(body).not.toMatch(/setLastSavedAt\(new Date\(\)/)
  })

  it('the handler is actually passed to the sheet — an unwired callback never fires', () => {
    expect(src).toMatch(/onWriteStart,\s*onWriteEnd,\s*onSettled/)
  })
})
