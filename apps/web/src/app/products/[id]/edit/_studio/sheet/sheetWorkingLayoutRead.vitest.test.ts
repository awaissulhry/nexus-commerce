import { describe, expect, it, vi } from 'vitest'
import { isUserColumnPin, readSheetWorkingLayout } from './sheetWorkingLayoutRead'

const layout = { v: 3 as const, kind: 'columns' as const, columns: ['brand'], columnOrder: ['brand'], lockedColumns: [], groupOrder: [], groupOverrides: {} }
const stored = { id: 'layout-a', name: 'Current layout', updatedAt: '2026-09-30T10:00:00Z', filters: layout }

describe('modern and legacy sheet layouts', () => {
  it('uses an available modern record without consulting an irrelevant legacy failure', async () => {
    const read = vi.fn(async () => stored)
    expect(await readSheetWorkingLayout(read, 'current', 'legacy')).toEqual({ record: stored, layout, error: null })
    expect(read).toHaveBeenCalledExactlyOnceWith('current')
  })

  it('keeps a failed legacy read visible and does not claim a migrated modern record exists', async () => {
    const read = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Legacy layout unavailable'))
    expect(await readSheetWorkingLayout(read, 'current', 'legacy')).toEqual({ record: null, layout: null, error: 'Legacy layout unavailable' })
  })

  it('retries the unknown legacy record and recovers its layout without creating a modern record', async () => {
    const read = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Legacy layout unavailable'))
      .mockResolvedValueOnce(null).mockResolvedValueOnce(stored)
    await readSheetWorkingLayout(read, 'current', 'legacy')
    expect(await readSheetWorkingLayout(read, 'current', 'legacy')).toEqual({ record: null, layout, error: null })
    expect(read.mock.calls.map(([surface]) => surface)).toEqual(['current', 'legacy', 'current', 'legacy'])
  })

  it('never treats a failed current-layout read as an empty record', async () => {
    const read = vi.fn().mockRejectedValue(new Error('Current layout unavailable'))
    await expect(readSheetWorkingLayout(read, 'current', 'legacy')).rejects.toThrow('Current layout unavailable')
    expect(read).toHaveBeenCalledOnce()
  })
})

describe('column pin persistence', () => {
  it.each(['api', 'gridInitializing', 'gridOptionsChanged', 'viewportSizeFeature', 'flex', 'sizeColumnsToFit', undefined])('never persists automatic %s events', source => {
    expect(isUserColumnPin(source)).toBe(false)
  })
  it.each(['columnMenu', 'contextMenu', 'uiColumnDragged', 'toolPanelUi', 'toolPanelDragAndDrop'])('persists the explicit %s gesture', source => {
    expect(isUserColumnPin(source)).toBe(true)
  })
})
