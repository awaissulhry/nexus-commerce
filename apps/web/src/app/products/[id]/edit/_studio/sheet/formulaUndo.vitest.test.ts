import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { FormulaWriteResult } from '../formulaWrites'
import { formulaHistoryValue, formulaWriteOutcome, sendFormulaEdit, type FormulaEditSender, type RecordSheetEdit } from './formulaUndo'
import { SheetUndoHistory } from './sheetUndo'

/**
 * G5 (2026-10-13) — formula edits are steps of ⌘Z. The formula branch of both sheets returned before the history heard
 * of it: ⌘Z skipped the formula and undid an older, unrelated step, and after a paste over formula cells ⌘Z left the
 * pasted values while the formulas were gone.
 */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

function sheet(formulas: Record<string, string> = {}, answer: FormulaWriteResult = { ok: true }) {
  const history = new SheetUndoHistory()
  const record: RecordSheetEdit = (change, source) => history.edit(change, false, source !== 'undo' && source !== 'redo')
  const sender: FormulaEditSender = {
    exprFor: (rowId, colId) => formulas[`${rowId}:${colId}`] ?? null,
    save: vi.fn(async () => answer),
    replace: vi.fn(async () => answer),
  }
  const replays: Array<Array<{ rowId: string; colId: string; value: unknown }>> = []
  const undo = () => { history.undo((values) => { replays.push(values) }); return replays.at(-1) }
  const redo = () => { history.redo((values) => { replays.push(values) }); return replays.at(-1) }
  return { history, record, sender, undo, redo }
}

