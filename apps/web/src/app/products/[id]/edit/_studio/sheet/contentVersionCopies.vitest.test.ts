import { expect, it } from 'vitest'
import { CellSaveTracker, SheetWriter } from '@/design-system/grid'
import { buildMasterColumns } from '@/app/products/[id]/edit/_studio/sheet/master/columns'
import { commitMasterRow } from '@/app/products/[id]/edit/_studio/sheet/master/masterWrite'
import type { StudioRow, StudioSheet, SheetColumn } from '@/app/products/[id]/edit/_studio/sheet/master/types'
import { preserveContentVersions } from '@/app/products/[id]/edit/_studio/sheet/contentVersions'

const make = (version = 5, contentVersion = 4) => ({
  id: 'synthetic-final-review', sku: 'SYNTHETIC-REVIEW', isParent: false, parentId: null, version,
  values: {
    name: { value: 'old title', contentAddress: { tier: 'language', language: 'de' }, contentVersion, editable: true },
    brand: { value: 'old brand', contentAddress: null, editable: true },
  },
}) as unknown as StudioRow
const columns: SheetColumn[] = ['name', 'brand'].map(key => ({ key, label: key, writeField: key, group: 'Content', kind: 'text',
  storage: 'column', scope: 'global', requiredBy: [], editable: true, defaultVisible: true }))
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

it.each([[false, false], [true, false], [false, true], [true, true]])('fresh reload survives an intervening old read=%s and real value setter=%s', async (oldRead, clone) => {
  let visible = make(), owner = 7, content = 1
  const tracker = new CellSaveTracker(), sent: Array<{ field: string; owner: unknown; content: unknown }> = []
  const defs = buildMasterColumns({ columns, tracker, locale: 'de', market: 'DE' }, { current: [visible] })
  const title = defs.find(column => 'colId' in column && column.colId === 'name')
  if (!title || !('valueSetter' in title) || typeof title.valueSetter !== 'function') throw new Error('Title must have its real value setter')
  const setTitle = title.valueSetter
  const writer = new SheetWriter<StudioRow>({ tracker, mergeRow: preserveContentVersions, getApi: () => null,
    commit: req => commitMasterRow(req, { sheet: { columns } as unknown as StudioSheet, opts: {}, locale: 'de', market: 'DE',
      bulkSend: async body => {
        const change = (body.changes as Array<{ field: string; contentVersion?: number }>)[0]
        sent.push({ field: change.field, owner: body.expectedVersion, content: change.contentVersion })
        if (body.expectedVersion !== owner) return answer(409, { currentVersion: owner, versionOf: 'product', error: 'External product change' })
        if (change.contentVersion !== content) return answer(409, { error: 'Title changed. Reload before saving it.' })
        owner++; content++
        return answer(200, { updated: 1, currentVersion: owner, versionOf: 'product', contentVersions: [{ id: visible.id, tier: 'language', language: 'de', version: content }] })
      } }) })
  writer.seed([{ id: visible.id, version: visible.version, row: visible }])
  try {
    writer.set(visible.id, 'brand', 'stale brand', { row: visible }); await writer.flush()
    expect(writer.versionOf(visible.id)).toBe(7)
    if (oldRead) {
      visible = make()
      writer.seed([{ id: visible.id, version: visible.version, row: visible }])
      expect(visible.version).toBe(7)
      expect(visible.values.name.contentVersion).toBe(4)
    }
    const beforeCell = visible.values.name
    if (clone) { expect(setTitle({ data: visible, newValue: 'attempt before reload' } as never)).toBe(true); expect(visible.values.name).not.toBe(beforeCell) }
    writer.set(visible.id, 'name', 'attempt before reload', { row: visible }); await writer.flush()
    expect(tracker.get(visible.id, 'name')?.state).toBe('refused')
    writer.discard()
    visible = make(7, 1)
    writer.seed([{ id: visible.id, version: visible.version, row: visible }])
    const afterReload = visible.values.name.contentVersion
    writer.set(visible.id, 'name', 'after fresh reload', { row: visible }); await writer.flush()
    expect.soft(afterReload).toBe(1)
    expect.soft(sent.at(-1)).toEqual({ field: 'name', owner: 7, content: 1 })
    expect(tracker.get(visible.id, 'name')?.state).toBe('saved')
  } finally { writer.destroy() }
})