describe('a formula edit in the sheet\'s ⌘Z', () => {
  it('G5: ⌘Z after a formula undoes the formula — not the older Cost edit before it', async () => {
    const { history, record, sender, undo } = sheet()
    history.edit({ rowId: 'p1', colId: 'costPrice', before: 15, after: 16 }, false)('saved')
    await turn()
    await sendFormulaEdit({ rowId: 'p1', colId: 'manufacturer', value: '=upper("acme")', before: 'Acme Ltd' }, sender, record)
    await turn()

    expect(sender.save).toHaveBeenCalledWith('p1', 'manufacturer', 'upper("acme")')
    expect(undo()).toEqual([{ rowId: 'p1', colId: 'manufacturer', value: 'Acme Ltd' }])
    expect(undo()).toEqual([{ rowId: 'p1', colId: 'costPrice', value: 15 }])
  })

  it('redo puts the formula back as a formula (its replay takes the formula road)', async () => {
    const { record, sender, undo, redo } = sheet()
    await sendFormulaEdit({ rowId: 'p1', colId: 'manufacturer', value: '=upper("acme")', before: 'Acme Ltd' }, sender, record)
    undo()
    expect(redo()).toEqual([{ rowId: 'p1', colId: 'manufacturer', value: formulaHistoryValue('upper("acme")') }])
  })

  it('a value pasted over a formula: ⌘Z restores the formula, not the pasted value', async () => {
    const { history, record, sender, undo } = sheet({ 'm:manufacturer': 'upper($brand)', 'l:manufacturer': 'lower($brand)' })
    history.begin()
    history.edit({ rowId: 'm', colId: 'brand', before: 'Old', after: 'Acme' }, false)('saved')
    const pasted = [
      sendFormulaEdit({ rowId: 'm', colId: 'manufacturer', value: 'Zeta', before: 'ACME OLD' }, sender, record),
      sendFormulaEdit({ rowId: 'l', colId: 'manufacturer', value: 'Zeta', before: 'acme old' }, sender, record),
    ]
    history.end()
    await Promise.all(pasted)

    expect(sender.replace).toHaveBeenCalledWith('m', 'manufacturer', 'Zeta')
    expect(undo()).toEqual([
      { rowId: 'm', colId: 'brand', value: 'Old' },
      { rowId: 'm', colId: 'manufacturer', value: '=upper($brand)' },
      { rowId: 'l', colId: 'manufacturer', value: '=lower($brand)' },
    ])
  })

  it('a formula typed over another formula: ⌘Z restores the previous formula', async () => {
    const { record, sender, undo } = sheet({ 'p1:manufacturer': 'upper($brand)' })
    await sendFormulaEdit({ rowId: 'p1', colId: 'manufacturer', value: '=lower($brand)', before: 'ACME' }, sender, record)
    expect(undo()).toEqual([{ rowId: 'p1', colId: 'manufacturer', value: '=upper($brand)' }])
  })

  it('a refused formula leaves the history: ⌘Z goes to the step before it', async () => {
    const { history, record, sender, undo } = sheet({}, { ok: false, error: 'Unknown field $athlete' })
    history.edit({ rowId: 'p1', colId: 'costPrice', before: 15, after: 16 }, false)('saved')
    await turn()
    const result = await sendFormulaEdit({ rowId: 'p1', colId: 'manufacturer', value: '=$athlete', before: 'Acme Ltd' }, sender, record)
    expect(formulaWriteOutcome(result)).toBe('refused')
    expect(undo()).toEqual([{ rowId: 'p1', colId: 'costPrice', value: 15 }])
  })

  it('review of #614: a formula STORED without a value (`=$typo`, kept with its error) stays a step — the server holds it', async () => {
    const { history, record, sender, undo } = sheet({}, { ok: false, error: 'Unknown field $athlete', stored: true })
    history.edit({ rowId: 'p1', colId: 'costPrice', before: 15, after: 16 }, false)('saved')
    await turn()
    const result = await sendFormulaEdit({ rowId: 'p1', colId: 'manufacturer', value: '=$athlete', before: 'Acme Ltd' }, sender, record)
    expect(result.ok).toBe(false)
    expect(formulaWriteOutcome(result)).toBe('saved')
    expect(undo()).toEqual([{ rowId: 'p1', colId: 'manufacturer', value: 'Acme Ltd' }])
  })

  it('a formula write the sheet discarded leaves the history too', async () => {
    const { history, record, sender } = sheet({}, { ok: false, dropped: true })
    await sendFormulaEdit({ rowId: 'p1', colId: 'manufacturer', value: '=upper("acme")', before: 'Acme Ltd' }, sender, record)
    expect(history.canUndo).toBe(false)
  })

  it('an undo\'s own write-back is no new step', async () => {
    const { history, record, sender } = sheet({ 'p1:manufacturer': 'upper("acme")' })
    await sendFormulaEdit({ rowId: 'p1', colId: 'manufacturer', value: 'Acme Ltd', before: 'ACME', source: 'undo' }, sender, record)
    expect(history.canUndo).toBe(false)
  })
})

/** Both sheets send their formula edits this way, and give the formula hook their write line (G4). */
describe.each([['master', 'master/useMasterSheetAdapter.tsx'], ['channel', 'channel/useChannelSheetAdapter.tsx']])('the %s sheet', (_scope, file) => {
  const src = readFileSync(join(__dirname, file), 'utf8')
  it('sends a typed formula and a value over a formula through sendFormulaEdit, with the sheet\'s history', () => {
    expect(src).toMatch(/void sendFormulaEdit\(\{ rowId: [^}]+, value: e\.newValue, before, source: e\.source \}, formulas, undo\.edit\)/)
    expect(src).not.toMatch(/formulas\.save\(|formulas\.replace\(/)
  })
  it('records the cell editor\'s own replace too', () => {
    expect(src).toMatch(/replaceFormula: \([^)]*\) => sendFormulaEdit\(/)
    expect(src).toContain('recordEditRef.current = undo.edit;')
  })
  it('removes a formula before an undo resets the cell to what it inherits', () => {
    expect(src).toMatch(/if \(sheetFormulas\.exprFor\(rowId, colId\)\) \{[\s\S]{0,120}sheetFormulas\.pinOver\(rowId, colId\)/)
  })
  it('gives the formula hook the sheet writer\'s line', () => {
    expect(src).toMatch(/writeLine: sheetFormulaLine\(\(\) => (writer|writerRef\.current)\)/)
  })
})
